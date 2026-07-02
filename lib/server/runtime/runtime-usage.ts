import { mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import type { AgentProvider, RuntimeUsageSnapshot } from "@/lib/shared/types";

export async function recordRuntimeUsage(input: {
  workSessionId: string;
  agentRunId?: string | null;
  taskId?: string | null;
  provider: AgentProvider;
  model: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
  contextWindow: number | null;
  costUsd?: number | null;
  threadId?: string | null;
  sessionId?: string | null;
  compactionTrigger?: "auto" | "manual" | null;
  compactionAt?: string | null;
  emit?: boolean;
}): Promise<void> {
  try {
    const totalTokens = input.promptTokens !== null && input.outputTokens !== null
      ? input.promptTokens + input.outputTokens
      : input.promptTokens ?? input.outputTokens ?? null;
    const snapshot: RuntimeUsageSnapshot = {
      provider: input.provider,
      model: input.model,
      promptTokens: input.promptTokens,
      outputTokens: input.outputTokens,
      totalTokens,
      contextWindow: input.contextWindow,
      costUsd: input.costUsd ?? null,
      threadId: input.threadId ?? null,
      sessionId: input.sessionId ?? null,
      compactionTrigger: input.compactionTrigger ?? null,
      compactionAt: input.compactionAt ?? null,
      updatedAt: new Date().toISOString(),
    };

    await mutateDatabase((db) => {
      const workSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId);
      if (workSession === undefined) {
        return;
      }
      workSession.runtimeUsage = snapshot;
      updateWorkSessionTimestamp(workSession);
    });

    if (input.emit === false) {
      return;
    }

    await emitEvent({
      workSessionId: input.workSessionId,
      eventName: "runtime.usage.updated",
      aggregateType: "work_session",
      aggregateId: input.workSessionId,
      priority: "low",
      payload: {
        message: "Runtime usage updated.",
        provider: input.provider,
        model: input.model ?? "",
        promptTokens: input.promptTokens ?? -1,
        outputTokens: input.outputTokens ?? -1,
        contextWindow: input.contextWindow ?? -1,
      },
      context: input.taskId !== undefined && input.taskId !== null ? { taskId: input.taskId } : undefined,
    });

    if (input.compactionTrigger != null) {
      await emitEvent({
        workSessionId: input.workSessionId,
        eventName: "runtime.compaction.observed",
        aggregateType: "work_session",
        aggregateId: input.workSessionId,
        payload: {
          message: `Context compaction observed (${input.compactionTrigger}).`,
          trigger: input.compactionTrigger,
        },
      });
    }
  } catch {
  }
}
