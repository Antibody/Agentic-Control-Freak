import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { commonExecutableDirs, resolveExecutable } from "@/lib/server/runtime/executable-resolver";

export interface ClaudeCodeResolution {
  command: string;
  configured: string | null;
  source: "env" | "path" | "known-location" | "fallback";
  candidates: string[];
  rejectedCandidates: string[];
}

let cached: ClaudeCodeResolution | null = null;

async function usableExecutable(candidate: string): Promise<boolean> {
  if (candidate.trim().length === 0) {
    return false;
  }
  if (candidate === "claude") {
    return true;
  }
  try {
    const info = await stat(candidate);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function claudeKnownDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".claude", "local"),
    path.join(home, ".claude", "bin"),
    ...commonExecutableDirs(),
  ];
}

async function knownClaudeCandidates(): Promise<string[]> {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude.bat", "claude"] : ["claude"];
  const candidates: string[] = [];
  for (const directory of claudeKnownDirs()) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await usableExecutable(candidate)) {
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function claudeCandidateRank(candidate: string): number {
  const normalized = candidate.replace(/\\/g, "/").toLowerCase();
  if (normalized.endsWith("/.local/bin/claude.exe")) return 0;
  if (normalized.includes("/.claude/")) return 1;
  if (normalized.endsWith("/claude.exe")) return 2;
  if (normalized.endsWith("/claude.cmd")) return 3;
  if (normalized.endsWith("/claude.bat")) return 4;
  if (normalized.endsWith("/claude")) return 5;
  return 10;
}

export async function resolveClaudeCodeBin(): Promise<ClaudeCodeResolution> {
  if (cached !== null) {
    return cached;
  }

  const resolution = await resolveExecutable({
    envValue: getConfig().claudeCodeBin,
    names: ["claude"],
    knownDirs: claudeKnownDirs(),
    fallback: "claude",
    prefer: claudeCandidateRank,
  });
  const usable: string[] = [];
  const rejected: string[] = [];
  const allCandidates = Array.from(new Set([...resolution.candidates, ...await knownClaudeCandidates()]))
    .sort((left, right) => claudeCandidateRank(left) - claudeCandidateRank(right) || left.localeCompare(right));
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
    : usable[0] ?? (await usableExecutable(resolution.command) ? resolution.command : "claude");

  cached = {
    command,
    configured,
    source: command === resolution.command ? resolution.source : usable.length > 0 ? "known-location" : "fallback",
    candidates: usable,
    rejectedCandidates: rejected,
  };
  return cached;
}
