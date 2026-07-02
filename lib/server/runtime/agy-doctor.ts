import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolveAgyCliBin, type AgyCliResolution } from "@/lib/server/runtime/agy-cli-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";

export interface AgyDoctorResult {
  available: boolean;
  executable: AgyCliResolution;
  version: string | null;
  authenticated: boolean | null;
  smokeExecPassed: boolean;
  error: string | null;
  checkedAt: string;
}

export async function runAgyDoctor(): Promise<AgyDoctorResult> {
  const executable = await resolveAgyCliBin();
  const checkedAt = new Date().toISOString();
  const versionResult = await runProcess({
    command: executable.command,
    args: ["--version"],
    cwd: process.cwd(),
    timeoutMs: 15_000,
    env: createSanitizedProcessEnv({
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      CI: "true",
    }),
  });
  if (versionResult.exitCode !== 0 || versionResult.timedOut) {
    return {
      available: false,
      executable,
      version: null,
      authenticated: null,
      smokeExecPassed: false,
      error: versionResult.stderr || versionResult.stdout || "Unable to run agy --version.",
      checkedAt,
    };
  }

  const version = (versionResult.stdout || versionResult.stderr).trim() || null;
  return {
    available: true,
    executable,
    version,
    authenticated: null,
    smokeExecPassed: true,
    error: executable.rejectedCandidates.length > 0
      ? `Ignored unusable AGY executable candidate(s): ${executable.rejectedCandidates.join(", ")}`
      : null,
    checkedAt,
  };
}
