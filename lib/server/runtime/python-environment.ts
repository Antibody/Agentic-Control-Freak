import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolvePythonCommand } from "@/lib/server/runtime/python-resolver";
import { workspaceVenvDir } from "@/lib/server/runtime/python-venv-path";
import { runProcess, type ProcessEnvironment, type ProcessProgressHandlers, type ProcessResult } from "@/lib/server/runtime/process-runner";

export interface PythonWorkspaceEnvironment {
  command: string;
  setupCommand: string | null;
  setupResult: ProcessResult | null;
}

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function pythonVirtualEnvCommand(workspacePath: string): string {
  const venvDir = workspaceVenvDir(workspacePath);
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

function pythonVirtualEnvBinDir(workspacePath: string): string {
  const venvDir = workspaceVenvDir(workspacePath);
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts")
    : path.join(venvDir, "bin");
}

export function pythonWorkspaceEnv(workspacePath: string, overrides: ProcessEnvironment = {}): ProcessEnvironment {
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const existingPath = process.env[pathKey] ?? process.env.PATH ?? "";
  return createSanitizedProcessEnv({
    VIRTUAL_ENV: workspaceVenvDir(workspacePath),
    [pathKey]: `${pythonVirtualEnvBinDir(workspacePath)}${path.delimiter}${existingPath}`,
    ...overrides,
  });
}

export async function ensurePythonWorkspaceEnvironment(input: {
  workspacePath: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: ProcessEnvironment;
  progress?: ProcessProgressHandlers;
}): Promise<PythonWorkspaceEnvironment> {
  const command = pythonVirtualEnvCommand(input.workspacePath);
  if (await fileExists(command)) {
    return { command, setupCommand: null, setupResult: null };
  }

  const venvDir = workspaceVenvDir(input.workspacePath);
  await mkdir(path.dirname(venvDir), { recursive: true }).catch(() => undefined);
  const basePython = await resolvePythonCommand();
  const setupCommand = `python -m venv ${venvDir}`;
  const setupResult = await runProcess({
    command: basePython.command,
    args: ["-m", "venv", venvDir],
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    env: input.env ?? createSanitizedProcessEnv({ CI: "true" }),
    signal: input.signal,
    progress: input.progress,
  });

  return { command, setupCommand, setupResult };
}
