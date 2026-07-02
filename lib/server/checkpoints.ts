import { getConfig } from "@/lib/server/config";
import {
  createCheckpointRecord,
  createId,
  currentTimestamp,
  mutateDatabase,
  updateWorkSessionTimestamp,
} from "@/lib/server/db/file-db";
import { saveArtifact } from "@/lib/server/artifacts";
import { emitEvent } from "@/lib/server/events";
import { syncOrchestratorState } from "@/lib/server/orchestrator-state";
import { createActiveHistoryFilter } from "@/lib/shared/history";
import {
  createGitCheckpoint,
  restoreGitCheckpoint,
  surgicallyRevertGitCheckpointDelta,
  updateGitCheckpointRef,
} from "@/lib/server/runtime/workspace-git";
import type { CheckpointRecord, CheckpointTrigger, Identifier } from "@/lib/shared/types";

function checkpointSummary(trigger: CheckpointTrigger, filesChanged: number): string {
  const label = trigger.replace(/_/g, " ");
  return filesChanged === 0 ? `${label}: no file changes.` : `${label}: ${filesChanged} file(s) changed.`;
}

function checkpointMessage(input: {
  trigger: CheckpointTrigger;
  checkpointId: Identifier;
  taskId: Identifier | null;
  agentRunId: Identifier | null;
}): string {
  return [
    `orchestrator checkpoint ${input.trigger}`,
    `checkpoint=${input.checkpointId}`,
    input.taskId === null ? "" : `task=${input.taskId}`,
    input.agentRunId === null ? "" : `agentRun=${input.agentRunId}`,
  ].filter((entry) => entry.length > 0).join("\n\n");
}

export async function createSessionCheckpoint(input: {
  workSessionId: Identifier;
  taskId?: Identifier | null;
  agentRunId?: Identifier | null;
  trigger: CheckpointTrigger;
  updateCurrent?: boolean;
}): Promise<CheckpointRecord | null> {
  if (!getConfig().checkpointsEnabled) {
    return null;
  }
  const seed = await mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId);
    if (workSession === undefined) {
      throw new Error("Work session was not found.");
    }
    return {
      checkpointId: createId(),
      previousCheckpointId: workSession.checkpointRef,
      workTree: workSession.activeWorktreePath,
      projectId: workSession.projectId,
    };
  });

  try {
    const gitCheckpoint = await createGitCheckpoint({
      workSessionId: input.workSessionId,
      workTree: seed.workTree,
      checkpointId: seed.checkpointId,
      message: checkpointMessage({
        trigger: input.trigger,
        checkpointId: seed.checkpointId,
        taskId: input.taskId ?? null,
        agentRunId: input.agentRunId ?? null,
      }),
    });
    const record = await mutateDatabase((db) => {
      const workSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId);
      if (workSession === undefined) {
        throw new Error("Work session was not found.");
      }
      const checkpoint = createCheckpointRecord({
        workSessionId: input.workSessionId,
        taskId: input.taskId ?? null,
        agentRunId: input.agentRunId ?? null,
        trigger: input.trigger,
        status: "active",
        refName: gitCheckpoint.refName,
        commitHash: gitCheckpoint.commitHash,
        previousCheckpointId: seed.previousCheckpointId,
        restoredFromCheckpointId: null,
        summary: checkpointSummary(input.trigger, gitCheckpoint.filesChanged),
        filesChanged: gitCheckpoint.filesChanged,
        codexThreadId: input.agentRunId === undefined || input.agentRunId === null
          ? null
          : db.agentRuns.find((candidate) => candidate.id === input.agentRunId)?.codexThreadId ?? null,
        codexTurnId: input.agentRunId === undefined || input.agentRunId === null
          ? null
          : db.agentRuns.find((candidate) => candidate.id === input.agentRunId)?.codexTurnId ?? null,
        codexTurnOrdinal: null,
      });
      db.checkpoints.push(checkpoint);
      if (input.updateCurrent !== false) {
        workSession.checkpointRef = checkpoint.id;
        updateWorkSessionTimestamp(workSession);
      }
      return { ...checkpoint };
    });
    await emitEvent({
      workSessionId: input.workSessionId,
      eventName: "checkpoint.created",
      aggregateType: "checkpoint",
      aggregateId: record.id,
      payload: {
        message: record.summary,
        trigger: record.trigger,
        filesChanged: String(record.filesChanged),
        commitHash: record.commitHash,
      },
      context: { taskId: record.taskId ?? undefined, agentRunId: record.agentRunId ?? undefined },
    });
    return record;
  } catch (error) {
    await emitEvent({
      workSessionId: input.workSessionId,
      eventName: "checkpoint.failed",
      aggregateType: "work_session",
      aggregateId: input.workSessionId,
      priority: "high",
      payload: {
        message: error instanceof Error ? error.message : "Checkpoint creation failed.",
        trigger: input.trigger,
      },
    });
    throw error;
  }
}

