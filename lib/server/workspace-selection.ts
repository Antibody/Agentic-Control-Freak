import { constants } from "node:fs";
import { access, mkdir, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { getConfig } from "@/lib/server/config";
import { createId, currentTimestamp, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { hasActiveProcessForWorkSession } from "@/lib/server/runtime/process-registry";
import { analyzeWorkspace } from "@/lib/server/workspace-analysis";
import { inspectWorkspaceSafety } from "@/lib/server/workspace-safety";
import type {
  Identifier,
  JsonObject,
  ProjectRecord,
  RuntimeProfileRecord,
  WorkspaceRiskLevel,
  WorkspaceSelectionMetadata,
  WorkspaceSelectionSource,
  WorkSessionRecord,
} from "@/lib/shared/types";

const execFileAsync = promisify(execFile);
const riskySystemNames = new Set(["windows", "program files", "program files (x86)", "programdata", "system volume information"]);

export interface WorkspaceCandidate {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isWritable: boolean;
  isEmpty: boolean;
  detectedStack: WorkspaceSelectionMetadata["detectedStack"];
  riskLevel: WorkspaceRiskLevel;
  riskReasons: string[];
  requiresConfirmation: boolean;
}

export interface FolderPickerResult {
  canceled: boolean;
  candidate: WorkspaceCandidate | null;
  error: string | null;
  fallbackRequired: boolean;
}

function riskLevelFromReasons(reasons: string[]): WorkspaceRiskLevel {
  if (reasons.length === 0) return "none";
  if (reasons.some((reason) => /drive root|filesystem root|system folder|control-plane/i.test(reason))) return "high";
  if (reasons.length >= 2) return "medium";
  return "low";
}

function normalizeWorkspacePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^"|"$/g, "");
  if (trimmed.length === 0) {
    throw new Error("Workspace path is empty.");
  }
  return path.resolve(trimmed);
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  try {
    return (await stat(candidatePath)).isDirectory();
  } catch {
    return false;
  }
}

async function canWriteToDirectory(candidatePath: string): Promise<boolean> {
  const probe = path.join(candidatePath, `.workspace-write-probe-${process.pid}-${Date.now()}`);
  try {
    await writeFile(probe, "ok", "utf8");
    await unlink(probe);
    return true;
  } catch {
    await unlink(probe).catch(() => undefined);
    return false;
  }
}

