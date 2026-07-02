import path from "node:path";
import { resolveExecutable, type ExecutableResolution } from "@/lib/server/runtime/executable-resolver";

let phpCache: ExecutableResolution | null = null;
let composerCache: ExecutableResolution | null = null;

function phpCandidateRank(candidate: string): number {
  const base = path.basename(candidate).toLowerCase();
  if (process.platform === "win32") {
    if (base === "php.exe") return 0;
    if (base === "php.cmd") return 1;
    if (base === "php.bat") return 2;
    if (base === "php") return 3;
  }
  return base === "php" ? 0 : 10;
}

function composerCandidateRank(candidate: string): number {
  const base = path.basename(candidate).toLowerCase();
  if (process.platform === "win32") {
    if (base === "composer.cmd") return 0;
    if (base === "composer.exe") return 1;
    if (base === "composer.bat") return 2;
    if (base === "composer") return 3;
  }
  return base === "composer" ? 0 : 10;
}

export async function resolvePhpCommand(): Promise<ExecutableResolution> {
  if (phpCache === null) {
    phpCache = await resolveExecutable({
      envValue: process.env.PHP_BIN,
      names: ["php"],
      fallback: process.platform === "win32" ? "php.exe" : "php",
      prefer: phpCandidateRank,
    });
  }
  return phpCache;
}

export async function resolveComposerCommand(): Promise<ExecutableResolution> {
  if (composerCache === null) {
    composerCache = await resolveExecutable({
      envValue: process.env.COMPOSER_BIN,
      names: ["composer"],
      fallback: process.platform === "win32" ? "composer.bat" : "composer",
      prefer: composerCandidateRank,
    });
  }
  return composerCache;
}
