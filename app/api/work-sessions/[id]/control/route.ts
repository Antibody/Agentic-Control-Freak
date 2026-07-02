import { NextRequest, NextResponse } from "next/server";
import { currentTimestamp, getDatabaseSnapshot, markEnded, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { getConfig } from "@/lib/server/config";
import { scheduleControllerAdvance } from "@/lib/server/workflow-controller";
import { abortWorkSessionProcesses, activeProcessesForWorkSession, requestWorkSessionCompaction, steerWorkSessionProcess } from "@/lib/server/runtime/process-registry";
import { abortWorkSessionOperations, activeOperationsForWorkSession } from "@/lib/server/runtime/operation-registry";
import { compactClaudePersistedSession } from "@/lib/server/runtime/claude-code-adapter";
import { emitEvent } from "@/lib/server/events";
import { restoreCheckpointToTarget, restorePreviousCheckpoint, surgicallyRevertCheckpoint } from "@/lib/server/checkpoints";
import { logProcess } from "@/lib/server/logging";
import { selectableProviders, setWorkSessionProvider, setWorkSessionRuntime } from "@/lib/server/work-session-runtime-control";
import type { AgentProvider, AutonomyLevel, WorkSessionRecord } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

type ControlAction =
  | "pause"
  | "resume"
  | "step"
  | "abort"
  | "undo-last"
  | "restore-checkpoint"
  | "surgical-revert-checkpoint"
  | "apply-steering-now"
  | "cancel-steering"
  | "set-autonomy"
  | "set-runtime"
  | "set-provider"
  | "set-steering"
  | "set-plan-mode"
  | "compact-now";

interface ControlRequest {
  action: ControlAction;
  level?: AutonomyLevel;
  note?: string;
  runtime?: unknown;
  provider?: string;
  checkpointId?: string;
  enabled?: boolean;
}

const autonomyLevels: AutonomyLevel[] = ["manual", "checkpoint", "supervised", "full_auto"];
const abortableRunningStates = new Set<WorkSessionRecord["currentState"]>(["planning", "executing", "queued", "verifying"]);

function isControlRequest(value: unknown): value is ControlRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.action === "set-autonomy") {
    return typeof candidate.level === "string" && autonomyLevels.includes(candidate.level as AutonomyLevel);
  }
  if (candidate.action === "set-steering") {
    return typeof candidate.note === "string";
  }
  if (candidate.action === "set-runtime") {
    return typeof candidate.runtime === "object" && candidate.runtime !== null;
  }
  if (candidate.action === "set-provider") {
    return typeof candidate.provider === "string" && selectableProviders.includes(candidate.provider as AgentProvider);
  }
  if (candidate.action === "set-plan-mode") {
    return typeof candidate.enabled === "boolean";
  }
  if (candidate.action === "restore-checkpoint" || candidate.action === "surgical-revert-checkpoint") {
    return typeof candidate.checkpointId === "string" && candidate.checkpointId.trim().length > 0;
  }
  return (
    candidate.action === "pause" ||
    candidate.action === "resume" ||
    candidate.action === "step" ||
    candidate.action === "abort" ||
    candidate.action === "undo-last" ||
    candidate.action === "apply-steering-now" ||
    candidate.action === "cancel-steering" ||
    candidate.action === "compact-now"
  );
}

async function setSessionFlags(
  workSessionId: string,
  apply: (workSession: WorkSessionRecord) => void
): Promise<WorkSessionRecord> {
  return mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === workSessionId);
    if (workSession === undefined) {
      throw new Error("Work session was not found.");
    }
    apply(workSession);
    updateWorkSessionTimestamp(workSession);
    return { ...workSession };
  });
}

