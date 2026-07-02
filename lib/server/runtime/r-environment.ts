import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import type { ProcessEnvironment } from "@/lib/server/runtime/process-runner";

export const R_LIBRARY_DIRNAME = ".rlib";

export function rLibraryDir(workspacePath: string): string {
  return path.join(workspacePath, R_LIBRARY_DIRNAME);
}

export function rWorkspaceEnv(workspacePath: string, overrides: ProcessEnvironment = {}): ProcessEnvironment {
  return createSanitizedProcessEnv({
    R_LIBS_USER: rLibraryDir(workspacePath),
    ...overrides,
  });
}

export async function ensureRLibraryDir(workspacePath: string): Promise<string> {
  const dir = rLibraryDir(workspacePath);
  await mkdir(dir, { recursive: true });
  return dir;
}

const validRPackageName = /^[A-Za-z][A-Za-z0-9.]*[A-Za-z0-9]$/;

export function parseRDescriptionPackages(descriptionSource: string): string[] {
  const packages = new Set<string>();
  const fieldPattern = /^(Imports|Depends|LinkingTo)\s*:\s*([\s\S]*?)(?=^\S|$(?![\r\n]))/gm;
  let match: RegExpExecArray | null;
  while ((match = fieldPattern.exec(descriptionSource)) !== null) {
    const block = match[2] ?? "";
    for (const rawEntry of block.split(",")) {
      const withoutConstraint = rawEntry.replace(/\([^)]*\)/g, "");
      const name = withoutConstraint.trim();
      if (name.length === 0 || name === "R" || !validRPackageName.test(name)) {
        continue;
      }
      packages.add(name);
    }
  }
  return Array.from(packages);
}

export function rInstallExpression(packages: string[]): string {
  const vector = `c(${packages.map((name) => `"${name}"`).join(", ")})`;
  return [
    "options(install.packages.check.source='no')",
    "dir.create(Sys.getenv('R_LIBS_USER'), showWarnings=FALSE, recursive=TRUE)",
    ".libPaths(c(Sys.getenv('R_LIBS_USER'), .libPaths()))",
    `pkgs <- ${vector}`,
    "to_install <- pkgs[!(pkgs %in% rownames(installed.packages()))]",
    "pkg_type <- if (.Platform$pkgType == 'source') 'source' else 'binary'",
    "if (length(to_install) > 0) install.packages(to_install, repos='https://cloud.r-project.org', lib=Sys.getenv('R_LIBS_USER'), type=pkg_type)",
    "missing <- pkgs[!(pkgs %in% rownames(installed.packages()))]",
    "if (length(missing) > 0) { cat('R packages failed to install:', paste(missing, collapse=', '), '(no compatible package build was found; a newer R version may be required)\\n'); quit(status=1) }",
  ].join("; ");
}