export async function restorePreviousCheckpoint(workSessionId: Identifier): Promise<{
  restoredCheckpoint: CheckpointRecord;
  targetCheckpoint: CheckpointRecord;
  safetyCheckpoint: CheckpointRecord | null;
}> {
  if (!getConfig().checkpointsEnabled) {
    throw new Error("Checkpoints are disabled.");
  }
  const targetId = await mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === workSessionId);
    if (workSession === undefined) {
      throw new Error("Work session was not found.");
    }
    const current = workSession.checkpointRef === null
      ? null
      : db.checkpoints.find((candidate) => candidate.id === workSession.checkpointRef) ?? null;
    if (current === null) {
      throw new Error("No current checkpoint is available to undo.");
    }
    if (current.previousCheckpointId === null) {
      throw new Error("The current checkpoint has no previous checkpoint to restore.");
    }
    const target = db.checkpoints.find((candidate) => candidate.id === current.previousCheckpointId);
    if (target === undefined) {
      throw new Error("The previous checkpoint was not found.");
    }
    return target.id;
  });

  return restoreCheckpointToTarget({ workSessionId, checkpointId: targetId });
}

export async function restoreCheckpointToTarget(input: { workSessionId: Identifier; checkpointId: Identifier }): Promise<{
  restoredCheckpoint: CheckpointRecord;
  targetCheckpoint: CheckpointRecord;
  safetyCheckpoint: CheckpointRecord | null;
}> {
  if (!getConfig().checkpointsEnabled) {
    throw new Error("Checkpoints are disabled.");
  }
  const seed = await mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId);
    if (workSession === undefined) {
      throw new Error("Work session was not found.");
    }
    const current = workSession.checkpointRef === null
      ? null
      : db.checkpoints.find((candidate) => candidate.id === workSession.checkpointRef) ?? null;
    if (current === null) {
      throw new Error("No current checkpoint is available.");
    }
    const target = db.checkpoints.find((candidate) => candidate.id === input.checkpointId && candidate.workSessionId === input.workSessionId);
    if (target === undefined) {
      throw new Error("Checkpoint was not found.");
    }
    return {
      workTree: workSession.activeWorktreePath,
      current: { ...current },
      target: { ...target },
    };
  });

  const safetyCheckpoint = await createSessionCheckpoint({
    workSessionId: input.workSessionId,
    taskId: seed.current.taskId,
    agentRunId: seed.current.agentRunId,
    trigger: "pre_restore",
    updateCurrent: true,
  });
  await restoreGitCheckpoint({
    workSessionId: input.workSessionId,
    workTree: seed.workTree,
    commitHash: seed.target.commitHash,
  });

  const restoreCheckpointId = createId();
  const refName = await updateGitCheckpointRef({
    workSessionId: input.workSessionId,
    workTree: seed.workTree,
    checkpointId: restoreCheckpointId,
    commitHash: seed.target.commitHash,
  });
  const restoredAt = currentTimestamp();
  const restoredCheckpoint = await mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId);
    if (workSession === undefined) {
      throw new Error("Work session was not found.");
    }
    const targetTask = seed.target.taskId === null ? undefined : db.tasks.find((candidate) => candidate.id === seed.target.taskId);
    const targetPlan = targetTask === undefined ? undefined : db.plans.find((candidate) => candidate.id === targetTask.planId);
    const checkpoint = createCheckpointRecord({
      id: restoreCheckpointId,
      workSessionId: input.workSessionId,
      taskId: seed.current.taskId,
      agentRunId: seed.current.agentRunId,
      trigger: "restore",
      status: "restored",
      refName,
      commitHash: seed.target.commitHash,
      previousCheckpointId: safetyCheckpoint?.id ?? seed.current.id,
      restoredFromCheckpointId: seed.target.id,
      summary: `Restored checkpoint from ${new Date(seed.target.createdAt).toLocaleString()}.`,
      filesChanged: seed.current.filesChanged,
      createdAt: restoredAt,
    });
    db.checkpoints.push(checkpoint);
    workSession.checkpointRef = checkpoint.id;
    workSession.historyBaseCheckpointId = seed.target.id;
    workSession.historyBaseCheckpointCreatedAt = seed.target.createdAt;
    workSession.historyRestoredAt = restoredAt;
    const activeHistory = createActiveHistoryFilter(workSession, db.checkpoints);
    const latestActiveUserMessage = db.chatMessages
      .filter((message) =>
        message.chatSessionId === workSession.chatSessionId &&
        message.role === "user" &&
        activeHistory(message.createdAt))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .at(-1) ?? null;
    if (latestActiveUserMessage !== null) {
      workSession.lastUserMessage = latestActiveUserMessage.content;
    }
    workSession.claudeSessionId = null;
    workSession.codexThreadId = null;
    workSession.codexSubagents = [];
    workSession.codexCollabCalls = [];
    workSession.transcriptRef = null;
    const laterTaskIds = new Set(
      db.checkpoints
        .filter((candidate) =>
          candidate.workSessionId === input.workSessionId &&
          candidate.createdAt > seed.target.createdAt &&
          candidate.createdAt < restoredAt &&
          candidate.taskId !== null
        )
        .map((candidate) => candidate.taskId as Identifier)
    );
    if (seed.current.taskId !== null) {
      laterTaskIds.add(seed.current.taskId);
    }
    if (targetTask !== undefined && targetPlan !== undefined) {
      const includeTargetTask = seed.target.trigger !== "post_task";
      for (const task of db.tasks.filter((candidate) => candidate.planId === targetPlan.id)) {
        if (task.ordinal > targetTask.ordinal || (includeTargetTask && task.ordinal === targetTask.ordinal)) {
          laterTaskIds.add(task.id);
        }
      }
    }
    for (const taskId of laterTaskIds) {
      const task = db.tasks.find((candidate) => candidate.id === taskId);
      if (task !== undefined && task.status !== "skipped") {
        task.status = "skipped";
        task.lastFailureSummary = null;
        task.lastFailureFingerprint = null;
        task.metadata.revertedCheckpointId = seed.target.id;
        task.metadata.revertedAt = restoredAt;
      }
    }
    const laterPlanIds = new Set(
      db.plans
        .filter((candidate) =>
          candidate.workSessionId === input.workSessionId &&
          candidate.createdAt > seed.target.createdAt &&
          candidate.createdAt < restoredAt
        )
        .map((candidate) => candidate.id)
    );
    for (const planId of laterPlanIds) {
      const plan = db.plans.find((candidate) => candidate.id === planId);
      if (plan !== undefined && plan.id !== targetPlan?.id && plan.status !== "canceled") {
        plan.status = "superseded";
      }
    }
    for (const approval of db.approvals) {
      if (
        approval.workSessionId === input.workSessionId &&
        approval.status === "pending" &&
        approval.requestedAt > seed.target.createdAt &&
        approval.requestedAt < restoredAt
      ) {
        approval.status = "expired";
        approval.resolvedAt = restoredAt;
        approval.resolvedBy = null;
      }
    }
    if (targetPlan !== undefined) {
      workSession.activePlanId = targetPlan.id;
      if (targetPlan.status === "completed" && db.tasks.some((candidate) => candidate.planId === targetPlan.id && candidate.status === "todo")) {
        targetPlan.status = "approved";
      }
    } else {
      workSession.activePlanId = null;
    }
    workSession.currentState = "completed";
    workSession.paused = false;
    workSession.awaitingStep = false;
    workSession.nextActionLabel = null;
    for (const run of db.agentRuns) {
      if (run.workSessionId === input.workSessionId && (run.status === "running" || run.status === "waiting_approval")) {
        run.status = "canceled";
        run.summary = run.summary || "Marked canceled during checkpoint restore because no live process was active.";
        run.endedAt = restoredAt;
      }
    }
    updateWorkSessionTimestamp(workSession);
    return { ...checkpoint };
  });
  await emitEvent({
    workSessionId: input.workSessionId,
    eventName: "checkpoint.restored",
    aggregateType: "checkpoint",
    aggregateId: restoredCheckpoint.id,
    priority: "high",
    payload: {
      message: restoredCheckpoint.summary,
      restoredCheckpointId: seed.target.id,
      safetyCheckpointId: safetyCheckpoint?.id ?? "",
      revertedCheckpointId: seed.current.id,
    },
    context: { taskId: seed.current.taskId ?? undefined, agentRunId: seed.current.agentRunId ?? undefined },
  });
  await syncOrchestratorState(input.workSessionId);
  return { restoredCheckpoint, targetCheckpoint: seed.target, safetyCheckpoint };
}

