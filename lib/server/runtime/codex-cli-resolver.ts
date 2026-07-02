import os from "node:os";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { commonExecutableDirs, resolveExecutable } from "@/lib/server/runtime/executable-resolver";

export interface CodexCliResolution {
  command: string;
  configured: string | null;
  source: "env" | "path" | "known-location" | "fallback";
  candidates: string[];
}

let cached: CodexCliResolution | null = null;

function windowsCandidateRank(candidate: string): number {
  const lower = candidate.toLowerCase();
  if (lower.endsWith("\\codex.cmd") || lower.endsWith("/codex.cmd")) return 0;
  if (lower.endsWith("\\codex.exe") || lower.endsWith("/codex.exe")) return 1;
  if (lower.endsWith("\\codex.bat") || lower.endsWith("/codex.bat")) return 2;
  if (lower.endsWith("\\codex") || lower.endsWith("/codex")) return 3;
  return 10;
}

function codexCandidateRank(candidate: string): number {
  if (process.platform === "win32") {
    if (candidate.toLowerCase().endsWith(".ps1")) return 100;
    return windowsCandidateRank(candidate);
  }
  const normalized = candidate.replace(/\\/g, "/");
  if (normalized.startsWith("/opt/homebrew/bin/")) return 0;
  if (normalized.startsWith("/usr/local/bin/")) return 1;
  if (normalized.includes("/.local/share/mise/shims/")) return 2;
  if (normalized.includes("/.asdf/shims/")) return 3;
  return 10;
}

function codexKnownDirs(): string[] {
  const home = os.homedir();
  return [
    ...commonExecutableDirs(),
    path.join(home, ".codex", "bin"),
  ];
}

export async function resolveCodexCliBin(): Promise<CodexCliResolution> {
  if (cached !== null) {
    return cached;
  }

  const resolution = await resolveExecutable({
    envValue: getConfig().codexCliBin,
    names: ["codex"],
    knownDirs: codexKnownDirs(),
    fallback: "codex",
    prefer: codexCandidateRank,
  });
  const candidates = resolution.candidates.filter((candidate) => !candidate.toLowerCase().endsWith(".ps1"));
  const command = resolution.command.toLowerCase().endsWith(".ps1")
    ? candidates[0] ?? "codex"
    : resolution.command;
  cached = {
    command,
    configured: resolution.configured,
    source: command === "codex" && resolution.command.toLowerCase().endsWith(".ps1") ? "fallback" : resolution.source,
    candidates,
  };
  return cached;
}