async function markWorkSessionCanceledForAbort(workSessionId: string): Promise<{ marked: boolean; previousState: string; state: string }> {
  return mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === workSessionId);
    if (workSession === undefined || !abortableRunningStates.has(workSession.currentState)) {
      return { marked: false, previousState: workSession?.currentState ?? "unknown", state: workSession?.currentState ?? "unknown" };
    }

    for (const verificationRun of db.verificationRuns) {
      if (verificationRun.workSessionId === workSessionId && verificationRun.status === "running") {
        verificationRun.status = "failed";
        verificationRun.failureKind = "environment_failure";
        verificationRun.summary = "Verification was canceled by the user.";
        verificationRun.rawOutput = [verificationRun.rawOutput, "Abort requested; durable session state was set to canceled."].filter((entry) => entry.trim().length > 0).join("\n---\n");
        markEnded(verificationRun);
      }
    }

    const previousState = workSession.currentState;
    workSession.currentState = "canceled";
    workSession.paused = false;
    workSession.awaitingStep = false;
    workSession.nextActionLabel = null;
    workSession.updatedAt = currentTimestamp();
    return { marked: true, previousState, state: workSession.currentState };
  });
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = (await request.json().catch(() => null)) as unknown;
    if (!isControlRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid control request." }, { status: 400 });
    }

    switch (body.action) {
      case "pause": {
        const workSession = await setSessionFlags(params.id, (session) => {
          session.paused = true;
        });
        const pausedOperations = abortWorkSessionOperations(params.id, "User requested pause.");
        if (pausedOperations > 0) {
          await emitEvent({
            workSessionId: params.id,
            eventName: "task.progress",
            aggregateType: "work_session",
            aggregateId: params.id,
            payload: { message: `Pause requested; stopped ${pausedOperations} active controller operation(s).` },
          });
        }
        return NextResponse.json({ ok: true, data: { action: "pause", state: workSession.currentState, paused: true, pausedOperations } });
      }
      case "set-autonomy": {
        const level = body.level as AutonomyLevel;
        const workSession = await setSessionFlags(params.id, (session) => {
          session.autonomyLevel = level;
          if (level === "full_auto") {
            session.awaitingStep = false;
            session.nextActionLabel = null;
          }
        });
        return NextResponse.json({
          ok: true,
          data: { action: "set-autonomy", autonomyLevel: workSession.autonomyLevel, state: workSession.currentState },
        });
      }
      case "set-steering": {
        const note = typeof body.note === "string" ? body.note.slice(0, 4000) : "";
        const workSession = await setSessionFlags(params.id, (session) => {
          session.steeringNote = note;
        });
        return NextResponse.json({ ok: true, data: { action: "set-steering", steeringNote: workSession.steeringNote } });
      }
      case "set-plan-mode": {
        const enabled = body.enabled === true;
        const workSession = await setSessionFlags(params.id, (session) => {
          session.planModeEnabled = enabled;
        });
        await emitEvent({
          workSessionId: params.id,
          eventName: "task.progress",
          aggregateType: "work_session",
          aggregateId: params.id,
          payload: { message: `Plan mode ${enabled ? "enabled" : "disabled"}.` },
        });
        return NextResponse.json({
          ok: true,
          data: { action: "set-plan-mode", planModeEnabled: workSession.planModeEnabled, state: workSession.currentState },
        });
      }
      case "set-runtime": {
        const result = await setWorkSessionRuntime(params.id, body.runtime);
        return NextResponse.json({
          ok: true,
          data: {
            action: "set-runtime",
            runtimeOverrides: result.runtimeOverrides,
            validationNote: result.validationNote,
          },
        });
      }
      case "set-provider": {
        const provider = body.provider as AgentProvider;
        const workSession = await setWorkSessionProvider(params.id, provider);
        return NextResponse.json({
          ok: true,
          data: { action: "set-provider", agentProvider: workSession.agentProvider, runtimeOverrides: workSession.runtimeOverrides },
        });
      }
      case "abort": {
        const canceled = await markWorkSessionCanceledForAbort(params.id);
        const abortedProcesses = abortWorkSessionProcesses(params.id);
        const abortedOperations = abortWorkSessionOperations(params.id);
        let aborted = abortedProcesses + abortedOperations;
        if (canceled.marked && aborted === 0) {
          aborted = 1;
        }
        if (canceled.marked) {
          await emitEvent({
            workSessionId: params.id,
            eventName: "session.canceled",
            aggregateType: "work_session",
            aggregateId: params.id,
            priority: "high",
            payload: {
              reason: "Abort requested by user.",
              previousState: canceled.previousState,
              message: "Session canceled by Abort.",
            },
          });
        }
        await emitEvent({
          workSessionId: params.id,
          eventName: "task.progress",
          aggregateType: "work_session",
          aggregateId: params.id,
          priority: "high",
          payload: {
            message: canceled.marked && abortedProcesses + abortedOperations === 0
              ? "Abort canceled the running session even though no live process or controller operation was registered."
              : aborted > 0
              ? `Abort requested for ${abortedProcesses} agent process(es) and ${abortedOperations} controller operation(s).`
              : "No running agent process or controller operation to abort.",
          },
        });
        return NextResponse.json({
          ok: true,
          data: {
            action: "abort",
            aborted,
            abortedProcesses,
            abortedOperations,
            canceled: canceled.marked,
            previousState: canceled.previousState,
          },
        });
      }
      case "compact-now": {
        const snapshot = await getDatabaseSnapshot();
        const workSession = snapshot.workSessions.find((candidate) => candidate.id === params.id);
        if (workSession === undefined) {
          return NextResponse.json({ ok: false, error: "Work session was not found." }, { status: 404 });
        }
        const config = getConfig();
        const provider = workSession.agentProvider ?? config.agentProvider;
        const activeProcesses = activeProcessesForWorkSession(params.id);
        if (provider === "claude-code") {
          if (!config.claudePersistentSessions) {
            return NextResponse.json({ ok: false, error: "Claude persistent sessions are disabled." }, { status: 409 });
          }
          if (workSession.claudeSessionId === null) {
            return NextResponse.json({ ok: false, error: "Claude has no persisted session to compact yet." }, { status: 409 });
          }
          if (activeProcesses.length > 0) {
            return NextResponse.json({ ok: false, error: "Claude context compaction is available between runs, not while a Claude process is active." }, { status: 409 });
          }
          const result = await compactClaudePersistedSession({ workSession, reason: "manual" });
          logProcess(result.ok ? "info" : "warn", "compaction.control.compact_now", {
            workSessionId: params.id,
            provider,
            liveRequested: 0,
            acted: result.ok,
            path: "claude-idle",
            sessionId: result.sessionId ?? "",
            exitCode: result.exitCode ?? -1,
            timedOut: result.timedOut,
            compactionMarkerSeen: result.compactionMarkerSeen,
          });
          if (!result.ok) {
            return NextResponse.json(
              { ok: false, error: result.message, data: { action: "compact-now", requested: result.requested ? 1 : 0, provider, path: "claude-idle" } },
              { status: 502 },
            );
          }
          return NextResponse.json({ ok: true, data: { action: "compact-now", requested: 1, provider, path: "claude-idle", compactionMarkerSeen: result.compactionMarkerSeen } });
        }

        const requested = requestWorkSessionCompaction(params.id, "manual");
        logProcess("info", "compaction.control.compact_now", {
          workSessionId: params.id,
          provider,
          liveRequested: requested,
          acted: requested > 0,
          path: requested > 0 ? "live" : "none",
        });
        await emitEvent({
          workSessionId: params.id,
          eventName: "runtime.compaction.started",
          aggregateType: "work_session",
          aggregateId: params.id,
          priority: requested > 0 ? "normal" : "low",
          payload: {
            message: requested > 0
              ? `Manual context compaction requested for ${requested} running agent(s).`
              : "Compact now requested, but there is no running agent to compact.",
            trigger: "manual",
            requested: String(requested),
          },
        });
        return NextResponse.json({ ok: true, data: { action: "compact-now", requested } });
      }
      case "undo-last": {
        const active = [...activeProcessesForWorkSession(params.id), ...activeOperationsForWorkSession(params.id)];
        if (active.length > 0) {
          return NextResponse.json({ ok: false, error: "Stop the running work before undoing changes." }, { status: 409 });
        }
        const result = await restorePreviousCheckpoint(params.id);
        return NextResponse.json({
          ok: true,
          data: {
            action: "undo-last",
            checkpointId: result.restoredCheckpoint.id,
            restoredFromCheckpointId: result.targetCheckpoint.id,
            safetyCheckpointId: result.safetyCheckpoint?.id ?? null,
          },
        });
      }
      case "restore-checkpoint": {
        const active = [...activeProcessesForWorkSession(params.id), ...activeOperationsForWorkSession(params.id)];
        if (active.length > 0) {
          return NextResponse.json({ ok: false, error: "Stop the running work before restoring a checkpoint." }, { status: 409 });
        }
        const checkpointId = typeof body.checkpointId === "string" ? body.checkpointId.trim() : "";
        const result = await restoreCheckpointToTarget({ workSessionId: params.id, checkpointId });
        return NextResponse.json({
          ok: true,
          data: {
            action: "restore-checkpoint",
            checkpointId: result.restoredCheckpoint.id,
            restoredFromCheckpointId: result.targetCheckpoint.id,
            safetyCheckpointId: result.safetyCheckpoint?.id ?? null,
          },
        });
      }
      case "surgical-revert-checkpoint": {
        const active = [...activeProcessesForWorkSession(params.id), ...activeOperationsForWorkSession(params.id)];
        if (active.length > 0) {
          return NextResponse.json({ ok: false, error: "Stop the running work before surgically reverting a checkpoint." }, { status: 409 });
        }
        const checkpointId = typeof body.checkpointId === "string" ? body.checkpointId.trim() : "";
        const result = await surgicallyRevertCheckpoint({ workSessionId: params.id, checkpointId });
        return NextResponse.json({
          ok: true,
          data: {
            action: "surgical-revert-checkpoint",
            checkpointId: result.revertCheckpoint.id,
            revertedCheckpointId: result.targetCheckpoint.id,
            baseCheckpointId: result.baseCheckpoint.id,
            safetyCheckpointId: result.safetyCheckpoint.id,
            patchArtifactId: result.patchArtifactId,
          },
        });
      }
      case "apply-steering-now": {
        const registryBefore = activeProcessesForWorkSession(params.id);
        const audit = await mutateDatabase((db) => {
          const pending = db.steeringMessages
            .filter((message) => message.workSessionId === params.id && message.status === "pending")
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            .map((message) => ({
              id: message.id,
              content: message.content,
              taskId: message.taskId,
              agentRunId: message.agentRunId,
              createdAt: message.createdAt,
            }));
          const runningRuns = db.agentRuns
            .filter((run) => run.workSessionId === params.id && (run.status === "running" || run.status === "waiting_approval"))
            .map((run) => ({ id: run.id, taskId: run.taskId, status: run.status, startedAt: run.startedAt }));
          const workSession = db.workSessions.find((session) => session.id === params.id);
          return {
            pendingCount: pending.length,
            pendingMessages: pending,
            pendingIds: pending.map((message) => message.id),
            runningRuns,
            currentState: workSession?.currentState ?? "",
            awaitingStep: workSession?.awaitingStep ?? false,
            paused: workSession?.paused ?? false,
          };
        });
        if (audit.pendingCount > 0) {
          const combinedContent = audit.pendingMessages
            .map((message, index) => `Queued steering ${index + 1} (${message.id}):\n${message.content}`)
            .join("\n\n")
            .slice(0, 16000);
          const liveSteer = await steerWorkSessionProcess(params.id, {
            steeringId: audit.pendingMessages[0].id,
            clientUserMessageId: audit.pendingMessages[0].id,
            content: combinedContent,
          });
          if (liveSteer.ok) {
            const appliedAt = currentTimestamp();
            await mutateDatabase((db) => {
              const ids = new Set(audit.pendingIds);
              for (const message of db.steeringMessages) {
                if (!ids.has(message.id) || message.status !== "pending") continue;
                message.status = "applied";
                message.applyMode = "live_steer_attempted";
                message.delivery = "live";
                message.appliedAt = appliedAt;
                message.codexThreadId = typeof liveSteer.data?.threadId === "string" ? liveSteer.data.threadId : message.codexThreadId ?? null;
                message.codexTurnId = typeof liveSteer.data?.turnId === "string" ? liveSteer.data.turnId : message.codexTurnId ?? null;
                message.failureReason = null;
              }
            });
            logProcess("info", "steering.apply_now.live_steer", {
              workSessionId: params.id,
              pendingCount: audit.pendingCount,
              pendingIds: audit.pendingIds.join(","),
              registryActiveCountBefore: registryBefore.length,
              threadId: typeof liveSteer.data?.threadId === "string" ? liveSteer.data.threadId : "",
              turnId: typeof liveSteer.data?.turnId === "string" ? liveSteer.data.turnId : "",
            });
            await emitEvent({
              workSessionId: params.id,
              eventName: "steering.apply_now_requested",
              aggregateType: "work_session",
              aggregateId: params.id,
              priority: "high",
              payload: {
                message: `Apply now sent ${audit.pendingCount} pending steering message(s) to the active Codex turn.`,
                pendingCount: String(audit.pendingCount),
                pendingIds: audit.pendingIds.join(","),
                delivery: "live",
              },
            });
            for (const message of audit.pendingMessages) {
              await emitEvent({
                workSessionId: params.id,
                eventName: "steering.applied",
                aggregateType: "steering_message",
                aggregateId: message.id,
                payload: {
                  message: "Sent queued steering to the active Codex turn.",
                  steeringId: message.id,
                  taskId: message.taskId ?? "",
                  agentRunId: message.agentRunId ?? "",
                  applyMode: "live_steer_attempted",
                  delivery: "live",
                  threadId: typeof liveSteer.data?.threadId === "string" ? liveSteer.data.threadId : "",
                  turnId: typeof liveSteer.data?.turnId === "string" ? liveSteer.data.turnId : "",
                },
                context: { taskId: message.taskId ?? undefined, agentRunId: message.agentRunId ?? undefined },
              });
            }
            return NextResponse.json({ ok: true, data: { action: "apply-steering-now", pendingCount: audit.pendingCount, liveSteered: audit.pendingCount, aborted: 0 } });
          }
          await mutateDatabase((db) => {
            const ids = new Set(audit.pendingIds);
            for (const message of db.steeringMessages) {
              if (!ids.has(message.id) || message.status !== "pending") continue;
              message.delivery = "queued";
              message.failureReason = liveSteer.message;
              message.applyMode = "restart_current_task";
            }
          });
        }
        logProcess("info", "steering.apply_now.audit_before_abort", {
          workSessionId: params.id,
          pendingCount: audit.pendingCount,
          pendingIds: audit.pendingIds.join(","),
          dbRunningRunIds: audit.runningRuns.map((run) => run.id).join(","),
          dbRunningTaskIds: audit.runningRuns.map((run) => run.taskId ?? "").join(","),
          registryActiveCount: registryBefore.length,
          registryAgentRunIds: registryBefore.map((run) => run.agentRunId).join(","),
          currentState: audit.currentState,
          paused: audit.paused,
          awaitingStep: audit.awaitingStep,
        });
        const aborted = audit.pendingCount > 0 ? abortWorkSessionProcesses(params.id, "steering") : 0;
        const registryAfter = activeProcessesForWorkSession(params.id);
        logProcess("info", "steering.apply_now.audit_after_abort", {
          workSessionId: params.id,
          pendingCount: audit.pendingCount,
          pendingIds: audit.pendingIds.join(","),
          aborted,
          registryActiveCountAfter: registryAfter.length,
          registryAgentRunIdsAfter: registryAfter.map((run) => run.agentRunId).join(","),
        });
        await emitEvent({
          workSessionId: params.id,
          eventName: "steering.apply_now_requested",
          aggregateType: "work_session",
          aggregateId: params.id,
          priority: "high",
          payload: {
            message: audit.pendingCount > 0
              ? `Apply now requested for ${audit.pendingCount} pending steering message(s).`
              : "Apply now requested but no pending steering messages exist.",
            pendingCount: String(audit.pendingCount),
            pendingIds: audit.pendingIds.join(","),
            aborted: String(aborted),
            registryActiveCountBefore: String(registryBefore.length),
            registryAgentRunIdsBefore: registryBefore.map((run) => run.agentRunId).join(","),
            dbRunningRunIds: audit.runningRuns.map((run) => run.id).join(","),
            currentState: audit.currentState,
          },
        });
        if (aborted === 0 && audit.pendingCount > 0) {
          scheduleControllerAdvance(params.id, "apply-steering-now-no-active-process");
        }
        return NextResponse.json({ ok: true, data: { action: "apply-steering-now", pendingCount: audit.pendingCount, aborted } });
      }
      case "cancel-steering": {
        const canceled = await mutateDatabase((db) => {
          let count = 0;
          for (const message of db.steeringMessages) {
            if (message.workSessionId === params.id && message.status === "pending") {
              message.status = "canceled";
              count += 1;
            }
          }
          return count;
        });
        await emitEvent({
          workSessionId: params.id,
          eventName: "steering.canceled",
          aggregateType: "work_session",
          aggregateId: params.id,
          payload: { message: `Canceled ${canceled} pending steering message(s).`, canceled: String(canceled) },
        });
        return NextResponse.json({ ok: true, data: { action: "cancel-steering", canceled } });
      }
      case "resume": {
        await setSessionFlags(params.id, (session) => {
          session.paused = false;
          session.awaitingStep = false;
          session.nextActionLabel = null;
        });
        scheduleControllerAdvance(params.id, "control-resume");
        return NextResponse.json({ ok: true, data: { workSessionId: params.id, state: "scheduled", steps: ["resume-background"] } });
      }
      case "step": {
        await setSessionFlags(params.id, (session) => {
          session.paused = false;
          session.awaitingStep = false;
          session.nextActionLabel = null;
        });
        scheduleControllerAdvance(params.id, "control-step", { trigger: "step" });
        return NextResponse.json({ ok: true, data: { workSessionId: params.id, state: "scheduled", steps: ["step-background"] } });
      }
      default: {
        return NextResponse.json({ ok: false, error: "Unsupported control action." }, { status: 400 });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown control error.";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
