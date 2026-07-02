import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { resolveExecutable, type ExecutableResolution } from "@/lib/server/runtime/executable-resolver";

const execFileAsync = promisify(execFile);
let globalCache: ExecutableResolution | null = null;
let targetFrameworkCache: string | null = null;

function windowsDotnetDirs(): string[] {
  if (process.platform !== "win32") {
    return [];
  }
  const programFiles = process.env.ProgramFiles?.trim();
  const programFilesX86 = process.env["ProgramFiles(x86)"]?.trim();
  return [
    programFiles === undefined || programFiles.length === 0 ? "C:\\Program Files" : programFiles,
    programFilesX86,
  ]
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => path.join(entry, "dotnet"));
}

export async function resolveDotnetCommand(): Promise<ExecutableResolution> {
  if (globalCache === null) {
    globalCache = await resolveExecutable({
      envValue: process.env.DOTNET_BIN,
      names: ["dotnet"],
      knownDirs: windowsDotnetDirs(),
      fallback: "dotnet",
    });
  }
  return globalCache;
}

function targetFrameworkFromSdkVersion(version: string): string | null {
  const major = Number.parseInt(version.trim().split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 5) {
    return null;
  }
  return `net${major}.0`;
}

export async function resolveDotnetTargetFramework(): Promise<string> {
  if (targetFrameworkCache !== null) {
    return targetFrameworkCache;
  }
  try {
    const dotnet = await resolveDotnetCommand();
    const result = await execFileAsync(dotnet.command, ["--version"], { timeout: 7000 });
    targetFrameworkCache = targetFrameworkFromSdkVersion(`${result.stdout}\n${result.stderr}`) ?? "net8.0";
  } catch {
    targetFrameworkCache = "net8.0";
  }
  return targetFrameworkCache;
}
