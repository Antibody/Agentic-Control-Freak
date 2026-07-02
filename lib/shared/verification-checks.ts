import type { JsonObject } from "@/lib/shared/types";
import type { CommandSpec } from "@/lib/shared/stack-descriptors";

export type VerificationCheckFamily =
  | "syntax"
  | "typecheck"
  | "lint"
  | "unit-test"
  | "integration-test"
  | "build"
  | "http-health"
  | "browser-functional"
  | "api-contract"
  | "custom";

export interface VerificationCheckSpec {
  id: string;
  label: string;
  family: VerificationCheckFamily;
  required: boolean;
  command: CommandSpec | null;
  metadata: JsonObject;
}

export interface VerificationCheckRunRecord {
  id: string;
  verificationRunId: string;
  componentId: string;
  checkSpecId: string;
  family: VerificationCheckFamily;
  command: string | null;
  status: "queued" | "running" | "passed" | "failed" | "skipped";
  exitCode: number | null;
  stdoutArtifactId: string | null;
  stderrArtifactId: string | null;
  startedAt: string;
  endedAt: string | null;
  failureFingerprint: string | null;
  failureClassification: string | null;
}
