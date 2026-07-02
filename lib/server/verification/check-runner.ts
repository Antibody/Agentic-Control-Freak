import type { VerificationCheck, VerificationExecutionResult } from "@/lib/server/verification";
import type { VerificationCheckSpec } from "@/lib/shared/verification-checks";
import type { VerificationFailureKind } from "@/lib/shared/types";

export function summarizePlannedChecks(checks: VerificationCheckSpec[]): string {
  if (checks.length === 0) {
    return "No command checks were planned.";
  }
  return checks.map((check) => `${check.family}: ${check.label}`).join("; ");
}

export function aggregateVerificationChecks(input: {
  commandChecks: VerificationCheck[];
  failed: boolean;
  rawOutput: string;
  commands: string[];
  fallbackFailureKind?: VerificationFailureKind;
}): Pick<VerificationExecutionResult, "status" | "failureKind" | "summary" | "rawOutput" | "commands" | "checks"> {
  const firstFailure = input.commandChecks.find((check) => check.status === "failed");
  return {
    status: input.failed ? "failed" : "passed",
    failureKind: input.failed ? firstFailure?.failureKind ?? input.fallbackFailureKind ?? "source_failure" : "none",
    summary: input.failed
      ? firstFailure?.message ?? "Verification failed."
      : "All runnable verification commands passed.",
    rawOutput: input.rawOutput,
    commands: input.commands,
    checks: input.commandChecks,
  };
}