export async function surgicallyRevertCheckpoint(input: { workSessionId: Identifier; checkpointId: Identifier }): Promise<{
  revertCheckpoint: CheckpointRecord;
  targetCheckpoint: CheckpointRecord;
  baseCheckpoint: CheckpointRecord;
  safetyCheckpoint: CheckpointRecord;
  patchArtifactId: Identifier;
}> {
  if (!getConfig().checkpointsEnabled) {
    throw new Error("Checkpoints are disabled.");
  }
  const seed = await mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId);
    if (workSession === undefined) {
      throw new Error("Work session was not found.");
    }
    const hasCurrentCheckpoint = workSession.checkpointRef !== null &&
      db.checkpoints.some((candidate) => candidate.id === workSession.checkpointRef);
    if (!hasCurrentCheckpoint) {
      throw new Error("No current checkpoint is available.");
    }
    const target = db.checkpoints.find((candidate) => candidate.id === input.checkpointId && candidate.workSessionId === input.workSessionId);
    if (target === undefined) {
      throw new Error("Checkpoint was not found.");
    }
    if (target.previousCheckpointId === null) {
      throw new Error("This checkpoint has no previous checkpoint, so there is no single delta to revert.");
    }
    if (target.trigger !== "post_task") {
      throw new Error("Surgical revert is only available for post-task checkpoints.");
    }
    if (target.filesChanged === 0) {
      throw new Error("This checkpoint did not record file changes to revert.");
    }
    const base = db.checkpoints.find((candidate) => candidate.id === target.previousCheckpointId && candidate.workSessionId === input.workSessionId);
    if (base === undefined) {
      throw new Error("The selected checkpoint's previous checkpoint was not found.");
    }
    return {
      workTree: workSession.activeWorktreePath,
      target: { ...target },
      base: { ...base },
    };
  });

  const safetyCheckpoint = await createSessionCheckpoint({
    workSessionId: input.workSessionId,
    taskId: seed.target.taskId,
    agentRunId: seed.target.agentRunId,
    trigger: "pre_surgical_revert",
    updateCurrent: true,
  });
  if (safetyCheckpoint === null) {
    throw new Error("Unable to create a safety checkpoint before surgical revert.");
  }

  let revertResult: Awaited<ReturnType<typeof surgicallyRevertGitCheckpointDelta>>;
  try {
    revertResult = await surgicallyRevertGitCheckpointDelta({
      workSessionId: input.workSessionId,
      workTree: seed.workTree,
      baseCommitHash: seed.base.commitHash,
      targetCommitHash: seed.target.commitHash,
    });
  } catch (error) {
    await restoreGitCheckpoint({
      workSessionId: input.workSessionId,
      workTree: seed.workTree,
      commitHash: safetyCheckpoint.commitHash,
    });
    await emitEvent({
      workSessionId: input.workSessionId,
      eventName: "checkpoint.failed",
      aggregateType: "checkpoint",
      aggregateId: seed.target.id,
      priority: "high",
      payload: {
        message: error instanceof Error ? error.message : "Surgical revert failed.",
        trigger: "surgical_revert",
        safetyCheckpointId: safetyCheckpoint.id,
      },
      context: { taskId: seed.target.taskId ?? undefined, agentRunId: seed.target.agentRunId ?? undefined },
    });
    await syncOrchestratorState(input.workSessionId);
    throw error;
  }

  const patchArtifact = await saveArtifact({
    workSessionId: input.workSessionId,
    kind: "patch",
    fileName: `surgical-revert-${seed.target.id}.patch`,
    content: revertResult.patch,
    metadata: {
      targetCheckpointId: seed.target.id,
      baseCheckpointId: seed.base.id,
      safetyCheckpointId: safetyCheckpoint.id,
      filesChanged: revertResult.filesChanged,
      applyStdout: revertResult.stdout,
      applyStderr: revertResult.stderr,
    },
  });

  const revertCheckpoint = await createSessionCheckpoint({
    workSessionId: input.workSessionId,
    taskId: seed.target.taskId,
    agentRunId: seed.target.agentRunId,
    trigger: "surgical_revert",
    updateCurrent: true,
  });
  if (revertCheckpoint === null) {
    throw new Error("Unable to create a checkpoint after surgical revert.");
  }

  const finalizedCheckpoint = await mutateDatabase((db) => {
    const checkpoint = db.checkpoints.find((candidate) => candidate.id === revertCheckpoint.id);
    if (checkpoint === undefined) {
      throw new Error("Surgical revert checkpoint was not found.");
    }
    checkpoint.restoredFromCheckpointId = seed.target.id;
    checkpoint.summary = `Surgically reverted changes from ${new Date(seed.target.createdAt).toLocaleString()}.`;
    checkpoint.filesChanged = revertResult.filesChanged;
    const task = seed.target.taskId === null ? undefined : db.tasks.find((candidate) => candidate.id === seed.target.taskId);
    if (task !== undefined) {
      task.metadata.surgicallyRevertedCheckpointId = seed.target.id;
      task.metadata.surgicallyRevertedAt = checkpoint.createdAt;
      task.metadata.surgicalRevertPatchArtifactId = patchArtifact.id;
    }
    const workSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId);
    if (workSession !== undefined) {
      workSession.currentState = "completed";
      workSession.awaitingStep = false;
      workSession.nextActionLabel = null;
      workSession.claudeSessionId = null;
      workSession.codexThreadId = null;
      workSession.codexSubagents = [];
      workSession.codexCollabCalls = [];
      workSession.transcriptRef = null;
      updateWorkSessionTimestamp(workSession);
    }
    return { ...checkpoint };
  });

  await emitEvent({
    workSessionId: input.workSessionId,
    eventName: "checkpoint.surgical_reverted",
    aggregateType: "checkpoint",
    aggregateId: finalizedCheckpoint.id,
    priority: "high",
    payload: {
      message: finalizedCheckpoint.summary,
      revertedCheckpointId: seed.target.id,
      baseCheckpointId: seed.base.id,
      safetyCheckpointId: safetyCheckpoint.id,
      patchArtifactId: patchArtifact.id,
      filesChanged: String(revertResult.filesChanged),
    },
    context: { taskId: seed.target.taskId ?? undefined, agentRunId: seed.target.agentRunId ?? undefined },
  });
  await syncOrchestratorState(input.workSessionId);
  return {
    revertCheckpoint: finalizedCheckpoint,
    targetCheckpoint: seed.target,
    baseCheckpoint: seed.base,
    safetyCheckpoint,
    patchArtifactId: patchArtifact.id,
  };
}
