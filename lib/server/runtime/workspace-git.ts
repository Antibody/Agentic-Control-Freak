import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { resolveGitBin } from "@/lib/server/runtime/git-resolver";
import { runProcess, type ProcessResult } from "@/lib/server/runtime/process-runner";
import { IGNORED_WORKSPACE_DIRS, hasIgnoredModelExtension } from "@/lib/server/runtime/workspace-ignore";

const ignoredDirectoryNames = IGNORED_WORKSPACE_DIRS;

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/");
}

function safeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "session";
}

function shouldIgnore(relativePath: string, name: string, isDirectory: boolean): boolean {
  if (isDirectory && ignoredDirectoryNames.has(name)) {
    return true;
  }
  if (!isDirectory && hasIgnoredModelExtension(name)) {
    return true;
  }
  const normalized = normalizePath(relativePath);
  if (
    normalized === ".data/checkpoints" ||
    normalized.startsWith(".data/checkpoints/") ||
    normalized === ".data/artifacts" ||
    normalized.startsWith(".data/artifacts/") ||
    normalized === ".data/closed-dev-loop.json" ||
    normalized === ".workspace" ||
    normalized.startsWith(".workspace/")
  ) {
    return true;
  }
  return normalized.includes("/.orchestrator/")
    || normalized.includes("/.gemini/")
    || normalized.includes("/.antigravity/")
    || normalized.includes("/.antigravitycli/")
    || normalized.includes("/.agy/")
    || normalized.includes("/node_modules/")
    || normalized.includes("/.next/");
}

