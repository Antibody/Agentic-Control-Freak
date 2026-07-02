import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { commonExecutableDirs, resolveExecutable } from "@/lib/server/runtime/executable-resolver";

export interface AgyCliResolution {
  command: string;
  configured: string | null;
  source: "env" | "path" | "known-location" | "fallback";
  candidates: string[];
  rejectedCandidates: string[];
}

let cached: AgyCliResolution | null = null;

async function usableExecutable(candidate: string): Promise<boolean> {
  if (candidate.trim().length === 0) {
    return false;
  }
  if (candidate === "agy") {
    return true;
  }
  try {
    const info = await stat(candidate);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function agyKnownDirs(): string[] {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  return [
    localAppData === undefined || localAppData.length === 0 ? path.join(home, "AppData", "Local", "agy", "bin") : path.join(localAppData, "agy", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".gemini", "antigravity-cli", "bin"),
    process.platform === "win32" ? path.join("C:", "Program Files", "Google", "antigravity-cli") : "",
    ...commonExecutableDirs(),
  ].filter((entry) => entry.trim().length > 0);
}

async function knownAgyCandidates(): Promise<string[]> {
  const names = process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy.bat", "agy"] : ["agy"];
  const candidates: string[] = [];
  for (const directory of agyKnownDirs()) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await usableExecutable(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function agyCandidateRank(candidate: string): number {
  const normalized = candidate.replace(/\\/g, "/").toLowerCase();
  if (normalized.endsWith("/appdata/local/agy/bin/agy.exe")) return 0;
  if (normalized.endsWith("/.local/bin/agy")) return 1;
  if (normalized.includes("/.gemini/antigravity-cli/")) return 2;
  if (normalized.includes("/google/antigravity-cli/")) return 3;
  if (normalized.endsWith("/agy.exe")) return 4;
  if (normalized.endsWith("/agy.cmd")) return 5;
  if (normalized.endsWith("/agy.bat")) return 6;
  if (normalized.endsWith("/agy")) return 7;
  return 10;
}

export async function resolveAgyCliBin(): Promise<AgyCliResolution> {
  if (cached !== null) {
    return cached;
  }

  const resolution = await resolveExecutable({
    envValue: getConfig().agyCliBin,
    names: ["agy"],
    knownDirs: agyKnownDirs(),
    fallback: "agy",
    prefer: agyCandidateRank,
  });
  const usable: string[] = [];
  const rejected: string[] = [];
  const allCandidates = Array.from(new Set([...resolution.candidates, ...await knownAgyCandidates()]))
    .sort((left, right) => agyCandidateRank(left) - agyCandidateRank(right) || left.localeCompare(right));
  for (const candidate of allCandidates) {
    if (await usableExecutable(candidate)) {
      usable.push(candidate);
    } else {
      rejected.push(candidate);
    }
  }

  const configured = resolution.configured;
  const configuredCandidate = configured !== null && path.isAbsolute(configured) ? configured : null;
  const configuredUsable = configuredCandidate !== null && await usableExecutable(configuredCandidate);
  const command = configuredUsable
    ? configuredCandidate
    : usable[0] ?? (await usableExecutable(resolution.command) ? resolution.command : "agy");

  cached = {
    command,
    configured,
    source: command === resolution.command ? resolution.source : usable.length > 0 ? "known-location" : "fallback",
    candidates: usable,
    rejectedCandidates: rejected,
  };
  return cached;
}