async function countLikelyProjects(candidatePath: string): Promise<number> {
  try {
    const entries = await readdir(candidatePath, { withFileTypes: true });
    let count = 0;
    for (const entry of entries.slice(0, 80)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = path.join(candidatePath, entry.name);
      if (
        await pathExists(path.join(child, "package.json")) ||
        await pathExists(path.join(child, "pyproject.toml")) ||
        await pathExists(path.join(child, "requirements.txt")) ||
        await pathExists(path.join(child, ".git"))
      ) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

function equivalentPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isInsidePath(candidate: string, possibleParent: string): boolean {
  const relative = path.relative(path.resolve(possibleParent), path.resolve(candidate));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolvedRealPath(candidatePath: string): Promise<string> {
  try {
    return await realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

function unixSystemRoots(): string[] {
  return [
    "/System",
    "/Library",
    "/Applications",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/var",
    "/opt",
    "/private",
    "/Volumes",
  ];
}

function isUnixSystemPath(candidatePath: string): boolean {
  if (process.platform === "win32") {
    return false;
  }
  const resolved = path.resolve(candidatePath);
  return unixSystemRoots().some((root) => {
    const normalizedRoot = path.resolve(root);
    return resolved === normalizedRoot || isInsidePath(resolved, normalizedRoot);
  });
}

async function riskReasonsFor(candidatePath: string, input: { isEmpty: boolean; detectedStack: string }): Promise<string[]> {
  const reasons: string[] = [];
  const resolved = path.resolve(candidatePath);
  const realResolved = await resolvedRealPath(resolved);
  const parsed = path.parse(resolved);
  const cwd = process.cwd();
  const home = os.homedir();
  const basename = path.basename(resolved).toLowerCase();

  if (equivalentPath(resolved, cwd)) {
    reasons.push("Selected folder is the control-plane app root.");
  } else if (isInsidePath(cwd, resolved)) {
    reasons.push("Selected folder is a parent of the control-plane app.");
  }
  if (equivalentPath(resolved, home)) {
    reasons.push("Selected folder is the user home directory.");
  }
  if (equivalentPath(resolved, parsed.root)) {
    reasons.push("Selected folder is a drive root.");
  }
  if (process.platform !== "win32" && equivalentPath(realResolved, path.parse(realResolved).root)) {
    reasons.push("Selected folder is the filesystem root.");
  }
  if (riskySystemNames.has(basename)) {
    reasons.push("Selected folder looks like a system folder.");
  }
  if (isUnixSystemPath(realResolved)) {
    reasons.push("Selected folder looks like a system folder.");
  }
  const safety = await inspectWorkspaceSafety(resolved, { source: "manual", operation: "workspace selection" });
  reasons.push(...safety.reasons.map((reason) => `Unsafe workspace: ${reason}`));
  if (!input.isEmpty && input.detectedStack === "unknown") {
    reasons.push("Selected folder is non-empty but no obvious app/project files were detected.");
  }
  if (await countLikelyProjects(resolved) >= 3) {
    reasons.push("Selected folder appears to contain several unrelated projects.");
  }
  return reasons;
}

export async function inspectWorkspaceCandidate(rawPath: string): Promise<WorkspaceCandidate> {
  const candidatePath = normalizeWorkspacePath(rawPath);
  const exists = await pathExists(candidatePath);
  const directory = exists ? await isDirectory(candidatePath) : false;
  if (!exists) {
    return {
      path: candidatePath,
      exists,
      isDirectory: false,
      isWritable: false,
      isEmpty: true,
      detectedStack: "unknown",
      riskLevel: "low",
      riskReasons: ["Selected folder does not exist yet."],
      requiresConfirmation: true,
    };
  }
  if (!directory) {
    return {
      path: candidatePath,
      exists,
      isDirectory: false,
      isWritable: false,
      isEmpty: false,
      detectedStack: "unknown",
      riskLevel: "high",
      riskReasons: ["Selected path is not a folder."],
      requiresConfirmation: true,
    };
  }

  const config = getConfig();
  const analysis = await analyzeWorkspace(candidatePath, config.verifyCommands);
  const isWritable = await canWriteToDirectory(candidatePath);
  const riskReasons = await riskReasonsFor(candidatePath, { isEmpty: analysis.isEmpty, detectedStack: analysis.stack });
  if (!isWritable) {
    riskReasons.push("Selected folder is not writable by the control-plane process.");
  }
  const riskLevel = riskLevelFromReasons(riskReasons);
  return {
    path: candidatePath,
    exists,
    isDirectory: true,
    isWritable,
    isEmpty: analysis.isEmpty,
    detectedStack: analysis.stack,
    riskLevel,
    riskReasons,
    requiresConfirmation: riskLevel !== "none",
  };
}

async function openFolderWithWindowsPicker(): Promise<string | null> {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select workspace folder'
$dialog.CheckFileExists = $false
$dialog.CheckPathExists = $true
$dialog.ValidateNames = $false
$dialog.DereferenceLinks = $true
$dialog.Multiselect = $false
$dialog.FileName = 'Select this folder'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write([System.IO.Path]::GetDirectoryName($dialog.FileName))
}
`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { timeout: 120000 });
  const selected = stdout.trim();
  return selected.length > 0 ? selected : null;
}

async function openFolderWithMacPicker(): Promise<string | null> {
  const script = 'POSIX path of (choose folder with prompt "Select workspace folder")';
  const { stdout } = await execFileAsync("osascript", ["-e", script], { timeout: 120000 });
  const selected = stdout.trim();
  return selected.length > 0 ? selected : null;
}

async function commandAvailable(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(checker, [command], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function openFolderWithLinuxPicker(): Promise<string | null> {
  if (await commandAvailable("zenity")) {
    const { stdout } = await execFileAsync("zenity", ["--file-selection", "--directory", "--title=Select workspace folder"], { timeout: 120000 });
    return stdout.trim() || null;
  }
  if (await commandAvailable("kdialog")) {
    const { stdout } = await execFileAsync("kdialog", ["--getexistingdirectory", os.homedir()], { timeout: 120000 });
    return stdout.trim() || null;
  }
  throw new Error("No native folder picker is available. Install zenity/kdialog or enter a path manually.");
}

export async function openNativeWorkspaceFolder(): Promise<FolderPickerResult> {
  try {
    const selected = process.platform === "win32"
      ? await openFolderWithWindowsPicker()
      : process.platform === "darwin"
        ? await openFolderWithMacPicker()
        : await openFolderWithLinuxPicker();
    if (selected === null) {
      return { canceled: true, candidate: null, error: null, fallbackRequired: false };
    }
    return { canceled: false, candidate: await inspectWorkspaceCandidate(selected), error: null, fallbackRequired: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Native folder picker failed.";
    return { canceled: false, candidate: null, error: message, fallbackRequired: true };
  }
}

export function metadataFromCandidate(candidate: WorkspaceCandidate, source: WorkspaceSelectionSource): WorkspaceSelectionMetadata {
  return {
    source,
    selectedAt: currentTimestamp(),
    selectedPath: candidate.path,
    riskLevel: candidate.riskLevel,
    riskReasons: candidate.riskReasons,
    detectedStack: candidate.detectedStack,
    isEmpty: candidate.isEmpty,
  };
}

function updateRuntimeProfileWritableRoots(profile: RuntimeProfileRecord, project: ProjectRecord): void {
  const config = getConfig();
  profile.writableRoots = Array.from(new Set([config.workspaceRoot, project.localRepoPath]));
}

export async function selectWorkspaceFolder(input: {
  workSessionId: Identifier;
  path: string;
  confirmedRisk?: boolean;
}): Promise<{ candidate: WorkspaceCandidate; project: ProjectRecord; workSession: WorkSessionRecord }> {
  if (hasActiveProcessForWorkSession(input.workSessionId)) {
    throw new Error("Cannot change workspace while an agent process is running for this session.");
  }
  const candidate = await inspectWorkspaceCandidate(input.path);
  if (candidate.exists && !candidate.isDirectory) {
    throw new Error("Selected path is not a folder.");
  }
  if (!candidate.exists) {
    await mkdir(candidate.path, { recursive: true });
  }
  const writableCandidate = await inspectWorkspaceCandidate(candidate.path);
  if (!writableCandidate.isWritable) {
    throw new Error("Selected folder is not writable by the control-plane process.");
  }
  const safety = await inspectWorkspaceSafety(writableCandidate.path, { source: "manual", operation: "workspace selection" });
  if (!safety.safe) {
    throw new Error(`Selected workspace is unsafe and cannot be used: ${safety.reasons.join(" ")}`);
  }
  if (writableCandidate.requiresConfirmation && input.confirmedRisk !== true) {
    const error = new Error("Workspace selection requires confirmation.");
    (error as Error & { candidate?: WorkspaceCandidate }).candidate = writableCandidate;
    throw error;
  }

  const updated = await mutateDatabase((db) => {
    const workSession = db.workSessions.find((session) => session.id === input.workSessionId);
    if (workSession === undefined) {
      throw new Error(`Unknown work session: ${input.workSessionId}`);
    }
    const project = db.projects.find((candidateProject) => candidateProject.id === workSession.projectId);
    if (project === undefined) {
      throw new Error(`Unknown project for work session: ${input.workSessionId}`);
    }
    const runtimeProfile = db.runtimeProfiles.find((profile) => profile.id === workSession.runtimeProfileId);
    if (runtimeProfile === undefined) {
      throw new Error(`Unknown runtime profile for work session: ${input.workSessionId}`);
    }
    const previousPath = project.localRepoPath;
    project.localRepoPath = writableCandidate.path;
    project.repoUrl = `local://${writableCandidate.path}`;
    project.workspaceSelection = metadataFromCandidate(writableCandidate, "manual");
    workSession.activeWorktreePath = writableCandidate.path;
    workSession.activePlanId = null;
    updateWorkSessionTimestamp(workSession);
    updateRuntimeProfileWritableRoots(runtimeProfile, project);
    return {
      project: { ...project },
      workSession: { ...workSession },
      previousPath,
    };
  });

  await emitEvent({
    workSessionId: updated.workSession.id,
    eventName: "workspace.selected",
    aggregateType: "work_session",
    aggregateId: updated.workSession.id,
    payload: {
      previousPath: updated.previousPath,
      selectedPath: writableCandidate.path,
      source: "manual",
      exists: writableCandidate.exists,
      isEmpty: writableCandidate.isEmpty,
      detectedStack: writableCandidate.detectedStack,
      riskLevel: writableCandidate.riskLevel,
      riskReasons: writableCandidate.riskReasons.join("; "),
      confirmedRisk: String(input.confirmedRisk === true),
    },
  });

  return { candidate: writableCandidate, project: updated.project, workSession: updated.workSession };
}

export async function resetWorkspaceToGenerated(workSessionId: Identifier): Promise<{ candidate: WorkspaceCandidate; project: ProjectRecord; workSession: WorkSessionRecord }> {
  if (hasActiveProcessForWorkSession(workSessionId)) {
    throw new Error("Cannot change workspace while an agent process is running for this session.");
  }
  const config = getConfig();
  const generatedPath = path.join(config.workspaceRoot, `project-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${createId().slice(0, 8)}`);
  await mkdir(generatedPath, { recursive: true });
  const candidate = await inspectWorkspaceCandidate(generatedPath);
  const updated = await mutateDatabase((db) => {
    const workSession = db.workSessions.find((session) => session.id === workSessionId);
    if (workSession === undefined) {
      throw new Error(`Unknown work session: ${workSessionId}`);
    }
    const project = db.projects.find((candidateProject) => candidateProject.id === workSession.projectId);
    if (project === undefined) {
      throw new Error(`Unknown project for work session: ${workSessionId}`);
    }
    const runtimeProfile = db.runtimeProfiles.find((profile) => profile.id === workSession.runtimeProfileId);
    if (runtimeProfile === undefined) {
      throw new Error(`Unknown runtime profile for work session: ${workSessionId}`);
    }
    const previousPath = project.localRepoPath;
    project.localRepoPath = generatedPath;
    project.repoUrl = `local://${project.slug}`;
    project.workspaceSelection = metadataFromCandidate(candidate, "generated");
    workSession.activeWorktreePath = generatedPath;
    workSession.activePlanId = null;
    updateWorkSessionTimestamp(workSession);
    updateRuntimeProfileWritableRoots(runtimeProfile, project);
    return {
      project: { ...project },
      workSession: { ...workSession },
      previousPath,
    };
  });

  await emitEvent({
    workSessionId,
    eventName: "workspace.reset_to_generated",
    aggregateType: "work_session",
    aggregateId: workSessionId,
    payload: {
      previousPath: updated.previousPath,
      selectedPath: generatedPath,
      source: "generated",
      isEmpty: candidate.isEmpty,
      detectedStack: candidate.detectedStack,
    } satisfies JsonObject,
  });
  return { candidate, project: updated.project, workSession: updated.workSession };
}
