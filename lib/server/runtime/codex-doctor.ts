import { getConfig } from "@/lib/server/config";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolveCodexCliBin, type CodexCliResolution } from "@/lib/server/runtime/codex-cli-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";

export interface CodexDoctorResult {
  available: boolean;
  executable: CodexCliResolution;
  version: string | null;
  authenticated: boolean;
  sandboxAccepted: boolean;
  smokeExecPassed: boolean;
  error: string | null;
  checkedAt: string;
}

let cached: { expiresAt: number; result: CodexDoctorResult } | null = null;
const ttlMs = 60_000;

function failed(error: string, executable: CodexCliResolution, version: string | null = null): CodexDoctorResult {
  return {
    available: false,
    executable,
    version,
    authenticated: false,
    sandboxAccepted: false,
    smokeExecPassed: false,
    error,
    checkedAt: new Date().toISOString(),
  };
}

function stderrSuggestsAuth(stderr: string): boolean {
  return /auth|login|api key|unauthori[sz]ed|credential/i.test(stderr);
}

export async function runCodexDoctor(): Promise<CodexDoctorResult> {
  const now = Date.now();
  if (cached !== null && cached.expiresAt > now) {
    return cached.result;
  }

  const config = getConfig();
  const executable = await resolveCodexCliBin();
  let version: string | null = null;

  try {
    const versionResult = await runProcess({
      command: executable.command,
      args: ["--version"],
      cwd: process.cwd(),
      timeoutMs: 15_000,
      env: createSanitizedProcessEnv({ CI: "true" }),
    });

    if (versionResult.exitCode !== 0 || versionResult.timedOut) {
      const result = failed(versionResult.stderr || versionResult.stdout || "Unable to run codex --version.", executable);
      cached = { expiresAt: now + ttlMs, result };
      return result;
    }
    version = (versionResult.stdout || versionResult.stderr).trim() || null;

    const smokeResult = await runProcess({
      command: executable.command,
      args: [
        "exec",
        "--cd",
        process.cwd(),
        "--sandbox",
        config.codexSandboxMode,
        "-c",
        'approval_policy="never"',
        "--skip-git-repo-check",
        "--color",
        "never",
        "-",
      ],
      cwd: process.cwd(),
      timeoutMs: 45_000,
      stdin: "Reply with exactly: codex-smoke-ok",
      env: createSanitizedProcessEnv({
        CI: "true",
        CODEX_SANDBOX_MODE: config.codexSandboxMode,
        CODEX_APPROVAL_POLICY: "never",
      }),
    });

    const smokeOutput = `${smokeResult.stdout}\n${smokeResult.stderr}`;
    const passed = smokeResult.exitCode === 0 && !smokeResult.timedOut && smokeOutput.includes("codex-smoke-ok");
    const result: CodexDoctorResult = {
      available: true,
      executable,
      version,
      authenticated: passed || !stderrSuggestsAuth(smokeResult.stderr),
      sandboxAccepted: passed || !/sandbox/i.test(smokeResult.stderr),
      smokeExecPassed: passed,
      error: passed ? null : smokeResult.stderr || smokeResult.stdout || "Codex smoke exec failed without output.",
      checkedAt: new Date().toISOString(),
    };
    cached = { expiresAt: now + ttlMs, result };
    return result;
  } catch (error) {
    const result = failed(error instanceof Error ? error.message : "Unknown Codex doctor failure.", executable, version);
    cached = { expiresAt: now + ttlMs, result };
    return result;
  }
}
