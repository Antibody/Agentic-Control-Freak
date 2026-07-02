import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecutableResolution {
  command: string;
  configured: string | null;
  source: "env" | "path" | "known-location" | "fallback";
  candidates: string[];
}

export interface ExecutableResolveInput {
  envValue?: string | null;
  names: string[];
  knownDirs?: string[];
  fallback: string;
  prefer?: (candidate: string) => number;
}

function normalizeConfigured(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/^"|"$/g, "");
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

function commandLooksLikePath(command: string): boolean {
  return path.isAbsolute(command) || command.includes("/") || command.includes("\\");
}

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function commonUnixBinDirs(): string[] {
  const home = os.homedir();
  const envDirs = [
    process.env.NVM_BIN,
    process.env.PNPM_HOME,
    process.env.BUN_INSTALL === undefined ? undefined : path.join(process.env.BUN_INSTALL, "bin"),
  ];
  return [
    ...envDirs,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, ".local", "share", "mise", "shims"),
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function commonWindowsBinDirs(): string[] {
  const appData = process.env.APPDATA?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const home = os.homedir();
  return [
    appData === undefined || appData.length === 0 ? path.join(home, "AppData", "Roaming", "npm") : path.join(appData, "npm"),
    localAppData === undefined || localAppData.length === 0 ? undefined : path.join(localAppData, "Programs"),
  ].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function commonExecutableDirs(): string[] {
  return process.platform === "win32" ? commonWindowsBinDirs() : commonUnixBinDirs();
}

function windowsNameVariants(name: string): string[] {
  if (process.platform !== "win32") {
    return [name];
  }
  if (/\.(?:cmd|bat|exe)$/i.test(name)) {
    return [name];
  }
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name];
}

async function commandLookup(name: string): Promise<string[]> {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const args = process.platform === "win32" ? [name] : ["-a", name];
  try {
    const result = await execFileAsync(command, args, { timeout: 5000 });
    return result.stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function knownLocationCandidates(names: string[], dirs: string[]): Promise<string[]> {
  const candidates: string[] = [];
  for (const directory of dirs) {
    for (const name of names) {
      for (const variant of windowsNameVariants(name)) {
        const candidate = path.join(directory, variant);
        if (await fileExists(candidate)) {
          candidates.push(candidate);
        }
      }
    }
  }
  return candidates;
}

function dedupeAndSort(candidates: string[], prefer?: (candidate: string) => number): string[] {
  const unique = Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));
  return unique.sort((left, right) => (prefer?.(left) ?? 0) - (prefer?.(right) ?? 0) || left.localeCompare(right));
}

function configuredNameMatches(candidate: string, configured: string): boolean {
  const base = path.basename(candidate).toLowerCase();
  const wanted = configured.toLowerCase();
  return base === wanted || base.replace(/\.(cmd|bat|exe)$/i, "") === wanted.replace(/\.(cmd|bat|exe)$/i, "");
}

export async function resolveExecutable(input: ExecutableResolveInput): Promise<ExecutableResolution> {
  const configured = normalizeConfigured(input.envValue);
  if (configured !== null && commandLooksLikePath(configured)) {
    return { command: configured, configured, source: "env", candidates: [configured] };
  }

  const lookupNames = configured !== null ? [configured] : input.names;
  const pathCandidates = dedupeAndSort((await Promise.all(lookupNames.map(commandLookup))).flat(), input.prefer);
  if (configured !== null) {
    const matched = pathCandidates.find((candidate) => configuredNameMatches(candidate, configured));
    if (matched !== undefined) {
      return { command: matched, configured, source: "env", candidates: pathCandidates };
    }
  } else if (pathCandidates.length > 0) {
    return { command: pathCandidates[0]!, configured, source: "path", candidates: pathCandidates };
  }

  const knownCandidates = dedupeAndSort(await knownLocationCandidates(lookupNames, [
    ...pathEntries(),
    ...commonExecutableDirs(),
    ...(input.knownDirs ?? []),
  ]), input.prefer);
  if (configured !== null) {
    const matched = knownCandidates.find((candidate) => configuredNameMatches(candidate, configured));
    if (matched !== undefined) {
      return { command: matched, configured, source: "env", candidates: [...pathCandidates, ...knownCandidates] };
    }
  } else if (knownCandidates.length > 0) {
    return { command: knownCandidates[0]!, configured, source: "known-location", candidates: [...pathCandidates, ...knownCandidates] };
  }

  return {
    command: configured ?? input.fallback,
    configured,
    source: configured === null ? "fallback" : "env",
    candidates: [...pathCandidates, ...knownCandidates],
  };
}