async function collectFiles(root: string, current = "", depth = 0): Promise<string[]> {
  if (depth > 30) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(path.join(root, current), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (shouldIgnore(relativePath, entry.name, entry.isDirectory())) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, relativePath, depth + 1));
      continue;
    }
    if (entry.isFile()) {
      files.push(normalizePath(relativePath));
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export interface SessionGitRepo {
  gitDir: string;
  workTree: string;
}

export interface CreatedGitCheckpoint {
  commitHash: string;
  refName: string;
  filesChanged: number;
  reusedHead: boolean;
}

export interface SurgicalRevertGitResult {
  patch: string;
  filesChanged: number;
  stdout: string;
  stderr: string;
}

export interface GitChangedFile {
  filePath: string;
  previousPath: string | null;
  changeKind: "create" | "update" | "delete" | "rename";
}

export function checkpointRefName(checkpointId: string): string {
  return `refs/orchestrator/checkpoints/${safeSegment(checkpointId)}`;
}

export function sessionGitDir(workSessionId: string): string {
  const config = getConfig();
  return path.join(path.dirname(config.dbFile), "checkpoints", safeSegment(workSessionId), "git");
}

async function git(repo: SessionGitRepo, args: string[], timeoutMs = 60000, stdin?: string): Promise<ProcessResult> {
  const command = await resolveGitBin();
  return runProcess({
    command,
    args: [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.workTree}`, ...args],
    cwd: repo.workTree,
    timeoutMs,
    stdin,
  });
}

const LOCK_CONTENTION = /index\.lock|Unable to create '[^']*\.lock'|another git process/i;

/** Remove a stale index.lock. Safe under withRepoLock: we hold the in-process queue for this git-dir, so any
 *  lock present is a leftover from a crashed/killed/earlier git process, not a live one. */
async function clearStaleIndexLock(gitDir: string): Promise<void> {
  await unlink(path.join(gitDir, "index.lock")).catch(() => undefined);
}

async function gitOk(repo: SessionGitRepo, args: string[], timeoutMs = 60000, stdin?: string): Promise<ProcessResult> {
  let result = await git(repo, args, timeoutMs, stdin);
  if (result.exitCode !== 0 && LOCK_CONTENTION.test(result.stderr || result.stdout)) {
    await clearStaleIndexLock(repo.gitDir);
    result = await git(repo, args, timeoutMs, stdin);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Git checkpoint command failed: git ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result;
}

const repoQueues = new Map<string, Promise<unknown>>();

function withRepoLock<T>(gitDir: string, fn: () => Promise<T>): Promise<T> {
  const prior = repoQueues.get(gitDir) ?? Promise.resolve();
  const result = prior
    .catch(() => undefined) // a prior op's failure must not break the chain
    .then(async () => {
      await clearStaleIndexLock(gitDir);
      return fn();
    });
  const tail = result.catch(() => undefined); // the queue tracks completion, never rejects
  repoQueues.set(gitDir, tail);
  void tail.then(() => {
    if (repoQueues.get(gitDir) === tail) {
      repoQueues.delete(gitDir); // bound the map: drop drained queues
    }
  });
  return result;
}

async function hasHead(repo: SessionGitRepo): Promise<boolean> {
  const result = await git(repo, ["rev-parse", "--verify", "HEAD"], 20000);
  return result.exitCode === 0;
}

export async function ensureSessionRepo(input: { workSessionId: string; workTree: string }): Promise<SessionGitRepo> {
  const gitDir = sessionGitDir(input.workSessionId);
  await mkdir(input.workTree, { recursive: true });
  await mkdir(path.dirname(gitDir), { recursive: true });
  try {
    await stat(path.join(gitDir, "HEAD"));
  } catch {
    const command = await resolveGitBin();
    const init = await runProcess({
      command,
      args: ["init", "--bare", gitDir],
      cwd: input.workTree,
      timeoutMs: 30000,
    });
    if (init.exitCode !== 0) {
      throw new Error(`Unable to initialize checkpoint repository: ${init.stderr || init.stdout}`);
    }
  }
  const repo = { gitDir, workTree: input.workTree };
  await gitOk(repo, ["config", "user.email", "orchestrator@example.invalid"], 10000);
  await gitOk(repo, ["config", "user.name", "Closed Loop Orchestrator"], 10000);
  await gitOk(repo, ["config", "commit.gpgsign", "false"], 10000);
  await gitOk(repo, ["config", "core.autocrlf", "false"], 10000);
  await gitOk(repo, ["config", "core.safecrlf", "false"], 10000);
  await gitOk(repo, ["config", "core.longpaths", "true"], 10000);
  await mkdir(path.join(gitDir, "info"), { recursive: true });
  await writeFile(
    path.join(gitDir, "info", "exclude"),
    ".git/\n.agy/\n.antigravity/\n.antigravitycli/\n.gemini/\n.next/\n.orchestrator/\n.turbo/\ncoverage/\ndist/\nbuild/\nnode_modules/\nout/\n__pycache__/\n.venv/\nvenv/\nmlruns/\n.ml-cache/\n*.safetensors\n*.pt\n*.pth\n*.gguf\n*.onnx\n*.joblib\n*.pkl\n.data/checkpoints/\n.data/artifacts/\n.data/closed-dev-loop.json\n.workspace/\n",
    "utf8"
  );
  return repo;
}

export function createGitCheckpoint(input: {
  workSessionId: string;
  workTree: string;
  checkpointId: string;
  message: string;
}): Promise<CreatedGitCheckpoint> {
  return withRepoLock(sessionGitDir(input.workSessionId), () => createGitCheckpointUnlocked(input));
}

async function createGitCheckpointUnlocked(input: {
  workSessionId: string;
  workTree: string;
  checkpointId: string;
  message: string;
}): Promise<CreatedGitCheckpoint> {
  const repo = await ensureSessionRepo({ workSessionId: input.workSessionId, workTree: input.workTree });
  const headExists = await hasHead(repo);
  await gitOk(repo, ["add", "-u"], 60000);
  const ignoredPathspecs = [".venv", "venv", "mlruns", ".ml-cache"].flatMap((dir) => [
    `:(glob)${dir}/**`,
    `:(glob)**/${dir}/**`,
  ]);
  await git(repo, ["rm", "--cached", "-r", "--ignore-unmatch", ...ignoredPathspecs], 60000).catch(() => undefined);
  for (let attempt = 1; ; attempt += 1) {
    const files = await collectFiles(input.workTree);
    if (files.length === 0) {
      break;
    }
    const addResult = await git(repo, ["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], 120000, `${files.join("\0")}\0`);
    if (addResult.exitCode === 0) {
      break;
    }
    const output = addResult.stderr || addResult.stdout;
    if (LOCK_CONTENTION.test(output) && attempt < 3) {
      await clearStaleIndexLock(repo.gitDir);
      await new Promise((resolve) => setTimeout(resolve, 150));
      continue;
    }
    const vanishedPathspec = /did not match any files/i.test(output);
    if (!vanishedPathspec || attempt >= 3) {
      throw new Error(`Git checkpoint command failed: git add -f --pathspec-from-file=- --pathspec-file-nul\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const diff = await git(repo, ["diff", "--cached", "--numstat"], 60000);
  const filesChanged = diff.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  const hasStagedChanges = filesChanged > 0;
  let commitHash = "";
  let reusedHead = false;
  if (hasStagedChanges || !headExists) {
    const args = !headExists && !hasStagedChanges
      ? ["commit", "--allow-empty", "-m", input.message]
      : ["commit", "-m", input.message];
    await gitOk(repo, args, 120000);
    commitHash = (await gitOk(repo, ["rev-parse", "HEAD"], 20000)).stdout.trim();
  } else {
    commitHash = (await gitOk(repo, ["rev-parse", "HEAD"], 20000)).stdout.trim();
    reusedHead = true;
  }
  const refName = checkpointRefName(input.checkpointId);
  await gitOk(repo, ["update-ref", refName, commitHash], 20000);
  return { commitHash, refName, filesChanged, reusedHead };
}

export function restoreGitCheckpoint(input: { workSessionId: string; workTree: string; commitHash: string }): Promise<void> {
  return withRepoLock(sessionGitDir(input.workSessionId), async () => {
    const repo = await ensureSessionRepo({ workSessionId: input.workSessionId, workTree: input.workTree });
    await gitOk(repo, ["reset", "--hard", input.commitHash], 120000);
  });
}

export function materializeGitCheckpoint(input: {
  workSessionId: string;
  sourceWorkTree: string;
  targetWorkTree: string;
  commitHash: string;
}): Promise<void> {
  return withRepoLock(sessionGitDir(input.workSessionId), async () => {
    const sourceRepo = await ensureSessionRepo({ workSessionId: input.workSessionId, workTree: input.sourceWorkTree });
    await mkdir(input.targetWorkTree, { recursive: true });
    const targetRepo = { gitDir: sourceRepo.gitDir, workTree: input.targetWorkTree };
    await gitOk(targetRepo, ["checkout", "-f", input.commitHash, "--", "."], 120000);
  });
}

export function surgicallyRevertGitCheckpointDelta(input: {
  workSessionId: string;
  workTree: string;
  baseCommitHash: string;
  targetCommitHash: string;
}): Promise<SurgicalRevertGitResult> {
  return withRepoLock(sessionGitDir(input.workSessionId), () => surgicallyRevertGitCheckpointDeltaUnlocked(input));
}

async function surgicallyRevertGitCheckpointDeltaUnlocked(input: {
  workSessionId: string;
  workTree: string;
  baseCommitHash: string;
  targetCommitHash: string;
}): Promise<SurgicalRevertGitResult> {
  const repo = await ensureSessionRepo({ workSessionId: input.workSessionId, workTree: input.workTree });
  const numstat = await gitOk(repo, ["diff", "--numstat", input.baseCommitHash, input.targetCommitHash], 60000);
  const filesChanged = numstat.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  if (filesChanged === 0) {
    throw new Error("The selected checkpoint did not introduce any file changes to revert.");
  }
  const patch = (await gitOk(repo, ["diff", "--binary", input.baseCommitHash, input.targetCommitHash], 120000)).stdout;
  if (patch.trim().length === 0) {
    throw new Error("The selected checkpoint produced an empty patch.");
  }
  const apply = await git(repo, ["apply", "-R", "--3way", "--whitespace=nowarn", "-"], 120000, patch);
  if (apply.exitCode !== 0) {
    throw new Error(`Surgical revert could not be applied cleanly. Later changes may overlap with this checkpoint.\n${apply.stderr || apply.stdout}`);
  }
  return { patch, filesChanged, stdout: apply.stdout, stderr: apply.stderr };
}

export function updateGitCheckpointRef(input: { workSessionId: string; workTree: string; checkpointId: string; commitHash: string }): Promise<string> {
  return withRepoLock(sessionGitDir(input.workSessionId), async () => {
    const repo = await ensureSessionRepo({ workSessionId: input.workSessionId, workTree: input.workTree });
    const refName = checkpointRefName(input.checkpointId);
    await gitOk(repo, ["update-ref", refName, input.commitHash], 20000);
    return refName;
  });
}

function changeKindFromGitStatus(status: string): GitChangedFile["changeKind"] {
  if (status.startsWith("A")) return "create";
  if (status.startsWith("D")) return "delete";
  if (status.startsWith("R")) return "rename";
  return "update";
}

function parseNameStatus(output: string): GitChangedFile[] {
  const parts = output.split("\0").filter((part) => part.length > 0);
  const files: GitChangedFile[] = [];
  for (let index = 0; index < parts.length;) {
    const status = parts[index] ?? "";
    index += 1;
    if (status.startsWith("R")) {
      const previousPath = parts[index] ?? "";
      const filePath = parts[index + 1] ?? previousPath;
      index += 2;
      files.push({
        filePath: normalizePath(filePath),
        previousPath: normalizePath(previousPath),
        changeKind: "rename",
      });
      continue;
    }
    const filePath = parts[index] ?? "";
    index += 1;
    files.push({
      filePath: normalizePath(filePath),
      previousPath: null,
      changeKind: changeKindFromGitStatus(status),
    });
  }
  return files.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

export async function listGitChangedFiles(input: {
  workSessionId: string;
  workTree: string;
  baseCommitHash: string;
  targetCommitHash: string;
}): Promise<GitChangedFile[]> {
  const repo = await ensureSessionRepo({ workSessionId: input.workSessionId, workTree: input.workTree });
  const result = await gitOk(repo, ["diff", "--name-status", "-z", input.baseCommitHash, input.targetCommitHash], 60000);
  return parseNameStatus(result.stdout);
}

export async function gitFileDiff(input: {
  workSessionId: string;
  workTree: string;
  baseCommitHash: string;
  targetCommitHash: string;
  filePath: string;
}): Promise<string> {
  const repo = await ensureSessionRepo({ workSessionId: input.workSessionId, workTree: input.workTree });
  const result = await gitOk(
    repo,
    ["diff", "--binary", "--no-ext-diff", input.baseCommitHash, input.targetCommitHash, "--", normalizePath(input.filePath)],
    60000
  );
  return result.stdout;
}
