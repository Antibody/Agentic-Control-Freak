import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { IGNORED_WORKSPACE_DIRS, hasIgnoredModelExtension } from "@/lib/server/runtime/workspace-ignore";
import {
  createChatMessage,
  createCheckpointRecord,
  createId,
  createPlanRecord,
  createTaskRecord,
  currentTimestamp,
  mutateDatabase,
  updateWorkSessionTimestamp,
} from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { activeProcessesForWorkSession } from "@/lib/server/runtime/process-registry";
import { withCodexAppServerControl } from "@/lib/server/runtime/codex-app-server-control";
import { resolveCodexTransport } from "@/lib/server/runtime/codex-transport";
import { createGitCheckpoint, materializeGitCheckpoint } from "@/lib/server/runtime/workspace-git";
import { syncOrchestratorState } from "@/lib/server/orchestrator-state";
import {
  computeAbandonedHistoryWindows,
  isTimestampInActiveHistory,
  type AbandonedHistoryWindow,
} from "@/lib/shared/history";
import type {
  ChatMessageRecord,
  ChatSessionRecord,
  CheckpointRecord,
  Identifier,
  JsonObject,
  PlanRecord,
  ProjectRecord,
  RuntimeProfileRecord,
  WorkSessionRecord,
} from "@/lib/shared/types";

const ignoredWorkspaceCopyNames = IGNORED_WORKSPACE_DIRS;

export interface ForkWorkSessionResult {
  project: ProjectRecord;
  runtimeProfile: RuntimeProfileRecord;
  chatSession: ChatSessionRecord;
  workSession: WorkSessionRecord;
  baselineCheckpoint: CheckpointRecord | null;
  forkedFromWorkSessionId: Identifier;
  forkedFromCheckpointId: Identifier | null;
  forkedFromHandoffId: Identifier | null;
  forkedFromPlanId: Identifier | null;
}

function safeSlugSegment(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "fork";
}

function forkTitle(sourceTitle: string, requestedTitle: string | undefined): string {
  const normalized = requestedTitle?.replace(/\s+/g, " ").trim();
  if (normalized !== undefined && normalized.length > 0) {
    return normalized.slice(0, 120);
  }
  const base = sourceTitle.replace(/\s+/g, " ").trim() || "Forked chat";
  return base.endsWith("(fork)") ? base : `${base} (fork)`;
}

function shouldCopyWorkspaceEntry(source: string, entryPath: string): boolean {
  const relative = path.relative(source, entryPath);
  if (relative.length === 0) {
    return true;
  }
  const segments = relative.split(path.sep);
  if (segments.some((segment) => ignoredWorkspaceCopyNames.has(segment))) {
    return false;
  }
  return !hasIgnoredModelExtension(path.basename(entryPath));
}

async function copyCurrentWorkspace(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const sourceStat = await stat(source).catch(() => null);
  if (sourceStat === null || !sourceStat.isDirectory()) {
    return;
  }
  await cp(source, target, {
    recursive: true,
    errorOnExist: false,
    force: false,
    filter: (entryPath) => shouldCopyWorkspaceEntry(source, entryPath),
  });
}

async function workspacePathExists(candidate: string): Promise<boolean> {
  return stat(candidate).then(() => true, () => false);
}

async function uniqueForkWorkspacePath(slugHint: string): Promise<{ slug: string; localRepoPath: string }> {
  const config = getConfig();
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const baseSlug = `${safeSlugSegment(slugHint)}-fork-${stamp}`;
  for (let index = 0; index < 50; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const slug = `${baseSlug}${suffix}`;
    const localRepoPath = path.join(config.workspaceRoot, slug);
    if (!(await workspacePathExists(localRepoPath))) {
      return { slug, localRepoPath };
    }
  }
  const fallbackSlug = `${baseSlug}-${createId().slice(0, 8)}`;
  return { slug: fallbackSlug, localRepoPath: path.join(config.workspaceRoot, fallbackSlug) };
}

