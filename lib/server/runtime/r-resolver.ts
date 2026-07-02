import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveExecutable, type ExecutableResolution } from "@/lib/server/runtime/executable-resolver";

let globalCache: ExecutableResolution | null = null;

function versionScore(name: string): number {
  const match = name.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (match === null) {
    return 0;
  }
  const major = Number(match[1] ?? "0");
  const minor = Number(match[2] ?? "0");
  const patch = Number(match[3] ?? "0");
  return major * 1_000_000 + minor * 1_000 + patch;
}

async function windowsRInstallBinDirs(): Promise<string[]> {
  const roots: string[] = [];
  const programFiles = process.env["ProgramFiles"]?.trim();
  const programFilesX86 = process.env["ProgramFiles(x86)"]?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (programFiles !== undefined && programFiles.length > 0) {
    roots.push(path.join(programFiles, "R"));
  }
  roots.push("C:\\Program Files\\R");
  if (programFilesX86 !== undefined && programFilesX86.length > 0) {
    roots.push(path.join(programFilesX86, "R"));
  }
  if (localAppData !== undefined && localAppData.length > 0) {
    roots.push(path.join(localAppData, "Programs", "R"));
  }

  const binDirs: { dir: string; score: number }[] = [];
  for (const root of Array.from(new Set(roots))) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const versionDir = path.join(root, entry);
      const score = versionScore(entry);
      binDirs.push({ dir: path.join(versionDir, "bin", "x64"), score });
      binDirs.push({ dir: path.join(versionDir, "bin"), score });
    }
  }
  return binDirs.sort((left, right) => right.score - left.score).map((item) => item.dir);
}

function unixRBinDirs(): string[] {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/Library/Frameworks/R.framework/Resources/bin",
    path.join(os.homedir(), ".local", "bin"),
  ];
}

async function rKnownDirs(): Promise<string[]> {
  return process.platform === "win32" ? await windowsRInstallBinDirs() : unixRBinDirs();
}

export async function resolveRscriptCommand(): Promise<ExecutableResolution> {
  if (globalCache === null) {
    const knownDirs = await rKnownDirs();
    globalCache = await resolveExecutable({
      envValue: process.env.RSCRIPT_BIN ?? process.env.R_BIN,
      names: ["Rscript"],
      knownDirs,
      fallback: "Rscript",
      prefer: (candidate) => -versionScore(candidate),
    });
  }
  return globalCache;
}

export function resetRResolverCache(): void {
  globalCache = null;
}
