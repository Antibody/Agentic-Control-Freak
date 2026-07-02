import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { resolveExecutable, type ExecutableResolution } from "@/lib/server/runtime/executable-resolver";
import { workspaceVenvDir } from "@/lib/server/runtime/python-venv-path";

let globalCache: ExecutableResolution | null = null;
const workspaceCache = new Map<string, ExecutableResolution>();

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function pythonWorkspaceCandidates(workspacePath: string): string[] {
  const managedVenv = workspaceVenvDir(workspacePath);
  return process.platform === "win32"
    ? [
        path.join(managedVenv, "Scripts", "python.exe"),
        path.join(workspacePath, ".venv", "Scripts", "python.exe"),
        path.join(workspacePath, "venv", "Scripts", "python.exe"),
      ]
    : [
        path.join(managedVenv, "bin", "python"),
        path.join(workspacePath, ".venv", "bin", "python"),
        path.join(workspacePath, "venv", "bin", "python"),
      ];
}

async function workspacePython(workspacePath: string): Promise<string | null> {
  for (const candidate of pythonWorkspaceCandidates(workspacePath)) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function pythonCandidateRank(candidate: string): number {
  const base = path.basename(candidate).toLowerCase();
  if (process.platform === "win32") {
    if (base === "python.exe") return 0;
    if (base === "py.exe") return 1;
    return 10;
  }
  if (base === "python3") return 0;
  if (base === "python") return 1;
  return 10;
}

export async function resolvePythonCommand(workspacePath?: string): Promise<ExecutableResolution> {
  if (workspacePath !== undefined) {
    const workspaceCandidate = await workspacePython(workspacePath);
    if (workspaceCandidate !== null) {
      const resolution = {
        command: workspaceCandidate,
        configured: null,
        source: "known-location" as const,
        candidates: [workspaceCandidate],
      };
      workspaceCache.set(workspacePath, resolution);
      return resolution;
    }

    const cached = workspaceCache.get(workspacePath);
    if (cached !== undefined) {
      return cached;
    }
  }

  if (globalCache === null) {
    globalCache = await resolveExecutable({
      envValue: process.env.PYTHON_BIN,
      names: process.platform === "win32" ? ["python", "py"] : ["python3", "python"],
      fallback: process.platform === "win32" ? "python" : "python3",
      prefer: pythonCandidateRank,
    });
  }

  if (workspacePath !== undefined) {
    workspaceCache.set(workspacePath, globalCache);
  }
  return globalCache;
}