function cloneChatMessages(
  messages: ChatMessageRecord[],
  chatSessionId: Identifier,
  cutoff: string | null,
  abandonedWindows: AbandonedHistoryWindow[],
): ChatMessageRecord[] {
  return messages
    .filter((message) =>
      (cutoff === null || message.createdAt <= cutoff) &&
      isTimestampInActiveHistory(abandonedWindows, message.createdAt))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((message) => ({
      ...createChatMessage({
        chatSessionId,
        role: message.role,
        content: message.content,
        messageKind: message.messageKind,
        relatedEventId: null,
      }),
      createdAt: message.createdAt,
    }));
}

export async function forkWorkSession(input: {
  workSessionId: Identifier;
  checkpointId?: Identifier | null;
  handoffId?: Identifier | null;
  planId?: Identifier | null;
  title?: string;
}): Promise<ForkWorkSessionResult> {
  if (activeProcessesForWorkSession(input.workSessionId).length > 0) {
    throw new Error("Stop the running agent before forking this chat.");
  }
  const hasExplicitCheckpoint = input.checkpointId !== undefined && input.checkpointId !== null;
  const hasExplicitHandoff = input.handoffId !== undefined && input.handoffId !== null;
  const hasExplicitPlan = input.planId !== undefined && input.planId !== null;
  const explicitForkPointCount = [hasExplicitCheckpoint, hasExplicitHandoff, hasExplicitPlan].filter(Boolean).length;
  if (explicitForkPointCount > 1) {
    throw new Error("Fork from a checkpoint, handoff, or approved plan, not more than one.");
  }

  const config = getConfig();
  const prepared = await mutateDatabase((db) => {
    const sourceWorkSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId);
    if (sourceWorkSession === undefined) {
      throw new Error("Work session was not found.");
    }
    if (["planning", "queued", "executing", "verifying"].includes(sourceWorkSession.currentState)) {
      throw new Error("Wait for the active controller step to finish before forking this chat.");
    }
    const sourceProject = db.projects.find((candidate) => candidate.id === sourceWorkSession.projectId);
    if (sourceProject === undefined) {
      throw new Error("Source project was not found.");
    }
    const sourceRuntimeProfile = db.runtimeProfiles.find((candidate) => candidate.id === sourceWorkSession.runtimeProfileId);
    if (sourceRuntimeProfile === undefined) {
      throw new Error("Source runtime profile was not found.");
    }
    const sourceChatSession = db.chatSessions.find((candidate) => candidate.id === sourceWorkSession.chatSessionId);
    if (sourceChatSession === undefined) {
      throw new Error("Source chat session was not found.");
    }
    const sourceHandoff = input.handoffId === undefined || input.handoffId === null
      ? null
      : db.handoffs.find((candidate) => candidate.id === input.handoffId && candidate.workSessionId === sourceWorkSession.id) ?? null;
    if (input.handoffId !== undefined && input.handoffId !== null && sourceHandoff === null) {
      throw new Error("Handoff was not found.");
    }
    const sourcePlan = input.planId === undefined || input.planId === null
      ? null
      : db.plans.find((candidate) => candidate.id === input.planId && candidate.workSessionId === sourceWorkSession.id) ?? null;
    if (input.planId !== undefined && input.planId !== null && sourcePlan === null) {
      throw new Error("Plan was not found.");
    }
    if (sourcePlan !== null && sourcePlan.status !== "approved" && sourcePlan.status !== "completed") {
      throw new Error("Only approved plans can be forked from the Plan card.");
    }
    if (sourcePlan !== null && sourcePlan.approvedAt === null) {
      throw new Error("This plan does not have an approval timestamp.");
    }
    if (sourcePlan !== null && sourcePlan.approvalCheckpointId === null) {
      throw new Error("This plan was approved before plan fork checkpoints were recorded. Fork from a checkpoint instead.");
    }
    const sessionCheckpoints = db.checkpoints
      .filter((candidate) => candidate.workSessionId === sourceWorkSession.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const sourceCheckpoint = input.checkpointId !== undefined && input.checkpointId !== null
      ? sessionCheckpoints.find((candidate) => candidate.id === input.checkpointId) ?? null
      : sourcePlan !== null
        ? sessionCheckpoints.find((candidate) => candidate.id === sourcePlan.approvalCheckpointId) ?? null
      : sourceHandoff !== null
        ? sessionCheckpoints.filter((candidate) => candidate.createdAt <= sourceHandoff.createdAt).at(-1) ?? null
        : sourceWorkSession.checkpointRef === null
          ? null
          : sessionCheckpoints.find((candidate) => candidate.id === sourceWorkSession.checkpointRef) ?? null;
    if (input.checkpointId !== undefined && input.checkpointId !== null && sourceCheckpoint === null) {
      throw new Error("Checkpoint was not found.");
    }
    if (sourceHandoff !== null && sourceCheckpoint === null) {
      throw new Error("No checkpoint was available before this handoff.");
    }
    if (sourcePlan !== null && sourceCheckpoint === null) {
      throw new Error("The plan approval checkpoint was not found.");
    }
    const messageCutoff = sourcePlan?.approvedAt
      ?? sourceHandoff?.createdAt
      ?? (input.checkpointId === undefined || input.checkpointId === null ? null : sourceCheckpoint?.createdAt ?? null);
    const abandonedWindows = computeAbandonedHistoryWindows(sourceWorkSession, sessionCheckpoints, {
      fromCheckpointId: sourceCheckpoint?.id ?? null,
    });
    return {
      sourceWorkSession: { ...sourceWorkSession },
      sourceProject: { ...sourceProject },
      sourceRuntimeProfile: { ...sourceRuntimeProfile },
      sourceChatSession: { ...sourceChatSession },
      sourceCheckpoint: sourceCheckpoint === null ? null : { ...sourceCheckpoint },
      sourceHandoff: sourceHandoff === null ? null : { ...sourceHandoff },
      sourcePlan: sourcePlan === null ? null : { ...sourcePlan, planJson: { ...sourcePlan.planJson }, planMarkdown: sourcePlan.planMarkdown },
      messageCutoff,
      abandonedWindows,
      messages: db.chatMessages.filter((message) => message.chatSessionId === sourceChatSession.id).map((message) => ({ ...message })),
    };
  });

  const forkPath = await uniqueForkWorkspacePath(prepared.sourceProject.slug);
  const forkCurrentWorkspace = !hasExplicitCheckpoint && !hasExplicitHandoff && !hasExplicitPlan;
  if (forkCurrentWorkspace || prepared.sourceCheckpoint === null) {
    await copyCurrentWorkspace(prepared.sourceWorkSession.activeWorktreePath, forkPath.localRepoPath);
  } else {
    await materializeGitCheckpoint({
      workSessionId: prepared.sourceWorkSession.id,
      sourceWorkTree: prepared.sourceWorkSession.activeWorktreePath,
      targetWorkTree: forkPath.localRepoPath,
      commitHash: prepared.sourceCheckpoint.commitHash,
    });
  }

  const createdAt = currentTimestamp();
  const ids = {
    projectId: createId(),
    runtimeProfileId: createId(),
    chatSessionId: createId(),
    workSessionId: createId(),
    checkpointId: createId(),
  };
  const title = forkTitle(prepared.sourceChatSession.title, input.title);
  const copiedMessages = cloneChatMessages(
    prepared.messages,
    ids.chatSessionId,
    prepared.messageCutoff,
    prepared.abandonedWindows,
  );
  const latestCopiedUserMessage = [...copiedMessages].reverse().find((message) => message.role === "user") ?? null;

  const persisted = await mutateDatabase((db) => {
    if (db.projects.some((project) => project.slug === forkPath.slug)) {
      throw new Error(`Project slug already exists: ${forkPath.slug}`);
    }
    const project: ProjectRecord = {
      id: ids.projectId,
      ownerUserId: prepared.sourceProject.ownerUserId,
      name: title,
      slug: forkPath.slug,
      repoUrl: `local://${forkPath.slug}`,
      localRepoPath: forkPath.localRepoPath,
      defaultBranch: prepared.sourceProject.defaultBranch,
      trusted: prepared.sourceProject.trusted,
      workspaceSelection: {
        source: "generated",
        selectedAt: createdAt,
        selectedPath: forkPath.localRepoPath,
        riskLevel: "none",
        riskReasons: [],
        detectedStack: prepared.sourceProject.workspaceSelection.detectedStack,
        isEmpty: false,
      },
      createdAt,
    };
    const runtimeProfile: RuntimeProfileRecord = {
      id: ids.runtimeProfileId,
      projectId: ids.projectId,
      name: prepared.sourceRuntimeProfile.name,
      runtimeKind: prepared.sourceRuntimeProfile.runtimeKind,
      provider: config.agentProvider,
      model: config.codexModel,
      approvalPolicy: config.codexApprovalPolicy,
      sandboxMode: config.codexSandboxMode,
      writableRoots: [config.workspaceRoot, forkPath.localRepoPath],
      extraConfig: { ...prepared.sourceRuntimeProfile.extraConfig },
      createdAt,
    };
    const chatSession: ChatSessionRecord = {
      id: ids.chatSessionId,
      projectId: ids.projectId,
      title,
      status: prepared.sourceChatSession.status,
      createdBy: prepared.sourceChatSession.createdBy,
      createdAt,
      updatedAt: createdAt,
    };
    const clonedPlan: PlanRecord | null = prepared.sourcePlan === null
      ? null
      : createPlanRecord({
          workSessionId: ids.workSessionId,
          version: prepared.sourcePlan.version,
          title: prepared.sourcePlan.title,
          goal: prepared.sourcePlan.goal,
          status: "approved",
          planMarkdown: prepared.sourcePlan.planMarkdown,
          planJson: JSON.parse(JSON.stringify(prepared.sourcePlan.planJson)) as PlanRecord["planJson"],
          createdByAgent: prepared.sourcePlan.createdByAgent,
          approvedAt: createdAt,
          approvalCheckpointId: null,
        });
    const workSession: WorkSessionRecord = {
      id: ids.workSessionId,
      projectId: ids.projectId,
      chatSessionId: ids.chatSessionId,
      runtimeProfileId: ids.runtimeProfileId,
      currentState: clonedPlan === null
        ? copiedMessages.some((message) => message.role === "user") ? "completed" : "intake"
        : "executing",
      activeBranch: prepared.sourceWorkSession.activeBranch,
      activeWorktreePath: forkPath.localRepoPath,
      activePlanId: clonedPlan?.id ?? null,
      startedBy: prepared.sourceWorkSession.startedBy,
      startedAt: createdAt,
      updatedAt: createdAt,
      lastUserMessage: latestCopiedUserMessage?.content ?? "",
      deliveryKind: prepared.sourceWorkSession.deliveryKind,
      planModeEnabled: clonedPlan === null ? prepared.sourceWorkSession.planModeEnabled : false,
      executionMode: prepared.sourceWorkSession.executionMode,
      autonomyLevel: prepared.sourceWorkSession.autonomyLevel,
      paused: clonedPlan !== null,
      awaitingStep: false,
      nextActionLabel: null,
      pythonRunParams: prepared.sourceWorkSession.pythonRunParams,
      rRunParams: prepared.sourceWorkSession.rRunParams,
      agentProvider: prepared.sourceWorkSession.agentProvider,
      runtimeOverrides: prepared.sourceWorkSession.runtimeOverrides,
      runtimeUsage: null,
      claudeSessionId: null,
      codexThreadId: null,
      codexSubagents: [],
      codexCollabCalls: [],
      transcriptRef: null,
      steeringNote: prepared.sourceWorkSession.steeringNote,
      budget: prepared.sourceWorkSession.budget,
      lastProgress: null,
      checkpointRef: null,
      historyBaseCheckpointId: null,
      historyBaseCheckpointCreatedAt: null,
      historyRestoredAt: null,
      forkedFromWorkSessionId: prepared.sourceWorkSession.id,
      forkedFromCheckpointId: prepared.sourceCheckpoint?.id ?? null,
      forkedAt: createdAt,
    };
    updateWorkSessionTimestamp(workSession);
    db.projects.push(project);
    db.runtimeProfiles.push(runtimeProfile);
    db.chatSessions.push(chatSession);
    db.chatMessages.push(...copiedMessages);
    db.workSessions.push(workSession);
    if (clonedPlan !== null) {
      db.plans.push(clonedPlan);
      for (const [index, task] of clonedPlan.planJson.tasks.entries()) {
        db.tasks.push(createTaskRecord({
          planId: clonedPlan.id,
          parentTaskId: null,
          ordinal: index + 1,
          title: task.title,
          description: task.description,
          status: "todo",
          acceptanceCriteria: [...task.acceptanceCriteria],
          metadata: {
            objective: task.objective ?? task.description,
            taskKind: task.taskKind ?? "modify",
            targetFiles: task.targetFiles ?? [],
            expectedChanges: task.expectedChanges ?? [],
            verificationHints: task.verificationHints ?? [],
            riskLevel: task.riskLevel ?? "low",
          },
        }));
      }
    }
    return { project, runtimeProfile, chatSession, workSession };
  });

  let baselineCheckpoint: CheckpointRecord | null = null;
  if (config.checkpointsEnabled) {
    const gitCheckpoint = await createGitCheckpoint({
      workSessionId: persisted.workSession.id,
      workTree: persisted.workSession.activeWorktreePath,
      checkpointId: ids.checkpointId,
      message: [
        "orchestrator checkpoint fork baseline",
        `checkpoint=${ids.checkpointId}`,
        `forkedFromWorkSession=${prepared.sourceWorkSession.id}`,
        prepared.sourceCheckpoint === null ? "" : `forkedFromCheckpoint=${prepared.sourceCheckpoint.id}`,
        prepared.sourceHandoff === null ? "" : `forkedFromHandoff=${prepared.sourceHandoff.id}`,
      ].filter((entry) => entry.length > 0).join("\n\n"),
    });
    baselineCheckpoint = await mutateDatabase((db) => {
      const workSession = db.workSessions.find((candidate) => candidate.id === persisted.workSession.id);
      if (workSession === undefined) {
        throw new Error("Forked work session was not found.");
      }
      const checkpoint = createCheckpointRecord({
        id: ids.checkpointId,
        workSessionId: persisted.workSession.id,
        taskId: null,
        agentRunId: null,
        trigger: "baseline",
        status: "active",
        refName: gitCheckpoint.refName,
        commitHash: gitCheckpoint.commitHash,
        previousCheckpointId: null,
        restoredFromCheckpointId: prepared.sourceCheckpoint?.id ?? null,
        summary: prepared.sourceCheckpoint === null
          ? "Fork baseline from current workspace."
          : prepared.sourcePlan !== null
            ? "Fork baseline from approved plan."
          : prepared.sourceHandoff === null
            ? "Fork baseline from selected checkpoint."
            : "Fork baseline from handoff checkpoint.",
        filesChanged: gitCheckpoint.filesChanged,
        createdAt,
      });
      db.checkpoints.push(checkpoint);
      workSession.checkpointRef = checkpoint.id;
      if (prepared.sourcePlan !== null) {
        const plan = db.plans.find((candidate) => candidate.workSessionId === persisted.workSession.id && candidate.status === "approved");
        if (plan !== undefined) {
          plan.approvalCheckpointId = checkpoint.id;
        }
      }
      updateWorkSessionTimestamp(workSession);
      return { ...checkpoint };
    });
  }

  if (prepared.sourceWorkSession.codexThreadId !== null && prepared.sourcePlan === null) {
    const sourceTransport = resolveCodexTransport({ intent: "thread-control", workSession: prepared.sourceWorkSession });
    if (sourceTransport.primary === "exec") {
      await emitEvent({
        workSessionId: persisted.workSession.id,
        eventName: "task.progress",
        aggregateType: "work_session",
        aggregateId: persisted.workSession.id,
        priority: "low",
        payload: {
          message: "Forked workspace and app session without native Codex thread history because exec-only transport is selected.",
          sourceCodexThreadId: prepared.sourceWorkSession.codexThreadId,
          transportMode: sourceTransport.mode,
        },
      });
    } else {
      try {
        const forkedThreadId = await withCodexAppServerControl(forkPath.localRepoPath, async (client) => {
          const response = await client.request("thread/fork", {
            threadId: prepared.sourceWorkSession.codexThreadId,
            cwd: forkPath.localRepoPath,
            runtimeWorkspaceRoots: [forkPath.localRepoPath],
            approvalPolicy: config.codexApprovalPolicy,
            sandbox: config.codexSandboxMode,
            config: {
              web_search: "disabled",
              "features.image_generation": false,
              "features.apps": false,
              "features.browser_use": false,
              "features.plugins": false,
            },
          });
          const thread = typeof response.thread === "object" && response.thread !== null && !Array.isArray(response.thread)
            ? response.thread as Record<string, unknown>
            : null;
          return typeof thread?.id === "string" ? thread.id : null;
        });
        if (forkedThreadId !== null) {
          await mutateDatabase((db) => {
            const workSession = db.workSessions.find((candidate) => candidate.id === persisted.workSession.id);
            if (workSession !== undefined) {
              workSession.codexThreadId = forkedThreadId;
              workSession.forkedFromCodexThreadId = prepared.sourceWorkSession.codexThreadId;
              workSession.nativeCodexForkedAt = currentTimestamp();
              workSession.codexSubagents = [];
              workSession.codexCollabCalls = [];
              updateWorkSessionTimestamp(workSession);
            }
          });
          persisted.workSession.codexThreadId = forkedThreadId;
          persisted.workSession.forkedFromCodexThreadId = prepared.sourceWorkSession.codexThreadId;
          persisted.workSession.nativeCodexForkedAt = currentTimestamp();
        }
      } catch (error) {
        await emitEvent({
          workSessionId: persisted.workSession.id,
          eventName: "task.progress",
          aggregateType: "work_session",
          aggregateId: persisted.workSession.id,
          priority: "low",
          payload: {
            message: "Forked workspace and app session, but native Codex thread fork was not available.",
            sourceCodexThreadId: prepared.sourceWorkSession.codexThreadId,
            error: error instanceof Error ? error.message : "unknown error",
          },
        });
      }
    }
  }

  await emitEvent({
    workSessionId: persisted.workSession.id,
    eventName: "session.forked",
    aggregateType: "work_session",
    aggregateId: persisted.workSession.id,
    priority: "high",
    payload: {
      message: prepared.sourceHandoff !== null
        ? "Forked chat from handoff."
        : prepared.sourcePlan !== null
          ? "Forked chat from approved plan."
        : prepared.sourceCheckpoint === null
          ? "Forked chat from current workspace."
          : "Forked chat from checkpoint.",
      forkedFromWorkSessionId: prepared.sourceWorkSession.id,
      forkedFromCheckpointId: prepared.sourceCheckpoint?.id ?? "",
      forkedFromHandoffId: prepared.sourceHandoff?.id ?? "",
      forkedFromPlanId: prepared.sourcePlan?.id ?? "",
      forkedWorkspacePath: forkPath.localRepoPath,
      baselineCheckpointId: baselineCheckpoint?.id ?? "",
    } satisfies JsonObject,
  });
  await syncOrchestratorState(persisted.workSession.id);

  return {
    ...persisted,
    baselineCheckpoint,
    forkedFromWorkSessionId: prepared.sourceWorkSession.id,
    forkedFromCheckpointId: prepared.sourceCheckpoint?.id ?? null,
    forkedFromHandoffId: prepared.sourceHandoff?.id ?? null,
    forkedFromPlanId: prepared.sourcePlan?.id ?? null,
  };
}
