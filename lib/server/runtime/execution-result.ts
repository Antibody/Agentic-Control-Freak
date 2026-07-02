import type { CodeChangeRecord, Identifier, TranscriptTurnRecord } from "@/lib/shared/types";

export interface RuntimeExecutionResult {
  type: "completed" | "failed" | "approval_required";
  summary: string;
  codeChanges: Omit<CodeChangeRecord, "id" | "agentRunId" | "createdAt">[];
  failureKind?: "runtime_failure" | "timeout" | "aborted" | "interrupted_by_user_steering" | "environment_failure" | "provider_exhausted" | "max_turns_exhausted";
  timedOut?: boolean;
  logArtifactId?: Identifier;
  rawOutputBytes?: number;
  continuationRecommended?: boolean;
  transcript?: TranscriptTurnRecord[];
  payload?: {
    reason: string;
    command?: string;
  };
}

const PROVIDER_EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /\busage\s+limit\b/i,
  /\brate[\s-]?limit(?:ed|ing|s)?\b/i,
  /\bquota\b/i,
  /\binsufficient[_\s]quota\b/i,
  /\bout of credits\b/i,
  /\btoo many requests\b/i,
  /\boverloaded\b/i,
  /\b429\b/,
  /\btry again (?:at|in|later)\b/i,
  /\bretry[\s-]?after\b/i,
];

export function isProviderExhaustionMessage(text: string | null | undefined): boolean {
  if (typeof text !== "string" || text.trim().length === 0) {
    return false;
  }
  return PROVIDER_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function providerExhaustionRetryHint(text: string | null | undefined): string | null {
  if (typeof text !== "string") {
    return null;
  }
  const tryAgain = text.match(/try again (at|in)\s+([^.\n]+)/i);
  if (tryAgain !== null) {
    return `try again ${tryAgain[1].toLowerCase()} ${tryAgain[2].trim().replace(/[).,;]+$/, "")}`;
  }
  const retryAfter = text.match(/retry[\s-]?after[:\s]+([^.\n]+)/i);
  if (retryAfter !== null) {
    return `retry after ${retryAfter[1].trim().replace(/[).,;]+$/, "")}`;
  }
  return null;
}
