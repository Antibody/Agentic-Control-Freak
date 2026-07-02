import path from "node:path";
import { resolveExecutable, type ExecutableResolution } from "@/lib/server/runtime/executable-resolver";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

const cache = new Map<PackageManagerName, ExecutableResolution>();

function envName(packageManager: PackageManagerName): string {
  return `${packageManager.toUpperCase()}_BIN`;
}

function candidateRank(packageManager: PackageManagerName): (candidate: string) => number {
  return (candidate: string): number => {
    const base = path.basename(candidate).toLowerCase();
    if (process.platform === "win32") {
      if (base === `${packageManager}.cmd`) return 0;
      if (base === `${packageManager}.exe`) return 1;
      if (base === `${packageManager}.bat`) return 2;
      if (base === packageManager) return 3;
    }
    return 10;
  };
}

export async function resolvePackageManagerCommand(packageManager: PackageManagerName): Promise<ExecutableResolution> {
  const cached = cache.get(packageManager);
  if (cached !== undefined) {
    return cached;
  }

  const resolution = await resolveExecutable({
    envValue: process.env[envName(packageManager)],
    names: [packageManager],
    fallback: process.platform === "win32" ? `${packageManager}.cmd` : packageManager,
    prefer: candidateRank(packageManager),
  });
  cache.set(packageManager, resolution);
  return resolution;
}

