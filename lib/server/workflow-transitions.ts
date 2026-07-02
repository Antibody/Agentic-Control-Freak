import type { VerificationFailureKind, WorkSessionState } from "@/lib/shared/types";

export type VerificationTransitionInput = {
  currentState: WorkSessionState;
  verificationStatus: "passed" | "failed";
  failureKind: VerificationFailureKind;
  repairBudgetRemaining: boolean;
  repeatedFailure: boolean;
  acceptanceEvidenceSatisfied: boolean;
};

export type WorkflowTransitionDecision = {
  nextState: WorkSessionState;
  reason: string;
  sideEffectIntent: "complete" | "create_repair_task" | "create_blocking_handoff";
};

export function decideVerificationTransition(input: VerificationTransitionInput): WorkflowTransitionDecision {
  if (input.currentState !== "verifying") {
    return {
      nextState: input.currentState,
      reason: `No verification transition applies from ${input.currentState}.`,
      sideEffectIntent: "create_blocking_handoff",
    };
  }

  if (input.verificationStatus === "passed") {
    if (!input.acceptanceEvidenceSatisfied) {
      return {
        nextState: "blocked",
        reason: "Verification passed, but acceptance criteria evidence is incomplete.",
        sideEffectIntent: "create_blocking_handoff",
      };
    }
    return {
      nextState: "completed",
      reason: "Verification passed and acceptance criteria evidence is satisfied.",
      sideEffectIntent: "complete",
    };
  }

  const repairableFailure =
    input.failureKind === "source_failure" ||
    input.failureKind === "dependency_failure" ||
    input.failureKind === "functional_failure" ||
    input.failureKind === "visual_failure";

  if (!repairableFailure) {
    return {
      nextState: "blocked",
      reason: `Verification failed due to ${input.failureKind}; this is not safe to send into code repair automatically.`,
      sideEffectIntent: "create_blocking_handoff",
    };
  }

  if (input.repeatedFailure) {
    return {
      nextState: "blocked",
      reason: "Verification failed with the same failure fingerprint repeatedly.",
      sideEffectIntent: "create_blocking_handoff",
    };
  }

  if (input.repairBudgetRemaining) {
    return {
      nextState: "executing",
      reason: "Verification failed and repair budget remains.",
      sideEffectIntent: "create_repair_task",
    };
  }

  return {
    nextState: "blocked",
    reason: "Verification failed and repair budget is exhausted.",
    sideEffectIntent: "create_blocking_handoff",
  };
}
