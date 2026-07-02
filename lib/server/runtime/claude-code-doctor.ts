import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolveClaudeCodeBin, type ClaudeCodeResolution } from "@/lib/server/runtime/claude-code-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";

export interface ClaudeCodeDoctorResult {
  available: boolean;
  executable: ClaudeCodeResolution;
  version: string | null;
  authenticated: boolean | null;
  smokeExecPassed: boolean;
  error: string | null;
  checkedAt: string;
}

async function probeClaudeAuth(command: string): Promise<boolean | null> {
  const result = await runProcess({
    command,
    args: ["auth", "status", "--json"],
    cwd: process.cwd(),
    timeoutMs: 15_000,
    env: createSanitizedProcessEnv({ CI: "true" }),
  });
  if (result.timedOut) {
    return null;
  }
  const text = (result.stdout || result.stderr).trim();
  if (text.length > 0) {
    try {
      const parsed = JSON.parse(text) as { loggedIn?: unknown };
      if (typeof parsed.loggedIn === "boolean") {
        return parsed.loggedIn;
      }
    } catch {
    }
  }
  return result.exitCode === 0;
}

async function computeClaudeCodeDoctor(): Promise<ClaudeCodeDoctorResult> {
  const executable = await resolveClaudeCodeBin();
  const checkedAt = new Date().toISOString();
  const versionResult = await runProcess({
    command: executable.command,
    args: ["--version"],
    cwd: process.cwd(),
    timeoutMs: 15_000,
    env: createSanitizedProcessEnv({ CI: "true" }),
  });
  if (versionResult.exitCode !== 0 || versionResult.timedOut) {
    return {
      available: false,
      executable,
      version: null,
      authenticated: null,
      smokeExecPassed: false,
      error: versionResult.stderr || versionResult.stdout || "Unable to run claude --version.",
      checkedAt,
    };
  }

  const version = (versionResult.stdout || versionResult.stderr).trim() || null;
  const authenticated = await probeClaudeAuth(executable.command).catch(() => null);
  return {
    available: true,
    executable,
    version,
    authenticated,
    smokeExecPassed: true,
    error: executable.rejectedCandidates.length > 0
      ? `Ignored unusable Claude executable candidate(s): ${executable.rejectedCandidates.join(", ")}`
      : null,
    checkedAt,
  };
}

const DOCTOR_TTL_MS = 15_000;
let cached: { result: ClaudeCodeDoctorResult; at: number } | null = null;

export async function runClaudeCodeDoctor(options?: { force?: boolean }): Promise<ClaudeCodeDoctorResult> {
  if (options?.force !== true && cached !== null && Date.now() - cached.at < DOCTOR_TTL_MS) {
    return cached.result;
  }
  const result = await computeClaudeCodeDoctor();
  cached = { result, at: Date.now() };
  return result;
}
