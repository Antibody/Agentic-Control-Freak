import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import type { WorkspaceSelectionSource } from "@/lib/shared/types";

export interface WorkspaceSafetyReport {
  workspacePath: string;
  safe: boolean;
  reasons: string[];
}

export interface WorkspaceSafetyInput {
  source?: WorkspaceSelectionSource;
  operation?: string;
}

const controlPlaneMarkerFiles = [
  ".data/closed-dev-loop.json",
  "lib/server/workflow-controller.ts",
  "components/ChatApp.tsx",
];

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizeForCompare(left) === normalizeForCompare(right);
}

function isInsidePath(candidate: string, possibleParent: string): boolean {
  const relative = path.relative(path.resolve(possibleParent), path.resolve(candidate));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveRealPath(candidatePath: string): Promise<string> {
  try {
    return await realpath(candidatePath);
  } catch {
    return path.resolve(candidatePath);
  }
}

async function fileExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function packageLooksLikeControlPlane(workspacePath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as Record<string, unknown>;
    return parsed.name === "closed-dev-loop-real-app";
  } catch {
    return false;
  }
}

export async function inspectWorkspaceSafety(workspacePath: string, input: WorkspaceSafetyInput = {}): Promise<WorkspaceSafetyReport> {
  const resolved = path.resolve(workspacePath);
  const realResolved = await resolveRealPath(resolved);
  const appRoot = process.cwd();
  const realAppRoot = await resolveRealPath(appRoot);
  const config = getConfig();
  const reasons: string[] = [];

  if (samePath(resolved, appRoot) || samePath(realResolved, realAppRoot)) {
    reasons.push("Workspace path is the control-plane app root.");
  }
  if (!samePath(resolved, appRoot) && isInsidePath(appRoot, resolved)) {
    reasons.push("Workspace path is a parent of the control-plane app root.");
  }
  if (!samePath(realResolved, realAppRoot) && isInsidePath(realAppRoot, realResolved)) {
    reasons.push("Workspace real path is a parent of the control-plane app root.");
  }
  if (input.source === "generated" && !isInsidePath(resolved, config.workspaceRoot)) {
    reasons.push("Generated workspace path is outside WORKSPACE_ROOT.");
  }

  for (const marker of controlPlaneMarkerFiles) {
    if (await fileExists(path.join(resolved, marker))) {
      reasons.push(`Workspace contains control-plane marker ${marker}.`);
    }
  }
  if (await packageLooksLikeControlPlane(resolved)) {
    reasons.push("Workspace package.json identifies the control-plane app.");
  }

  return {
    workspacePath: resolved,
    safe: reasons.length === 0,
    reasons,
  };
}

export class WorkspaceSafetyError extends Error {
  constructor(public readonly report: WorkspaceSafetyReport, operation: string) {
    super(`Unsafe workspace for ${operation}: ${report.workspacePath}. ${report.reasons.join(" ")}`);
    this.name = "WorkspaceSafetyError";
  }
}

export async function assertSafeWorkspace(workspacePath: string, input: WorkspaceSafetyInput = {}): Promise<void> {
  const report = await inspectWorkspaceSafety(workspacePath, input);
  if (!report.safe) {
    throw new WorkspaceSafetyError(report, input.operation ?? "workspace operation");
  }
}

export function isWorkspaceSafetyError(error: unknown): error is WorkspaceSafetyError {
  return error instanceof WorkspaceSafetyError;
}
