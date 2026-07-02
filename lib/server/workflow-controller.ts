import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import {
  createAgentRunRecord,
  createApprovalRecord,
  createChatMessage,
  createCodeChangeRecord,
  createHandoffRecord,
  createPlanRecord,
  createSteeringMessageRecord,
  createTaskRecord,
  createVerificationRunRecord,
  currentTimestamp,
  getDatabaseSnapshot,
  markEnded,
  mutateDatabase,
  updateWorkSessionTimestamp,
} from "@/lib/server/db/file-db";
import { createSessionCheckpoint } from "@/lib/server/checkpoints";
import { emitEvent } from "@/lib/server/events";
import { logProcess } from "@/lib/server/logging";
import { boundedText, chatSummary } from "@/lib/server/text-bounds";
import { generatePlan } from "@/lib/server/planner";
import { planToMarkdown, validateAndNormalizeEditedPlan } from "@/lib/shared/plan";
import { analyzeWorkspace } from "@/lib/server/workspace-analysis";
import { executeWithCodexCli } from "@/lib/server/runtime/codex-adapter";
import { executeWithCodexAppServer, CodexAppServerStartupError } from "@/lib/server/runtime/codex-app-server-execution";
import { requestsNativeCodexSubagents } from "@/lib/server/runtime/codex-task-prompt";
import { resolveCodexTransport } from "@/lib/server/runtime/codex-transport";
import { steerWorkSessionProcess } from "@/lib/server/runtime/process-registry";
import { executeWithOllama } from "@/lib/server/runtime/ollama-adapter";
import { executeWithClaudeCode } from "@/lib/server/runtime/claude-code-adapter";
import { executeWithAgy } from "@/lib/server/runtime/agy-adapter";
import { isProviderExhaustionMessage, providerExhaustionRetryHint } from "@/lib/server/runtime/execution-result";
import { executeResearchWithAgy, executeResearchWithClaudeCode, executeResearchWithCodexCli, executeResearchWithOllama } from "@/lib/server/runtime/research-adapter";
import {
  isWorkSessionOperationAbortedError,
  registerWorkSessionOperation,
  WorkSessionOperationAbortedError,
  type WorkSessionOperationHandle,
} from "@/lib/server/runtime/operation-registry";
import { executeVerification } from "@/lib/server/verification";
import { runFunctionalVerification } from "@/lib/server/functional-verification";
import { capturePreviewSnapshot, type CapturePreviewSnapshotResult } from "@/lib/server/snapshot-capture";
import { installDependenciesForTask, syncWorkspaceManifestDependencies } from "@/lib/server/dependency-installer";
import { buildContinuityBlock, buildRetryAddendum } from "@/lib/server/dispatch-context";
import { researchDependenciesForApprovedPlan } from "@/lib/server/dependency-research";
import { saveArtifact } from "@/lib/server/artifacts";
import { prepareSkillsForPrompt } from "@/lib/server/skills/skill-prompt";
import { findLatestResearchContext, renderResearchContextForPrompt } from "@/lib/server/research-context";
import { syncOrchestratorState } from "@/lib/server/orchestrator-state";
import {
  appendTranscriptTurns,
  buildSwitchHandoffBrief,
  defaultTranscriptTurn,
  readTranscriptTurns,
  switchHandoffChatSummary,
} from "@/lib/server/transcripts";
import { extractProjectMemoryFromRun } from "@/lib/server/project-memory";
import {
  buildChatAttachmentRecords,
  imageAttachmentsForWorkSession,
  materializeChatAttachments,
  userRequestWithAttachmentBlock,
  type PendingMaterializedAttachment,
  type UploadedAttachment,
} from "@/lib/server/chat-attachments";
import { armPreviewIdleStopForWorkSession, clearPreviewIdleStopForWorkSession, startPreviewForWorkSession } from "@/lib/server/preview-manager";
import { stackCapabilities } from "@/lib/shared/stack-capabilities";
import { bootstrapWorkspaceIfNeeded, rescaffoldWorkspaceForStack } from "@/lib/server/workspace-bootstrap";
import { isAllowedTargetStack } from "@/lib/shared/stack-catalog";
import { createActiveHistoryFilter } from "@/lib/shared/history";
import { ensureWorkspaceAgentsMd } from "@/lib/server/runtime/agents-md";
import { decideVerificationTransition } from "@/lib/server/workflow-transitions";
import { assertSafeWorkspace, inspectWorkspaceSafety } from "@/lib/server/workspace-safety";
import type {
  AgentProvider,
  AgentRunRecord,
  AppDatabase,
  ChatAttachment,
  ChatSessionRecord,
  CheckpointRecord,
  CodeChangeRecord,
  Identifier,
  JsonObject,
  PlanJson,
  PlanRecord,
  PlanTaskKind,
  PreviewServerRecord,
  ProjectRecord,
  RiskLevel,
  RuntimeKind,
  RuntimeProfileRecord,
  SteeringApplyMode,
  ProjectStack,
  SteeringMessageRecord,
  TaskRecord,
  TranscriptTurnRecord,
  UserRecord,
  VerificationFailureKind,
  VerificationRunRecord,
  WorkSessionRecord,
} from "@/lib/shared/types";

import { maxAttemptsPerTask, maxRepairAttemptsPerSession, maxVerificationRepairsPerSession } from "@/lib/shared/loop-bounds";

const scheduledControllerRuns = new Set<Identifier>();
const runningControllerRuns = new Set<Identifier>();
const pendingControllerReruns = new Set<Identifier>();
const controllerLockStaleMs = 10 * 60 * 1000;
const controllerLockHeartbeatMs = 30 * 1000;

type GatedAction = "execute_task" | "run_verification";

async function executeCodexTask(input: { workSession: WorkSessionRecord; task: TaskRecord; agentRun: AgentRunRecord }) {
  const nativeSubagentsRequested = requestsNativeCodexSubagents({ workSession: input.workSession, task: input.task });
  const decision = resolveCodexTransport({
    intent: "execute",
    workSession: input.workSession,
    task: input.task,
    explicitNativeFeatureRequested: nativeSubagentsRequested,
  });
  if (decision.primary === "exec") {
    if (nativeSubagentsRequested) {
      await emitEvent({
        workSessionId: input.workSession.id,
        eventName: "task.progress",
        aggregateType: "agent_run",
        aggregateId: input.agentRun.id,
        payload: {
          message: "Codex exec-only transport is selected; native subagent thread UI will not be available for this run.",
          transportMode: decision.mode,
          transportPrimary: decision.primary,
          transportReason: decision.reason,
        },
        priority: "high",
        producer: { module: "workflow-controller", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
        context: { taskId: input.task.id, agentRunId: input.agentRun.id },
      });
    }
    return executeWithCodexCli(input);
  }
  try {
    return await executeWithCodexAppServer({ ...input, transportDecision: decision });
  } catch (error) {
    if (error instanceof CodexAppServerStartupError && decision.fallback === "exec") {
      logProcess("warn", "codex.appserver.fallback_to_exec", {
        workSessionId: input.workSession.id,
        taskId: input.task.id,
        agentRunId: input.agentRun.id,
        error: error.message,
      });
      await emitEvent({
        workSessionId: input.workSession.id,
        eventName: "task.progress",
        aggregateType: "agent_run",
        aggregateId: input.agentRun.id,
        payload: {
          message: `Codex app-server startup failed before a turn started; falling back to codex exec. ${error.message}`,
          transportMode: decision.mode,
          transportPrimary: decision.primary,
          transportFallback: decision.fallback,
          transportReason: decision.reason,
        },
        priority: "high",
        producer: { module: "workflow-controller", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
        context: { taskId: input.task.id, agentRunId: input.agentRun.id },
      });
      return executeWithCodexCli(input);
    }
    throw error;
  }
}

function runtimeKindForProvider(provider: AgentProvider): RuntimeKind {
  if (provider === "ollama") return "ollama";
  if (provider === "claude-code") return "claude";
  if (provider === "antigravity-cli") return "antigravity";
  return "codex";
}

interface TaskExecutionResult {
  status: "completed" | "failed" | "approval_required";
  agentRun: AgentRunRecord;
  summary: string;
  failureKind?: "runtime_failure" | "timeout" | "aborted" | "interrupted_by_user_steering" | "environment_failure" | "provider_exhausted" | "max_turns_exhausted";
  timedOut?: boolean;
  logArtifactId?: Identifier;
  rawOutputBytes?: number;
  codeChangeCount: number;
  continuationRecommended?: boolean;
  checkpointId?: Identifier | null;
}

interface RenderVerificationGateResult {
  verification: VerificationRunRecord;
  preview: PreviewServerRecord | null;
  snapshotEvidence: CapturePreviewSnapshotResult | null;
  runtimeStructural: Awaited<ReturnType<typeof runFunctionalVerification>> | null;
}

interface ResearchSessionResult {
  status: "completed" | "failed";
  agentRun: AgentRunRecord;
  summary: string;
  reportArtifactId: Identifier | null;
  logArtifactId: Identifier | null;
  rawOutputBytes: number;
}

export function scheduleControllerAdvance(workSessionId: Identifier, reason = "background", options: { trigger?: "auto" | "step" } = {}): void {
  if (runningControllerRuns.has(workSessionId)) {
    pendingControllerReruns.add(workSessionId);
    logProcess("info", "controller.advance.background.deferred", { workSessionId, reason, runningNow: true });
    return;
  }
  if (scheduledControllerRuns.has(workSessionId)) {
    logProcess("info", "controller.advance.background.skipped", { workSessionId, reason, alreadyScheduled: true });
    return;
  }
  scheduledControllerRuns.add(workSessionId);
  logProcess("info", "controller.advance.background.scheduled", { workSessionId, reason });
  setTimeout(() => {
    scheduledControllerRuns.delete(workSessionId);
    void advanceController(workSessionId, options).catch(async (error) => {
      const message = error instanceof Error ? error.message : "unknown controller error";
      logProcess("error", "controller.advance.background.failed", { workSessionId, reason, message });
      await emitEvent({
        workSessionId,
        eventName: "task.progress",
        aggregateType: "work_session",
        aggregateId: workSessionId,
        priority: "high",
        payload: {
          message: `Background controller advance failed: ${message}`,
          reason,
          mode: "controller_background_failure",
        },
        producer: { module: "workflow-controller" },
      }).catch(() => undefined);
    });
  }, 0);
}

const controllerWatchdogIntervalMs = 45_000;
const controllerWatchdogStaleMs = 60_000;
const controllerWatchdogStates = new Set<string>(["queued", "planning", "executing", "verifying"]);

async function runControllerWatchdogSweep(): Promise<void> {
  try {
    const db = await getDatabaseSnapshot();
    const now = Date.now();
    for (const workSession of db.workSessions) {
      if (!controllerWatchdogStates.has(workSession.currentState) || workSession.paused || workSession.awaitingStep) {
        continue;
      }
      if (runningControllerRuns.has(workSession.id) || scheduledControllerRuns.has(workSession.id)) {
        continue;
      }
      const updatedAtMs = Date.parse(workSession.updatedAt);
      if (Number.isFinite(updatedAtMs) && now - updatedAtMs < controllerWatchdogStaleMs) {
        continue;
      }
      logProcess("warn", "controller.watchdog.recovery", {
        workSessionId: workSession.id,
        state: workSession.currentState,
        idleMs: Number.isFinite(updatedAtMs) ? now - updatedAtMs : -1,
      });
      scheduleControllerAdvance(workSession.id, "watchdog-recovery");
    }
  } catch (error) {
    logProcess("error", "controller.watchdog.failed", {
      message: error instanceof Error ? error.message : "unknown watchdog error",
    });
  }
}

function armControllerWatchdog(): void {
  const holder = globalThis as unknown as Record<string, unknown>;
  const key = "__closedDevLoopControllerWatchdog";
  if (holder[key] !== undefined) {
    return;
  }
  const interval = setInterval(() => {
    void runControllerWatchdogSweep();
  }, controllerWatchdogIntervalMs);
  interval.unref?.();
  holder[key] = interval;
  logProcess("info", "controller.watchdog.armed", { intervalMs: controllerWatchdogIntervalMs });
}

armControllerWatchdog();

function safeLockSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "session";
}

function controllerLockPath(workSessionId: Identifier): string {
  const config = getConfig();
  return path.join(path.dirname(config.dbFile), "locks", `controller-${safeLockSegment(workSessionId)}.lock`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      return (error as { code?: unknown }).code === "EPERM";
    }
    return false;
  }
}

async function readControllerLockPid(lockPath: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function acquireControllerFileLock(workSessionId: Identifier): Promise<{ release: () => Promise<void> } | null> {
  const lockPath = controllerLockPath(workSessionId);
  await mkdir(path.dirname(lockPath), { recursive: true });
  let staleRemoved = false;
  for (;;) {
    let handle: FileHandle | null = null;
    try {
      handle = await open(lockPath, "wx");
      const heartbeat = setInterval(() => {
        void handle?.utimes(new Date(), new Date()).catch(() => undefined);
      }, controllerLockHeartbeatMs);
      await handle.writeFile(JSON.stringify({ workSessionId, pid: process.pid, acquiredAt: new Date().toISOString() }));
      return {
        release: async () => {
          clearInterval(heartbeat);
          await handle?.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
        },
      };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") {
        throw error;
      }
      if (!staleRemoved) {
        const lockPid = await readControllerLockPid(lockPath);
        if (lockPid !== null && lockPid !== process.pid && !processIsAlive(lockPid)) {
          staleRemoved = true;
          logProcess("warn", "controller.advance.file_lock.dead_pid_removed", {
            workSessionId,
            lockPath,
            pid: lockPid,
          });
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        const lockStat = await stat(lockPath).catch(() => null);
        if (lockStat !== null && Date.now() - lockStat.mtimeMs > controllerLockStaleMs) {
          staleRemoved = true;
          logProcess("warn", "controller.advance.file_lock.stale_removed", {
            workSessionId,
            lockPath,
            ageMs: Date.now() - lockStat.mtimeMs,
          });
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      }
      return null;
    }
  }
}

function actionIsGated(level: WorkSessionRecord["autonomyLevel"], action: GatedAction, task: TaskRecord | null): boolean {
  if (level === "full_auto" || level === "supervised") {
    return false;
  }
  if (level === "manual") {
    return true;
  }
  if (action === "run_verification") {
    return true;
  }
  const risk = task?.metadata.riskLevel;
  return risk === "medium" || risk === "high";
}

async function setAwaitingStep(workSessionId: Identifier, nextActionLabel: string): Promise<void> {
  await mutateDatabase((db) => {
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
    workSession.awaitingStep = true;
    workSession.nextActionLabel = nextActionLabel;
    updateWorkSessionTimestamp(workSession);
  });
  await emitEvent({
    workSessionId,
    eventName: "task.progress",
    aggregateType: "work_session",
    aggregateId: workSessionId,
    payload: { message: `Paused for your step: ${nextActionLabel}` },
  });
  await mirrorWorkSessionState(workSessionId);
}

async function clearAwaitingStep(workSessionId: Identifier): Promise<void> {
  await mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === workSessionId);
    if (workSession !== undefined && (workSession.awaitingStep || workSession.nextActionLabel !== null)) {
      workSession.awaitingStep = false;
      workSession.nextActionLabel = null;
    }
  });
}

async function currentControllerResult(workSessionId: Identifier, step: string): Promise<ControllerResult> {
  const db = await getDatabaseSnapshot();
  const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
  const chatSession = findRequired(db.chatSessions, (candidate) => candidate.id === workSession.chatSessionId, "Chat session");
  return {
    workSessionId,
    chatSessionId: chatSession.id,
    state: workSession.currentState,
    steps: [step],
  };
}

export interface ControllerResult {
  workSessionId: Identifier;
  chatSessionId: Identifier;
  state: string;
  steps: string[];
}

export class PlanValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join(" "));
    this.name = "PlanValidationError";
    this.errors = errors;
  }
}

export class PlanNotEditableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanNotEditableError";
  }
}

function findRequired<T>(items: T[], predicate: (item: T) => boolean, label: string): T {
  const found = items.find(predicate);
  if (found === undefined) {
    throw new Error(`${label} was not found.`);
  }
  return found;
}

function shouldClarify(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (normalized.length < 12) {
    return true;
  }
  const vagueMessages = ["do it", "fix it", "make it better", "continue", "improve app", "update app"];
  return vagueMessages.includes(normalized);
}

function classifyMessage(message: string): "cancel" | "resume" | "handoff" | "explain" | "new-work" {
  const normalized = message.trim().toLowerCase().replace(/\s+/g, " ");
  const commandCandidate = normalized.replace(/[.!?]+$/g, "");
  const isShortCommand = commandCandidate.length > 0 && commandCandidate.length < 40;
  const isCommand = (word: string): boolean =>
    isShortCommand && (commandCandidate === word || commandCandidate.startsWith(`${word} `));
  const isPhraseCommand = (phrase: string): boolean =>
    isShortCommand && (commandCandidate === phrase || commandCandidate.startsWith(`${phrase} `));

  if (isCommand("cancel") || isCommand("stop")) {
    return "cancel";
  }
  if (isCommand("resume") || isCommand("continue")) {
    return "resume";
  }
  if (isCommand("handoff") || isPhraseCommand("create handoff") || isPhraseCommand("summarize current")) {
    return "handoff";
  }
  if (isCommand("why") || isCommand("explain")) {
    return "explain";
  }
  return "new-work";
}

function classifyDeliveryKind(message: string): WorkSessionRecord["deliveryKind"] {
  const normalized = message.trim().toLowerCase().replace(/\s+/g, " ");
  const asksForFileWrite =
    /\b(write|create|save|generate)\s+(?:a\s+)?(?:file\s+)?(?:[\w.-]+\/)*[\w.-]+\.(?:md|txt|json|csv|html|tsx?|jsx?|py|css)\b/.test(normalized) ||
    /\b(write|create|save|generate)\b.*\b(?:report|summary|analysis)\.(?:md|txt)\b/.test(normalized);
  if (asksForFileWrite) {
    return "implementation";
  }

  const researchIntent =
    /\b(research|investigate|analy[sz]e|audit|assess|evaluate|summari[sz]e|explain|map|document|report|review)\b/.test(normalized) ||
    /\b(how does|what does|what is|architecture|codebase overview|repo overview)\b/.test(normalized);
  const codeChangeIntent =
    /\b(build|implement|fix|change|modify|update|add|scaffold|refactor|wire|style|start|run|preview|deploy|make|redesign|rework|convert|turn|send|show)\b/.test(normalized) ||
    /\b(page|pages|route|routes|navigation|form|backend|frontend|api|endpoint|email|emails|database|map page|contact page|subagent|subagents)\b/.test(normalized);
  const createImplementationIntent =
    /\bcreate\b/.test(normalized) &&
    !/\b(create|write|produce|generate)\s+(?:a\s+|an\s+|the\s+)?(?:research\s+)?(?:report|summary|analysis|overview|audit|review)\b/.test(normalized);
  const mlImplementationIntent =
    getConfig().mlPipelineEnabled &&
    /\b(train|re-?train|fine[-\s]?tune|finetune|pre[-\s]?train|pretrain|quantize|distill)\b/.test(normalized);
  const implementationIntent = codeChangeIntent || createImplementationIntent || mlImplementationIntent;
  const explicitResearchOnly =
    /\b(read-only|no code changes|without changing|do not edit|don't edit|research only|report only)\b/.test(normalized);

  if (explicitResearchOnly || (researchIntent && !implementationIntent)) {
    return "research";
  }
  return "implementation";
}

function hasDocumentLikeAttachments(attachments: UploadedAttachment[]): boolean {
  return attachments.some((attachment) => attachment.kind !== "image");
}

function hasExplicitImplementationRequest(message: string): boolean {
  const normalized = message.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    /\b(generate|create|build|implement|code|develop|make|scaffold|write|add|update|change|modify|fix|refactor|wire|style)\b/.test(normalized) ||
    /\b(turn|convert)\b.*\b(into|to)\b.*\b(app|site|website|page|component|dashboard|tool|script|code|project)\b/.test(normalized)
  );
}

function classifyDeliveryKindForInput(message: string, attachments: UploadedAttachment[]): WorkSessionRecord["deliveryKind"] {
  if (hasDocumentLikeAttachments(attachments) && !hasExplicitImplementationRequest(message)) {
    return "research";
  }
  return classifyDeliveryKind(message);
}

function latestPlanForSession(db: AppDatabase, workSessionId: Identifier): PlanRecord | null {
  const plans = db.plans.filter((plan) => plan.workSessionId === workSessionId);
  const workSession = db.workSessions.find((candidate) => candidate.id === workSessionId);
  if (workSession?.activePlanId !== null && workSession?.activePlanId !== undefined) {
    const activePlan = plans.find((plan) => plan.id === workSession.activePlanId);
    if (activePlan !== undefined && activePlan.status !== "superseded" && activePlan.status !== "canceled") {
      return activePlan;
    }
  }
  return plans
    .filter((plan) => plan.status !== "superseded" && plan.status !== "canceled")
    .sort((a, b) => b.version - a.version)[0] ?? null;
}

function tasksForPlan(db: AppDatabase, planId: Identifier): TaskRecord[] {
  return db.tasks.filter((task) => task.planId === planId).sort((a, b) => a.ordinal - b.ordinal);
}

function isRunnableTask(task: TaskRecord): boolean {
  return task.status === "todo" || task.status === "in_progress";
}

function isRepairTask(task: TaskRecord): boolean {
  return (
    typeof task.metadata.repairForTaskId === "string" ||
    typeof task.metadata.repairForVerificationRunId === "string" ||
    typeof task.metadata.repairForPreviewId === "string"
  );
}

function getNextRunnableTask(db: AppDatabase, planId: Identifier): TaskRecord | null {
  const runnable = tasksForPlan(db, planId).filter(isRunnableTask);
  return runnable.find(isRepairTask) ?? runnable[0] ?? null;
}

function executionRepairRootTask(tasks: TaskRecord[], task: TaskRecord): TaskRecord {
  let current = task;
  const visited = new Set<Identifier>();
  while (typeof current.metadata.repairForTaskId === "string" && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = tasks.find((candidate) => candidate.id === current.metadata.repairForTaskId);
    if (parent === undefined) {
      break;
    }
    current = parent;
  }
  return current;
}

function isExecutionRepairForRoot(tasks: TaskRecord[], task: TaskRecord, rootTaskId: Identifier): boolean {
  if (typeof task.metadata.repairForTaskId !== "string") {
    return false;
  }
  return executionRepairRootTask(tasks, task).id === rootTaskId;
}

function executionFailureRepairability(result: TaskExecutionResult): { repairable: boolean; reason: string } {
  if (result.failureKind === "environment_failure") {
    return {
      repairable: false,
      reason: "Task execution failed because of an environment or control-plane storage problem. The orchestrator will not queue a code repair for this failure kind.",
    };
  }

  if (result.failureKind === "aborted") {
    return {
      repairable: false,
      reason: "Task execution was aborted. The orchestrator will not queue a code repair for an aborted run.",
    };
  }

  if (result.codeChangeCount <= 0 && result.continuationRecommended !== true) {
    return {
      repairable: false,
      reason: "Task execution failed before producing any captured file changes. There is no generated-app delta to repair automatically; this should be handled as a provider/runtime, prompt, or workspace issue.",
    };
  }

  return { repairable: true, reason: "Task execution produced captured file changes, so a bounded repair task can inspect and continue from that partial progress." };
}

function hasPendingSteering(db: AppDatabase, workSessionId: Identifier): boolean {
  return db.steeringMessages.some((message) => message.workSessionId === workSessionId && message.status === "pending");
}

function runningAgentForSession(db: AppDatabase, workSessionId: Identifier): AgentRunRecord | null {
  return (
    db.agentRuns
      .filter((run) => run.workSessionId === workSessionId && (run.status === "running" || run.status === "waiting_approval"))
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null
  );
}

function shouldRouteMessageAsSteering(db: AppDatabase, workSession: WorkSessionRecord, intent: ReturnType<typeof classifyMessage>): boolean {
  if (intent !== "new-work") {
    return false;
  }
  if (workSession.currentState !== "executing" && workSession.currentState !== "queued") {
    return false;
  }
  const activeRun = runningAgentForSession(db, workSession.id);
  if (activeRun === null) {
    return false;
  }
  const plan = latestPlanForSession(db, workSession.id);
  return plan !== null && plan.status === "approved";
}

function pendingSteeringMessagesForSession(db: AppDatabase, workSessionId: Identifier): SteeringMessageRecord[] {
  return db.steeringMessages
    .filter((message) => message.workSessionId === workSessionId && message.status === "pending")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function steeringContentExcerpt(content: string): string {
  return chatSummary(content).slice(0, 500);
}

async function emitSteeringEvent(input: {
  workSessionId: Identifier;
  eventName: "steering.received" | "steering.queued" | "steering.applied" | "steering.canceled" | "steering.apply_now_requested";
  steeringId: Identifier;
  taskId?: Identifier | null;
  agentRunId?: Identifier | null;
  message: string;
  applyMode?: SteeringApplyMode;
  extra?: JsonObject;
}): Promise<void> {
  await emitEvent({
    workSessionId: input.workSessionId,
    eventName: input.eventName,
    aggregateType: "steering_message",
    aggregateId: input.steeringId,
    payload: {
      message: input.message,
      steeringId: input.steeringId,
      taskId: input.taskId ?? "",
      agentRunId: input.agentRunId ?? "",
      applyMode: input.applyMode ?? "",
      ...(input.extra ?? {}),
    },
    context: { taskId: input.taskId ?? undefined, agentRunId: input.agentRunId ?? undefined },
  });
}

async function applyPendingSteeringToTask(input: {
  workSessionId: Identifier;
  taskId: Identifier;
  applyMode: SteeringApplyMode;
}): Promise<{ applied: SteeringMessageRecord[]; task: TaskRecord }> {
  const result = await mutateDatabase((db) => {
    const allPending = pendingSteeringMessagesForSession(db, input.workSessionId);
    const pending = allPending.slice(0, 5);
    const task = findRequired(db.tasks, (candidate) => candidate.id === input.taskId, "Task");
    logProcess("info", "steering.apply.checkpoint", {
      workSessionId: input.workSessionId,
      taskId: input.taskId,
      requestedApplyMode: input.applyMode,
      taskTitle: task.title,
      taskStatus: task.status,
      pendingCount: allPending.length,
      pendingIds: allPending.map((message) => message.id).join(","),
      cappedApplyCount: pending.length,
    });
    if (pending.length === 0) {
      return { applied: [], task: { ...task, metadata: { ...task.metadata } } };
    }
    const effectiveApplyMode = pending.some((message) => message.applyMode === "restart_current_task")
      ? "restart_current_task"
      : input.applyMode;

    const existing = Array.isArray(task.metadata.appliedSteeringMessages)
      ? task.metadata.appliedSteeringMessages.filter((entry): entry is JsonObject => typeof entry === "object" && entry !== null && !Array.isArray(entry))
      : [];
    const steeringEntries = pending.map((message) => ({
      id: message.id,
      content: message.content,
      createdAt: message.createdAt,
      applyMode: effectiveApplyMode,
    }));
    task.metadata.appliedSteeringMessages = [...existing, ...steeringEntries];
    const now = currentTimestamp();
    for (const message of pending) {
      message.status = "applied";
      message.taskId = input.taskId;
      message.applyMode = effectiveApplyMode;
      message.appliedAt = now;
    }
    return {
      applied: pending.map((message) => ({ ...message })),
      task: { ...task, metadata: { ...task.metadata } },
    };
  });

  logProcess("info", "steering.apply.result", {
    workSessionId: input.workSessionId,
    taskId: input.taskId,
    taskTitle: result.task.title,
    appliedCount: result.applied.length,
    appliedIds: result.applied.map((message) => message.id).join(","),
    applyModes: Array.from(new Set(result.applied.map((message) => message.applyMode))).join(","),
    contentExcerpts: result.applied.map((message) => steeringContentExcerpt(message.content)),
  });

  for (const message of result.applied) {
    await emitSteeringEvent({
      workSessionId: input.workSessionId,
      eventName: "steering.applied",
      steeringId: message.id,
      taskId: input.taskId,
      agentRunId: message.agentRunId,
      message: `Applied queued steering to task '${result.task.title}'.`,
      applyMode: message.applyMode,
    });
  }
  if (result.applied.length > 0) {
    await mirrorWorkSessionState(input.workSessionId);
  }
  return result;
}

async function createFollowUpTaskForPendingSteering(input: {
  workSessionId: Identifier;
  plan: PlanRecord;
}): Promise<TaskRecord | null> {
  const pendingExists = await mutateDatabase((db) => hasPendingSteering(db, input.workSessionId));
  if (!pendingExists) {
    return null;
  }
  const task = await mutateDatabase((db) => {
    const tasks = tasksForPlan(db, input.plan.id);
    const pending = db.steeringMessages.filter((message) => message.workSessionId === input.workSessionId && message.status === "pending");
    if (pending.length === 0) {
      return null;
    }
    const record = createTaskRecord({
      planId: input.plan.id,
      parentTaskId: tasks[tasks.length - 1]?.id ?? null,
      ordinal: tasks.length + 1,
      title: "Apply queued user steering",
      description: `Apply the user's queued steering messages to the generated work before verification.\n\n${pending.map((message) => `- ${message.content}`).join("\n")}`,
      status: "todo",
      acceptanceCriteria: [
        "The queued user steering has been reflected in the generated workspace.",
        "Existing useful completed work is preserved unless it conflicts with the steering.",
      ],
      metadata: {
        objective: "Apply queued user steering before final verification.",
        taskKind: "modify",
        targetFiles: [],
        expectedChanges: ["Update the smallest relevant files to honor queued steering."],
        verificationHints: input.plan.planJson.verificationCommands,
        riskLevel: "medium",
        createdForPendingSteering: "true",
      },
    });
    db.tasks.push(record);
    return record;
  });
  if (task === null) {
    return null;
  }
  await emitEvent({
    workSessionId: input.workSessionId,
    eventName: "task.queued",
    aggregateType: "task",
    aggregateId: task.id,
    payload: { title: task.title, reason: "Queued user steering exists after planned tasks completed." },
    context: { planId: input.plan.id, taskId: task.id },
  });
  await applyPendingSteeringToTask({ workSessionId: input.workSessionId, taskId: task.id, applyMode: "next_boundary" });
  return task;
}

function directFollowUpTitle(content: string): string {
  const title = titleFromMessage(content);
  return title.length > 0 ? `Follow up: ${title}` : "Follow up on approved plan";
}

function attachmentSummaryForTask(attachments: ChatAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }
  return `\n\nAttached context:\n${attachments.map((attachment) => `- ${attachment.originalName} (${attachment.kind})`).join("\n")}`;
}

function createDirectFollowUpTask(input: {
  db: AppDatabase;
  workSession: WorkSessionRecord;
  plan: PlanRecord;
  content: string;
  attachments: ChatAttachment[];
}): TaskRecord {
  const tasks = tasksForPlan(input.db, input.plan.id);
  const parent = tasks[tasks.length - 1] ?? null;
  const description = `Apply this user follow-up directly to the already approved plan. Plan mode is off, so do not create a new plan or ask for plan approval.\n\nUser follow-up:\n${input.content}${attachmentSummaryForTask(input.attachments)}`;
  const task = createTaskRecord({
    planId: input.plan.id,
    parentTaskId: parent?.id ?? null,
    ordinal: tasks.length + 1,
    title: directFollowUpTitle(input.content),
    description,
    status: "todo",
    acceptanceCriteria: [
      "The follow-up request is reflected in the generated workspace.",
      "Existing useful completed work is preserved unless it conflicts with the follow-up.",
      "The implementation remains scoped to the current project workspace.",
    ],
    metadata: {
      objective: `Apply the user's follow-up request directly: ${chatSummary(input.content)}`,
      taskKind: "modify",
      targetFiles: [],
      expectedChanges: ["Update the smallest relevant files needed for the follow-up request."],
      verificationHints: input.plan.planJson.verificationCommands,
      riskLevel: "medium",
      createdWithPlanModeOff: "true",
    },
  });
  input.db.tasks.push(task);
  if (input.plan.status === "completed") {
    input.plan.status = "approved";
  }
  input.workSession.activePlanId = input.plan.id;
  input.workSession.currentState = "executing";
  return task;
}

function chooseExecutionMode(): "single-owner" | "parallel" {
  return "single-owner";
}

function titleFromMessage(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 56 ? `${normalized.slice(0, 53).trimEnd()}...` : normalized;
}

function shouldRenameChatSession(title: string): boolean {
  return title === "Closed Dev Loop Chat" || /^Project \d+ Chat$/.test(title);
}

async function addAssistantMessage(
  chatSessionId: Identifier,
  content: string,
  relatedEventId: Identifier | null = null,
  options: { maxChars?: number | null; messageKind?: string } = {}
): Promise<void> {
  const boundedContent = options.maxChars === null
    ? content
    : options.maxChars === undefined ? chatSummary(content) : boundedText(content, options.maxChars);
  await mutateDatabase((db) => {
    db.chatMessages.push(
      createChatMessage({
        chatSessionId,
        role: "assistant",
        content: boundedContent,
        messageKind: options.messageKind ?? "chat",
        relatedEventId,
      })
    );
    const chatSession = db.chatSessions.find((session) => session.id === chatSessionId);
    if (chatSession !== undefined) {
      chatSession.updatedAt = currentTimestamp();
    }
  });
}

async function mirrorWorkSessionState(workSessionId: Identifier): Promise<void> {
  try {
    await syncOrchestratorState(workSessionId);
  } catch (error) {
    console.warn("Unable to sync .orchestrator state", error);
  }
}

async function transitionWorkSession(workSessionId: Identifier, state: WorkSessionRecord["currentState"]): Promise<void> {
  await mutateDatabase((db) => {
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
    if (workSession.currentState === "canceled" && state !== "canceled") {
      return;
    }
    workSession.currentState = state;
    updateWorkSessionTimestamp(workSession);
  });
  await mirrorWorkSessionState(workSessionId);
}

async function blockUnsafeWorkspaceIfNeeded(input: {
  workSession: WorkSessionRecord;
  project: ProjectRecord;
  chatSessionId: Identifier;
}): Promise<boolean> {
  if (input.workSession.deliveryKind === "research") {
    return false;
  }
  const report = await inspectWorkspaceSafety(input.workSession.activeWorktreePath, {
    source: input.project.workspaceSelection.source,
    operation: "controller execution",
  });
  if (report.safe) {
    return false;
  }
  const reason = `Unsafe workspace blocked: ${report.workspacePath}. ${report.reasons.join(" ")}`;
  await mutateDatabase((db) => {
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === input.workSession.id, "Work session");
    workSession.currentState = "blocked";
    workSession.paused = false;
    workSession.awaitingStep = false;
    workSession.nextActionLabel = null;
    updateWorkSessionTimestamp(workSession);
  });
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "workspace.safety.blocked",
    aggregateType: "work_session",
    aggregateId: input.workSession.id,
    payload: {
      reason,
      workspacePath: report.workspacePath,
      reasons: report.reasons.join("; "),
      source: input.project.workspaceSelection.source,
    },
    priority: "critical",
  });
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "session.blocked",
    aggregateType: "work_session",
    aggregateId: input.workSession.id,
    payload: { reason },
    priority: "critical",
  });
  await addAssistantMessage(input.chatSessionId, reason);
  await mirrorWorkSessionState(input.workSession.id);
  return true;
}

async function throwIfWorkSessionCanceled(workSessionId: Identifier): Promise<void> {
  const db = await getDatabaseSnapshot();
  const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
  if (workSession.currentState === "canceled") {
    throw new WorkSessionOperationAbortedError(workSessionId, "controller", "Operation canceled by user.");
  }
}

async function mutateWorkSessionIfNotCanceled<T>(
  workSessionId: Identifier,
  mutate: (db: AppDatabase, workSession: WorkSessionRecord) => T
): Promise<T | null> {
  return mutateDatabase((db) => {
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
    if (workSession.currentState === "canceled") {
      return null;
    }
    return mutate(db, workSession);
  });
}

async function createHandoff(workSessionId: Identifier, reason: string): Promise<void> {
  const handoff = await mutateDatabase((db) => {
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
    const plan = latestPlanForSession(db, workSessionId);
    const tasks = plan === null ? [] : tasksForPlan(db, plan.id);
    const completed = tasks.filter((task) => task.status === "done");
    const remaining = tasks.filter((task) => task.status !== "done" && task.status !== "skipped");
    const summary = `# Handoff\n\nReason: ${reason}\n\nCurrent state: ${workSession.currentState}\n\nWorkspace: ${workSession.activeWorktreePath}\n\nCompleted tasks: ${completed.length}\nRemaining tasks: ${remaining.length}\n\n## Remaining\n${remaining.map((task) => `- ${task.title}: ${task.status}`).join("\n") || "No remaining tasks."}\n`;
    const record = createHandoffRecord({
      workSessionId,
      createdByAgentRunId: null,
      summaryMarkdown: summary,
      openQuestions: remaining.length > 0 ? ["Should the controller continue the remaining tasks?"] : [],
      nextSteps: remaining.map((task) => task.title),
    });
    db.handoffs.push(record);
    return record;
  });

  await saveArtifact({
    workSessionId,
    kind: "handoff",
    fileName: `handoff-${handoff.id}.md`,
    content: handoff.summaryMarkdown,
    metadata: { handoffId: handoff.id },
  });
  await emitEvent({
    workSessionId,
    eventName: "handoff.created",
    aggregateType: "handoff",
    aggregateId: handoff.id,
    payload: { reason },
  });
  await mirrorWorkSessionState(workSessionId);
}

function crossProviderHandoffExists(db: AppDatabase, agentRunId: Identifier): boolean {
  return db.handoffs.some((handoff) =>
    handoff.createdByAgentRunId === agentRunId &&
    handoff.summaryMarkdown.startsWith("# Cross-provider Handoff Brief")
  );
}

async function recordTranscriptAndMaybeSwitchHandoff(input: {
  workSessionId: Identifier;
  agentRunId: Identifier;
  summary: string;
  transcript: TranscriptTurnRecord[] | undefined;
}): Promise<void> {
  const config = getConfig();

  const snapshot = await getDatabaseSnapshot();
  const workSession = snapshot.workSessions.find((candidate) => candidate.id === input.workSessionId);
  const currentRun = snapshot.agentRuns.find((candidate) => candidate.id === input.agentRunId);
  if (workSession === undefined || currentRun === undefined) {
    return;
  }

  const rawTurns = input.transcript !== undefined && input.transcript.length > 0
    ? input.transcript
    : [defaultTranscriptTurn({ agentRun: currentRun, finalText: input.summary })];
  const turns = rawTurns.map((turn) => ({
    ...turn,
    agentRunId: turn.agentRunId ?? currentRun.id,
    taskId: turn.taskId ?? currentRun.taskId,
  }));
  await extractProjectMemoryFromRun({
    workSessionId: input.workSessionId,
    agentRun: currentRun,
    summary: input.summary,
    transcript: turns,
  }).catch(() => undefined);
  const transcriptRef = await appendTranscriptTurns({
    workSessionId: input.workSessionId,
    transcriptRef: workSession.transcriptRef,
    turns,
  });
  if (transcriptRef !== null && transcriptRef !== workSession.transcriptRef) {
    await mutateDatabase((db) => {
      const mutableWorkSession = findRequired(db.workSessions, (candidate) => candidate.id === input.workSessionId, "Work session");
      mutableWorkSession.transcriptRef = transcriptRef;
      updateWorkSessionTimestamp(mutableWorkSession);
    });
  }
  if (!config.crossProviderTranscript) {
    return;
  }

  const afterAppend = await getDatabaseSnapshot();
  const refreshedWorkSession = afterAppend.workSessions.find((candidate) => candidate.id === input.workSessionId);
  if (refreshedWorkSession === undefined || crossProviderHandoffExists(afterAppend, currentRun.id)) {
    return;
  }
  const inHistory = createActiveHistoryFilter(refreshedWorkSession, afterAppend.checkpoints);
  const priorRun = afterAppend.agentRuns
    .filter((run) =>
      run.workSessionId === input.workSessionId &&
      run.id !== currentRun.id &&
      run.summary.trim().length > 0 &&
      run.startedAt < currentRun.startedAt &&
      inHistory(run.startedAt)
    )
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null;
  if (priorRun === null || priorRun.runtimeKind === currentRun.runtimeKind) {
    return;
  }

  const transcriptTurns = await readTranscriptTurns(refreshedWorkSession.transcriptRef);
  const summaryMarkdown = buildSwitchHandoffBrief({ previousRun: priorRun, currentRun, turns: transcriptTurns });
  const handoff = await mutateDatabase((db) => {
    if (crossProviderHandoffExists(db, currentRun.id)) {
      return null;
    }
    const record = createHandoffRecord({
      workSessionId: input.workSessionId,
      createdByAgentRunId: currentRun.id,
      summaryMarkdown,
      openQuestions: [],
      nextSteps: ["Continue with the active plan using the distilled cross-provider brief."],
    });
    db.handoffs.push(record);
    return record;
  });
  if (handoff === null) {
    return;
  }

  await saveArtifact({
    workSessionId: input.workSessionId,
    kind: "handoff",
    fileName: `cross-provider-handoff-${handoff.id}.md`,
    content: handoff.summaryMarkdown,
    metadata: { handoffId: handoff.id, agentRunId: currentRun.id, crossProvider: true },
  });
  await emitEvent({
    workSessionId: input.workSessionId,
    eventName: "handoff.created",
    aggregateType: "handoff",
    aggregateId: handoff.id,
    payload: {
      reason: `Provider switched from ${priorRun.runtimeKind} to ${currentRun.runtimeKind}.`,
      summary: switchHandoffChatSummary(handoff.summaryMarkdown),
      crossProvider: true,
    },
    producer: { module: "workflow-controller", runtimeKind: currentRun.runtimeKind, role: currentRun.role },
    context: { agentRunId: currentRun.id },
  });
  await mirrorWorkSessionState(input.workSessionId);
}

function compactFailureText(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b\d{2,}:\d{2,}(?::\d{2})?\b/g, "<time>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/[A-Z]:\\[^\s)]+/gi, "<path>")
    .replace(/\/[^\s)]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
}

function failedSpecSignature(rawOutput: string): string {
  const specIds = [...rawOutput.matchAll(/"specId":\s*"([^"]+)",\s*"status":\s*"failed"/g)]
    .map((match) => match[1])
    .sort();
  return Array.from(new Set(specIds)).join(";");
}

function failureFingerprint(input: { commands: string[]; summary: string; rawOutput: string }): string {
  const commandText = input.commands.join(";");
  const specSignature = failedSpecSignature(input.rawOutput);
  if (specSignature.length > 0) {
    return createHash("sha256").update(`specs:${commandText}\n${specSignature}`).digest("hex").slice(0, 16);
  }
  const pathHints = [...input.rawOutput.matchAll(/(?:[A-Z]:\\|\.\/|\/)?[\w.-]+(?:[\\/][\w.-]+)+/gi)]
    .slice(0, 20)
    .map((match) => match[0])
    .join(";");
  const normalized = compactFailureText(`${commandText}\n${pathHints}\n${input.summary}\n${input.rawOutput.slice(-6000)}`);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function recentChangesForSession(db: AppDatabase, workSessionId: Identifier): CodeChangeRecord[] {
  const workSession = db.workSessions.find((candidate) => candidate.id === workSessionId);
  const inHistory = createActiveHistoryFilter(workSession, db.checkpoints);
  const runIds = new Set(
    db.agentRuns
      .filter((run) => run.workSessionId === workSessionId && inHistory(run.startedAt))
      .map((run) => run.id)
  );
  return db.codeChanges.filter((change) => runIds.has(change.agentRunId)).slice(-20);
}

function summarizeChanges(changes: CodeChangeRecord[]): string {
  return changes.length === 0
    ? "No file changes were captured before this failure."
    : changes.map((change) => `- ${change.changeKind}: ${change.filePath}`).join("\n");
}

function uniqueChangeFilePaths(changes: CodeChangeRecord[]): string[] {
  return Array.from(
    new Set(
      changes
        .map((change) => change.filePath.trim())
        .filter((filePath) => filePath.length > 0)
    )
  );
}

function previewFailureEvidence(preview: PreviewServerRecord): string {
  return [
    `Health failure: ${preview.lastFailureReason ?? "(none recorded)"}`,
    `Preview id: ${preview.id}`,
    `Preview status: ${preview.status}`,
    `App type: ${preview.appType}`,
    `Command: ${preview.command}`,
    `URL: ${preview.url || "(none)"}`,
    `Port: ${preview.port}`,
    `Restart policy: ${preview.restartPolicy ?? "(unknown)"}`,
    `Server reload mode: ${preview.serverReloadMode ?? "(unknown)"}`,
    `Started at: ${preview.startedAt}`,
    `Stopped at: ${preview.stoppedAt ?? "(not stopped)"}`,
    `Last health check: ${preview.lastHealthCheckAt ?? "(none)"}`,
    "",
    "STDOUT tail:",
    preview.stdoutTail.trim() || "(empty)",
    "",
    "STDERR tail:",
    preview.stderrTail.trim() || "(empty)",
  ].join("\n");
}

function previewRuntimeLogEvidence(preview: PreviewServerRecord): string {
  return [
    `Preview id: ${preview.id}`,
    `App type: ${preview.appType}`,
    `Command: ${preview.command}`,
    `URL: ${preview.url || "(none)"}`,
    "",
    "STDERR tail (server tracebacks for failed requests usually appear here):",
    preview.stderrTail.trim().slice(-4000) || "(empty)",
    "",
    "STDOUT tail:",
    preview.stdoutTail.trim().slice(-4000) || "(empty)",
  ].join("\n");
}

function bootChainAuditBlock(appType: PreviewServerRecord["appType"]): string {
  return appType === "static-html"
    ? ""
    : `

Boot-chain audit (required before completing):
Boot and startup-path failures usually share a root cause with sibling assumptions introduced at the same time. After fixing the reported failure, audit the whole boot chain instead of only the first symptom: (1) the dev/start command actually launches the HTTP server (a compiler in watch mode alone is not a server), (2) the entrypoint path matches the real build output layout, (3) every runtime directory lookup (view templates, static assets, data files) still resolves after compilation. Then prove it: run the dev command yourself in the foreground with a bounded timeout, confirm the home page responds with HTTP 200 and that every stylesheet and script the home page references is served (not 404), and stop the process before finishing.`;
}

function bootChainAuditCriteria(appType: PreviewServerRecord["appType"]): string[] {
  return appType === "static-html"
    ? []
    : ["The full boot chain was audited (dev command starts the server, entrypoint matches the build output layout, runtime directory lookups resolve after compilation) and the dev command was run locally in the foreground with the home page returning HTTP 200 before completion."];
}

function isNextParentProxyLeak(preview: PreviewServerRecord, evidence: string): boolean {
  if (preview.appType !== "next" || !evidence.includes("@/lib/shared/local-api-guard") || !/proxy\.ts/.test(evidence)) {
    return false;
  }

  const workspacePath = path.resolve(preview.workspacePath).replace(/\\/g, "/").toLowerCase();
  const workspaceName = path.basename(workspacePath);
  const localProxyPath = `${workspacePath}/proxy.ts`;
  const generatedProxyPathFragment = `.workspace/${workspaceName}/proxy.ts`;
  return !evidence.includes(localProxyPath) && !evidence.includes(generatedProxyPathFragment);
}

function classifyPreviewRepairability(preview: PreviewServerRecord): { repairable: boolean; reason: string; failureKind: VerificationFailureKind } {
  const evidence = `${preview.command}\n${preview.stdoutTail}\n${preview.stderrTail}`.replace(/\\/g, "/").toLowerCase();
  if (isNextParentProxyLeak(preview, evidence)) {
    return {
      repairable: false,
      reason: "The Next preview is compiling the control-plane parent proxy.ts instead of staying inside the generated workspace. This is an orchestrator preview-isolation problem, not a generated-app dependency issue.",
      failureKind: "environment_failure",
    };
  }
  if (/no free preview ports|eaddrinuse|permission denied|eperm|eacces/.test(evidence)) {
    return {
      repairable: false,
      reason: "The preview failure looks like a local environment or port/permission issue, not a generated-app code issue.",
      failureKind: "environment_failure",
    };
  }
  if (/cannot find module|module not found|could not resolve|failed to resolve|missing dependency|npm error|pnpm error|yarn error/.test(evidence)) {
    return {
      repairable: true,
      reason: "The preview failed with dependency or module-resolution evidence.",
      failureKind: "dependency_failure",
    };
  }
  return {
    repairable: true,
    reason: "The preview failed health or runtime startup checks.",
    failureKind: "functional_failure",
  };
}

async function createPreviewRepairTask(input: {
  workSessionId: Identifier;
  plan: PlanRecord;
  preview: PreviewServerRecord;
  failureKind: VerificationFailureKind;
  reason: string;
  fingerprint: string;
}): Promise<TaskRecord> {
  return mutateDatabase((db) => {
    const tasks = tasksForPlan(db, input.plan.id);
    const repairCount = tasks.filter((task) => task.metadata.repairForPreviewId === input.preview.id).length;
    const latestTask = [...tasks].reverse().find((task) => !String(task.title).startsWith("Repair preview failure")) ?? tasks[tasks.length - 1] ?? null;
    const changes = recentChangesForSession(db, input.workSessionId);
    const evidence = previewFailureEvidence(input.preview);
    const bootChainAudit = bootChainAuditBlock(input.preview.appType);
    const description = `Repair the failed generated-app preview and keep the fix scoped to the current workspace.

Failure reason:
${input.reason}

Preview evidence:
${evidence}${bootChainAudit}

Recent code changes:
${summarizeChanges(changes)}

Relevant acceptance criteria:
${tasks.flatMap((task) => task.acceptanceCriteria).slice(0, 12).map((criterion) => `- ${criterion}`).join("\n") || "- Restore the app so it starts and serves the intended preview."}`;
    const task = createTaskRecord({
      planId: input.plan.id,
      parentTaskId: latestTask?.id ?? null,
      ordinal: tasks.length + 1,
      title: `Repair preview failure ${repairCount + 1}`,
      description,
      status: "todo",
      acceptanceCriteria: [
        "The generated app preview starts successfully after a hard restart or the failure is reduced to a clear non-code environment blocker.",
        "The repair remains scoped to the preview startup/runtime failure and preserves completed useful work.",
        ...bootChainAuditCriteria(input.preview.appType),
      ],
      metadata: {
        objective: "Repair the generated app so the orchestrator-owned preview can start and pass health checks.",
        taskKind: "modify",
        targetFiles: uniqueChangeFilePaths(changes),
        expectedChanges: ["Fix the root cause of the failed preview startup or health check."],
        verificationHints: input.plan.planJson.verificationCommands,
        riskLevel: "medium",
        priorResearchArtifactId: typeof latestTask?.metadata.priorResearchArtifactId === "string" ? latestTask.metadata.priorResearchArtifactId : "",
        priorResearchContext: typeof latestTask?.metadata.priorResearchContext === "string" ? latestTask.metadata.priorResearchContext : "",
        repairForPreviewId: input.preview.id,
        repairAttempt: String(repairCount + 1),
        failureFingerprint: input.fingerprint,
        failureKind: input.failureKind,
        previewCommand: input.preview.command,
        previewAppType: input.preview.appType,
        previewRestartPolicy: input.preview.restartPolicy ?? "",
        previewServerReloadMode: input.preview.serverReloadMode ?? "",
      },
      lastFailureSummary: input.reason,
      lastFailureFingerprint: input.fingerprint,
    });
    db.tasks.push(task);
    const plan = findRequired(db.plans, (candidate) => candidate.id === input.plan.id, "Plan");
    if (plan.status === "completed") {
      plan.status = "approved";
    }
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === input.workSessionId, "Work session");
    workSession.currentState = "executing";
    workSession.paused = false;
    workSession.awaitingStep = false;
    workSession.nextActionLabel = null;
    updateWorkSessionTimestamp(workSession);
    return task;
  });
}

function failingCommandOutputEvidence(verification: VerificationRunRecord): string {
  const structured = (verification.commandResults ?? []).filter((entry) => entry.status === "failed");
  if (structured.length > 0) {
    return structured
      .map((entry) => {
        const out = entry.stdoutTail.trim();
        const err = entry.stderrTail.trim();
        const body = [out.length > 0 ? `STDOUT:\n${out}` : "", err.length > 0 ? `STDERR:\n${err}` : ""]
          .filter((part) => part.length > 0)
          .join("\n\n");
        return `$ ${entry.command} (exit ${entry.exitCode ?? "null"}${entry.timedOut ? ", timed out" : ""})\n${body.length > 0 ? body : "(no output captured)"}`;
      })
      .join("\n\n");
  }
  const failingBlocks = verification.rawOutput
    .split("\n---\n")
    .filter((block) => /^\$ /.test(block.trim()) && (/\nexit=(?!0\b)/.test(block) || /timedOut=true/.test(block)));
  return failingBlocks.join("\n\n").trim();
}

function failureBiasedExcerpt(rawOutput: string, budget: number): string {
  const kept: string[] = [];
  for (const section of rawOutput.split("\n---\n")) {
    const trimmed = section.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith("Verification checks")) {
      kept.push(section);
      continue;
    }
    if (/^\$ /.test(trimmed)) {
      if (/\nexit=(?!0\b)/.test(section) || /timedOut=true/.test(section)) {
        kept.push(section);
      }
      continue;
    }
    const header = trimmed.split("\n", 1)[0];
    const failuresIdx = section.indexOf("\nFailures:");
    if (failuresIdx !== -1) {
      kept.push(`${header}\n${section.slice(failuresIdx + 1)}`.trim());
      continue;
    }
    const failedLines = trimmed.split("\n").filter((line) => line.startsWith("FAIL ") || line.startsWith("FAILED "));
    if (failedLines.length > 0) {
      kept.push(`${header}\n${failedLines.join("\n")}`);
    }
  }
  const excerpt = kept.join("\n---\n").trim();
  const chosen = excerpt.length > 0 ? excerpt : rawOutput.slice(-budget).trim();
  return chosen.length > budget ? `${chosen.slice(0, budget)}\n…(truncated)` : chosen;
}

async function createVerificationRepairTask(input: {
  workSessionId: Identifier;
  plan: PlanRecord;
  verification: VerificationRunRecord;
  fingerprint: string;
}): Promise<TaskRecord> {
  return mutateDatabase((db) => {
    const tasks = tasksForPlan(db, input.plan.id);
    const repairCount = tasks.filter((task) => typeof task.metadata.repairForVerificationRunId === "string").length;
    const latestTask = [...tasks].reverse().find((task) => !String(task.title).startsWith("Repair verification failure")) ?? tasks[tasks.length - 1] ?? null;
    const criteria = tasks.flatMap((task) => task.acceptanceCriteria).slice(0, 12);
    const changes = recentChangesForSession(db, input.workSessionId);
    const isSourceFailure = input.verification.failureKind === "source_failure";
    const commandsList = input.verification.commands.map((command) => `- ${command}`).join("\n") || "- No explicit commands were recorded.";
    const failedCheckLines = input.verification.rawOutput.split("\n").filter((line) => line.startsWith("FAILED "));
    const commandCheckFailed = failedCheckLines.some((line) => line.startsWith("FAILED [command]"));
    const failedChecksSection = failedCheckLines.length > 0
      ? `Failed checks:\n${failedCheckLines.slice(0, 8).map((line) => `- ${line}`).join("\n")}\n\n`
      : "";
    const commandsSection = isSourceFailure
      ? commandCheckFailed
        ? `Failed commands:\n${commandsList}`
        : `Source verification commands (these PASSED — the failure is in the structural/intent checks listed under "Failed checks" above):\n${commandsList}`
      : `Source verification commands (these PASSED — the failure is in the runtime render/interaction phase; see the failing checks in the raw excerpt below):\n${commandsList}`;
    const linkedPreview = !isSourceFailure && typeof input.verification.previewId === "string" && input.verification.previewId.length > 0
      ? db.previewServers.find((candidate) => candidate.id === input.verification.previewId) ?? null
      : null;
    const failedPreview = linkedPreview !== null
      && (linkedPreview.status === "failed" || (typeof linkedPreview.lastFailureReason === "string" && linkedPreview.lastFailureReason.length > 0))
      ? linkedPreview
      : null;
    const runtimeLogPreview = linkedPreview !== null && failedPreview === null
      && (linkedPreview.stderrTail.trim().length > 0 || linkedPreview.stdoutTail.trim().length > 0)
      ? linkedPreview
      : null;
    const previewSection = failedPreview !== null
      ? `

Preview failure evidence (fix the "Health failure" line first — it names the exact failing request):
${previewFailureEvidence(failedPreview)}${bootChainAuditBlock(failedPreview.appType)}`
      : runtimeLogPreview !== null
        ? `

Server runtime logs from the verified preview (the server stayed up; for any 5xx or failed interaction in the failed checks, the underlying exception/traceback is usually in the STDERR tail — fix the deepest application frame, do not guess):
${previewRuntimeLogEvidence(runtimeLogPreview)}`
        : "";
    const failingCommandOutput = failingCommandOutputEvidence(input.verification);
    const failingCommandSection = failingCommandOutput.length > 0
      ? `Failing command output (this is the actual error the gate saw — diagnose and fix from here; the required change is often stated in the message itself):\n${failingCommandOutput}\n\n`
      : "";
    const description = `Repair the failed verification run and keep the fix scoped to the current plan.

Failure kind: ${input.verification.failureKind}

${failedChecksSection}${failingCommandSection}${commandsSection}

Verification summary:
${input.verification.summary}${previewSection}

Recent code changes:
${summarizeChanges(changes)}

Relevant acceptance criteria:
${criteria.map((criterion) => `- ${criterion}`).join("\n") || "- Restore the plan's intended behavior and passing verification."}

Raw verification excerpt:
${failureBiasedExcerpt(input.verification.rawOutput, 5000)}`;
    const task = createTaskRecord({
      planId: input.plan.id,
      parentTaskId: latestTask?.id ?? null,
      ordinal: tasks.length + 1,
      title: `Repair verification failure ${repairCount + 1}`,
      description,
      status: "todo",
      acceptanceCriteria: [
        "The failed verification commands pass or the failure is reduced to a clear non-code environment blocker.",
        "Every failed check listed in the FAILED CHECKS digest is addressed, not only the first symptom - sibling failures left in place cost one full verification cycle each.",
        "The repair remains scoped to the latest verification failure and does not rewrite unrelated work.",
        ...(failedPreview === null ? [] : bootChainAuditCriteria(failedPreview.appType)),
        ...(runtimeLogPreview === null ? [] : ["Any 5xx or failed-interaction check was diagnosed from the server traceback in the runtime log evidence (or by reproducing the failing request against a locally started server), not by guessing from the route name."]),
      ],
      metadata: {
        objective: "Repair the latest verification failure using the captured raw output and recent code changes.",
        taskKind: "modify",
        targetFiles: uniqueChangeFilePaths(changes),
        expectedChanges: ["Fix the root cause of the failed verification output."],
        verificationHints: input.verification.commands,
        riskLevel: "medium",
        priorResearchArtifactId: typeof latestTask?.metadata.priorResearchArtifactId === "string" ? latestTask.metadata.priorResearchArtifactId : "",
        priorResearchContext: typeof latestTask?.metadata.priorResearchContext === "string" ? latestTask.metadata.priorResearchContext : "",
        repairForVerificationRunId: input.verification.id,
        repairAttempt: repairCount + 1,
        failureFingerprint: input.fingerprint,
      },
      lastFailureSummary: input.verification.summary,
      lastFailureFingerprint: input.fingerprint,
    });
    db.tasks.push(task);
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === input.workSessionId, "Work session");
    workSession.currentState = "executing";
    updateWorkSessionTimestamp(workSession);
    return task;
  });
}

async function createExecutionRepairTask(input: {
  workSessionId: Identifier;
  plan: PlanRecord;
  failedTask: TaskRecord;
  result: TaskExecutionResult;
}): Promise<TaskRecord> {
  return mutateDatabase((db) => {
    const tasks = tasksForPlan(db, input.plan.id);
    const rootFailedTask = executionRepairRootTask(tasks, input.failedTask);
    const repairCount = tasks.filter((task) => isExecutionRepairForRoot(tasks, task, rootFailedTask.id)).length;
    const changes = recentChangesForSession(db, input.workSessionId);
    const description = `Repair the failed task execution and continue the approved plan.

Failed task:
${rootFailedTask.title}

Latest failed task:
${input.failedTask.title}

Failure kind:
${input.result.failureKind ?? "runtime_failure"}

Failure summary:
${input.result.summary}

Full runtime log artifact:
${input.result.logArtifactId ?? "No log artifact was recorded."}

Recent code changes:
${summarizeChanges(changes)}

Original acceptance criteria:
${rootFailedTask.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n") || "- Restore the intended behavior for the failed task."}`;
    const task = createTaskRecord({
      planId: input.plan.id,
      parentTaskId: input.failedTask.id,
      ordinal: tasks.length + 1,
      title: `Repair execution failure ${repairCount + 1}`,
      description,
      status: "todo",
      acceptanceCriteria: [
        "The failed task execution is repaired or reduced to a clear non-code environment blocker.",
        "The repair remains scoped to the failed task and preserves any useful partial progress.",
      ],
      metadata: {
        objective: "Repair the latest task execution failure using the bounded summary and full log artifact.",
        taskKind: "modify",
        targetFiles: uniqueChangeFilePaths(changes),
        expectedChanges: ["Fix the root cause of the failed task execution."],
        verificationHints: input.failedTask.metadata.verificationHints ?? [],
        riskLevel: "medium",
        priorResearchArtifactId: typeof input.failedTask.metadata.priorResearchArtifactId === "string" ? input.failedTask.metadata.priorResearchArtifactId : "",
        priorResearchContext: typeof input.failedTask.metadata.priorResearchContext === "string" ? input.failedTask.metadata.priorResearchContext : "",
        repairForTaskId: rootFailedTask.id,
        repairParentTaskId: input.failedTask.id,
        repairForAgentRunId: input.result.agentRun.id,
        repairAttempt: String(repairCount + 1),
        failureKind: input.result.failureKind ?? "runtime_failure",
        logArtifactId: input.result.logArtifactId ?? "",
      },
      lastFailureSummary: input.result.summary,
      lastFailureFingerprint: createHash("sha256").update(compactFailureText(input.result.summary)).digest("hex").slice(0, 16),
    });
    db.tasks.push(task);
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === input.workSessionId, "Work session");
    workSession.currentState = "executing";
    updateWorkSessionTimestamp(workSession);
    return task;
  });
}

async function recoverImplicitAppServerInterruptedFailure(input: {
  workSessionId: Identifier;
}): Promise<{ recovered: boolean; repairTask: TaskRecord | null; failedTaskTitle: string; codeChangeCount: number; logArtifactId: string }> {
  return mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId);
    if (workSession === undefined || workSession.currentState !== "blocked" || workSession.activePlanId === null) {
      return { recovered: false, repairTask: null, failedTaskTitle: "", codeChangeCount: 0, logArtifactId: "" };
    }
    const plan = latestPlanForSession(db, workSession.id);
    if (plan === null) {
      return { recovered: false, repairTask: null, failedTaskTitle: "", codeChangeCount: 0, logArtifactId: "" };
    }
    const tasks = tasksForPlan(db, plan.id);
    const failedTask = tasks.find((task) =>
      task.status === "blocked" &&
      typeof task.lastFailureSummary === "string" &&
      task.lastFailureSummary.includes("Codex app-server run was aborted by the user.")
    );
    const artifactId = failedTask?.lastFailureSummary?.match(/Transcript artifact:\s*([0-9a-f-]{36})/i)?.[1] ?? null;
    if (failedTask === undefined || artifactId === null) {
      return { recovered: false, repairTask: null, failedTaskTitle: "", codeChangeCount: 0, logArtifactId: "" };
    }

    const artifact = db.artifacts.find((candidate) => candidate.id === artifactId);
    const metadata = artifact?.metadata ?? {};
    const transport = typeof metadata.transport === "string" ? metadata.transport : "";
    const outcome = typeof metadata.outcome === "string" ? metadata.outcome : "";
    const abortReason = typeof metadata.abortReason === "string" ? metadata.abortReason.trim() : "";
    const agentRunId = typeof metadata.agentRunId === "string" ? metadata.agentRunId : "";
    if (transport !== "app-server" || outcome !== "interrupted" || abortReason.length > 0 || agentRunId.length === 0) {
      return { recovered: false, repairTask: null, failedTaskTitle: "", codeChangeCount: 0, logArtifactId: "" };
    }

    const capturedChanges = db.codeChanges.filter((change) => change.agentRunId === agentRunId);
    if (capturedChanges.length === 0) {
      return { recovered: false, repairTask: null, failedTaskTitle: "", codeChangeCount: 0, logArtifactId: "" };
    }

    const rootFailedTask = executionRepairRootTask(tasks, failedTask);
    const repairTasks = tasks.filter((task) => isExecutionRepairForRoot(tasks, task, rootFailedTask.id));
    const runnableRepair = repairTasks.find((task) => isRunnableTask(task));
    if (runnableRepair !== undefined) {
      workSession.currentState = "executing";
      updateWorkSessionTimestamp(workSession);
      return { recovered: true, repairTask: null, failedTaskTitle: rootFailedTask.title, codeChangeCount: capturedChanges.length, logArtifactId: artifactId };
    }
    if (repairTasks.length >= maxRepairAttemptsPerSession) {
      return { recovered: false, repairTask: null, failedTaskTitle: "", codeChangeCount: 0, logArtifactId: "" };
    }

    const changes = recentChangesForSession(db, input.workSessionId);
    const description = `Repair the failed task execution and continue the approved plan.

Failed task:
${rootFailedTask.title}

Latest failed task:
${failedTask.title}

Failure kind:
runtime_failure

Failure summary:
${failedTask.lastFailureSummary}

Full runtime log artifact:
${artifactId}

Recent code changes:
${summarizeChanges(changes)}

Original acceptance criteria:
${rootFailedTask.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n") || "- Restore the intended behavior for the failed task."}`;
    const task = createTaskRecord({
      planId: plan.id,
      parentTaskId: failedTask.id,
      ordinal: tasks.length + 1,
      title: `Repair execution failure ${repairTasks.length + 1}`,
      description,
      status: "todo",
      acceptanceCriteria: [
        "The failed task execution is repaired or reduced to a clear non-code environment blocker.",
        "The repair remains scoped to the failed task and preserves any useful partial progress.",
      ],
      metadata: {
        objective: "Repair a legacy Codex app-server interrupted turn that captured partial code changes.",
        taskKind: "modify",
        targetFiles: uniqueChangeFilePaths(changes),
        expectedChanges: ["Inspect the captured partial progress and finish or correct the failed task."],
        verificationHints: rootFailedTask.metadata.verificationHints,
        riskLevel: "medium",
        priorResearchArtifactId: typeof rootFailedTask.metadata.priorResearchArtifactId === "string" ? rootFailedTask.metadata.priorResearchArtifactId : "",
        priorResearchContext: typeof rootFailedTask.metadata.priorResearchContext === "string" ? rootFailedTask.metadata.priorResearchContext : "",
        repairForTaskId: rootFailedTask.id,
        repairAttempt: repairTasks.length + 1,
        repairedLegacyAppServerInterruption: true,
        failedAgentRunId: agentRunId,
        logArtifactId: artifactId,
      },
      lastFailureSummary: failedTask.lastFailureSummary,
      lastFailureFingerprint: failedTask.lastFailureFingerprint,
    });
    db.tasks.push(task);
    workSession.currentState = "executing";
    updateWorkSessionTimestamp(workSession);
    return { recovered: true, repairTask: task, failedTaskTitle: rootFailedTask.title, codeChangeCount: capturedChanges.length, logArtifactId: artifactId };
  });
}

async function updateAcceptanceEvidenceForTask(input: {
  taskId: Identifier;
  status: "satisfied" | "failed";
  source: "code_change" | "agent_summary";
  note: string;
}): Promise<void> {
  await mutateDatabase((db) => {
    const task = findRequired(db.tasks, (candidate) => candidate.id === input.taskId, "Task");
    task.acceptanceEvidence = task.acceptanceCriteria.map((criterion) => ({
      criterion,
      status: input.status,
      source: input.source,
      note: input.note,
      updatedAt: currentTimestamp(),
    }));
  });
}

async function finalizeAcceptanceEvidence(workSessionId: Identifier, planId: Identifier, verificationRunId: Identifier): Promise<boolean> {
  return mutateDatabase((db) => {
    const tasks = tasksForPlan(db, planId);
    for (const task of tasks) {
      task.acceptanceEvidence = task.acceptanceCriteria.map((criterion) => {
        const existing = task.acceptanceEvidence.find((candidate) => candidate.criterion === criterion);
        if (existing !== undefined && (existing.status === "satisfied" || existing.status === "not_machine_verifiable")) {
          return existing;
        }
        return {
          criterion,
          status: "satisfied",
          source: "verification_run",
          note: `Satisfied by passing verification run ${verificationRunId}.`,
          updatedAt: currentTimestamp(),
        };
      });
    }
    return tasks.every((task) =>
      task.acceptanceCriteria.every((criterion) => {
        const evidence = task.acceptanceEvidence.find((candidate) => candidate.criterion === criterion);
        return evidence !== undefined && (evidence.status === "satisfied" || evidence.status === "not_machine_verifiable");
      })
    );
  });
}

async function createPlanApproval(workSessionId: Identifier, planId: Identifier): Promise<void> {
  const approval = await mutateDatabase((db) => {
    const existing = db.approvals.find(
      (candidate) => candidate.workSessionId === workSessionId && candidate.approvalKind === "plan" && candidate.status === "pending"
    );
    if (existing !== undefined) {
      return existing;
    }
    const record = createApprovalRecord({
      workSessionId,
      agentRunId: null,
      approvalKind: "plan",
      reason: "Approve the durable implementation plan before execution begins.",
      payload: { planId },
      status: "pending",
    });
    db.approvals.push(record);
    return record;
  });

  await emitEvent({
    workSessionId,
    eventName: "approval.requested",
    aggregateType: "approval",
    aggregateId: approval.id,
    payload: { approvalKind: "plan", planId, reason: approval.reason },
    context: { approvalId: approval.id, planId },
  });
  await mirrorWorkSessionState(workSessionId);
}

function assertPlanTargetsStayInsideWorkspace(workSession: WorkSessionRecord, planJson: PlanJson): void {
  const workspaceRoot = path.resolve(workSession.activeWorktreePath);
  const workspaceFromPlan = planJson.workspace?.workspacePath;
  if (typeof workspaceFromPlan === "string" && workspaceFromPlan.trim().length > 0) {
    const plannedRoot = path.resolve(workspaceFromPlan);
    const sameRoot = process.platform === "win32"
      ? plannedRoot.toLowerCase() === workspaceRoot.toLowerCase()
      : plannedRoot === workspaceRoot;
    if (!sameRoot) {
      throw new Error(`Generated plan workspace does not match the active workspace. Planned: ${plannedRoot}. Active: ${workspaceRoot}.`);
    }
  }

  for (const task of planJson.tasks) {
    for (const rawFile of task.targetFiles ?? []) {
      const file = rawFile.trim();
      if (file.length === 0) {
        continue;
      }
      if (path.isAbsolute(file)) {
        throw new Error(`Generated plan target file must be workspace-relative: ${file}`);
      }
      const resolved = path.resolve(workspaceRoot, file);
      const relative = path.relative(workspaceRoot, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Generated plan target file escapes the active workspace: ${file}`);
      }
    }
  }
}

async function createPlan(workSession: WorkSessionRecord): Promise<PlanRecord> {
  const config = getConfig();
  const bootstrap = await bootstrapWorkspaceIfNeeded(workSession, { deferLowConfidenceDefault: true });
  const workspaceAnalysis = await analyzeWorkspace(workSession.activeWorktreePath, config.verifyCommands);
  const userRequest = await userRequestWithAttachmentBlock(workSession);
  const imagePaths = (await imageAttachmentsForWorkSession(workSession)).map((attachment) => attachment.absolutePath);
  const researchContext = await findLatestResearchContext({
    workSessionId: workSession.id,
    userRequest,
  });
  const researchPromptContext = renderResearchContextForPrompt(researchContext);
  const skillPrompt = await prepareSkillsForPrompt({ workSession });
  const generated = await generatePlan({
    userRequest,
    workspaceAnalysis,
    steeringNote: [workSession.steeringNote, skillPrompt.promptBlock].filter((entry) => entry.trim().length > 0).join("\n\n"),
    priorResearchContext: researchPromptContext,
    provider: workSession.agentProvider ?? config.agentProvider,
    ollamaModel: workSession.runtimeOverrides?.model ?? null,
    claudeModel: workSession.runtimeOverrides?.model ?? null,
    claudeEffort: workSession.runtimeOverrides?.reasoningEffort ?? null,
    agyModel: workSession.runtimeOverrides?.model ?? null,
    imagePaths,
  });
  assertPlanTargetsStayInsideWorkspace(workSession, generated.planJson);
  const { plan, decisionBeforePlan, sessionAfterPlan } = await mutateDatabase((db) => {
    const version = db.plans.filter((candidate) => candidate.workSessionId === workSession.id).length + 1;
    const record = createPlanRecord({
      workSessionId: workSession.id,
      version,
      title: generated.planJson.title,
      goal: generated.planJson.goal,
      status: "draft",
      planMarkdown: generated.planMarkdown,
      planJson: {
        ...generated.planJson,
        workspace: {
          ...(generated.planJson.workspace ?? {}),
          priorResearchArtifactId: researchContext?.artifactId ?? null,
          priorResearchArtifactPath: researchContext?.artifactUri ?? null,
        },
      },
      createdByAgent: generated.createdByAgent,
      approvedAt: null,
      approvalCheckpointId: null,
    });
    db.plans.push(record);

    record.planJson.tasks.forEach((task, index) => {
      db.tasks.push(
        createTaskRecord({
          planId: record.id,
          parentTaskId: null,
          ordinal: index + 1,
          title: task.title,
          description: task.description,
          status: "todo",
          acceptanceCriteria: task.acceptanceCriteria,
          metadata: {
            objective: task.objective ?? task.description,
            taskKind: task.taskKind ?? "modify",
            targetFiles: task.targetFiles ?? [],
            expectedChanges: task.expectedChanges ?? [],
            verificationHints: task.verificationHints ?? [],
            riskLevel: task.riskLevel ?? "low",
            priorResearchArtifactId: researchContext?.artifactId ?? "",
            priorResearchContext: researchPromptContext,
          },
        })
      );
    });

    const mutableWorkSession = findRequired(db.workSessions, (candidate) => candidate.id === workSession.id, "Work session");
    mutableWorkSession.activePlanId = record.id;
    mutableWorkSession.executionMode = chooseExecutionMode();
    const previousDecision = mutableWorkSession.stackDecision ?? null;
    const plannerStack = record.planJson.targetStack ?? null;
    if (plannerStack !== null && previousDecision?.source !== "user") {
      mutableWorkSession.stackDecision = {
        stack: plannerStack,
        source: "planner",
        confidence: "high",
        rationale: record.planJson.stackRationale ?? "Declared by the planner.",
        decidedAt: new Date().toISOString(),
      };
    }
    updateWorkSessionTimestamp(mutableWorkSession);
    return { plan: record, decisionBeforePlan: previousDecision, sessionAfterPlan: { ...mutableWorkSession } };
  });

  const heuristicStack = decisionBeforePlan;
  const plannerStack = generated.planJson.targetStack ?? null;
  const userOwnedStack = heuristicStack?.source === "user";
  const deferredScaffold = bootstrap?.deferred === true;
  const mismatch = plannerStack !== null && heuristicStack !== null && heuristicStack.stack !== plannerStack;
  if (!userOwnedStack && (deferredScaffold || mismatch)) {
    const targetStack = plannerStack ?? heuristicStack?.stack ?? config.defaultProjectStack;
    const rescaffold = await rescaffoldWorkspaceForStack(sessionAfterPlan, targetStack);
    if (rescaffold.rescaffolded) {
      await mutateDatabase((db) => {
        const session = findRequired(db.workSessions, (candidate) => candidate.id === workSession.id, "Work session");
        session.scaffoldManifest = rescaffold.filesCreated;
        updateWorkSessionTimestamp(session);
      });
    }
    await emitEvent({
      workSessionId: workSession.id,
      eventName: "plan.stack.mismatch",
      aggregateType: "plan",
      aggregateId: plan.id,
      payload: {
        heuristicStack: deferredScaffold ? `(deferred default ${heuristicStack?.stack ?? config.defaultProjectStack})` : (heuristicStack?.stack ?? ""),
        plannerStack: targetStack,
        deferredScaffold,
        rationale: generated.planJson.stackRationale ?? "",
        rescaffolded: rescaffold.rescaffolded,
        rescaffoldNote: rescaffold.reason,
      },
      priority: "high",
      producer: { module: "workflow-controller" },
    });
  }

  await saveArtifact({
    workSessionId: workSession.id,
    kind: "plan",
    fileName: `plan-v${plan.version}-${plan.id}.md`,
    content: plan.planMarkdown,
    metadata: { planId: plan.id, version: plan.version },
  });
  await emitEvent({
    workSessionId: workSession.id,
    eventName: "plan.created",
    aggregateType: "plan",
    aggregateId: plan.id,
    payload: {
      title: plan.title,
      taskCount: plan.planJson.tasks.length,
      createdByAgent: plan.createdByAgent,
      workspaceType: workspaceAnalysis.appType,
      bootstrapKind: bootstrap?.kind ?? null,
    },
    context: { planId: plan.id },
  });
  await mirrorWorkSessionState(workSession.id);
  return plan;
}

async function ensurePlanApprovalCheckpoint(workSessionId: Identifier, planId: Identifier): Promise<CheckpointRecord | null> {
  const existing = await mutateDatabase((db) => {
    const plan = findRequired(db.plans, (candidate) => candidate.id === planId && candidate.workSessionId === workSessionId, "Plan");
    if (plan.approvalCheckpointId === null) {
      return null;
    }
    return db.checkpoints.find((checkpoint) => checkpoint.id === plan.approvalCheckpointId && checkpoint.workSessionId === workSessionId) ?? null;
  });
  if (existing !== null) {
    return existing;
  }

  const checkpoint = await createSessionCheckpoint({
    workSessionId,
    taskId: null,
    agentRunId: null,
    trigger: "plan_approved",
  });
  if (checkpoint === null) {
    return null;
  }

  await mutateDatabase((db) => {
    const plan = findRequired(db.plans, (candidate) => candidate.id === planId && candidate.workSessionId === workSessionId, "Plan");
    plan.approvalCheckpointId = checkpoint.id;
  });
  return checkpoint;
}

async function approvePlanAutomatically(workSessionId: Identifier, planId: Identifier): Promise<void> {
  await mutateDatabase((db) => {
    const plan = findRequired(db.plans, (candidate) => candidate.id === planId, "Plan");
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
    plan.status = "approved";
    plan.approvedAt = currentTimestamp();
    workSession.planModeEnabled = false;
    workSession.currentState = "executing";
    updateWorkSessionTimestamp(workSession);
  });
  await emitEvent({
    workSessionId,
    eventName: "plan.approved",
    aggregateType: "plan",
    aggregateId: planId,
    payload: { automatic: true },
    context: { planId },
  });
  await ensurePlanApprovalCheckpoint(workSessionId, planId);
  await mirrorWorkSessionState(workSessionId);
}

async function ensureDependencyResearchForPlan(input: {
  workSession: WorkSessionRecord;
  plan: PlanRecord;
}): Promise<{ alreadyCompleted: boolean; summary: string }> {
  const existing = await mutateDatabase((db) => {
    const plan = findRequired(db.plans, (candidate) => candidate.id === input.plan.id, "Plan");
    const workspace = plan.planJson.workspace;
    if (
      workspace !== undefined &&
      workspace.dependencyResearchPlanId === input.plan.id &&
      typeof workspace.dependencyResearchSummary === "string"
    ) {
      return workspace.dependencyResearchSummary;
    }
    const tasks = tasksForPlan(db, input.plan.id);
    const completedTask = tasks.find((task) => task.metadata.dependencyResearchPlanId === input.plan.id);
    return typeof completedTask?.metadata.dependencyResearchSummary === "string"
      ? completedTask.metadata.dependencyResearchSummary
      : null;
  });
  if (existing !== null) {
    return { alreadyCompleted: true, summary: existing };
  }

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "task.progress",
    aggregateType: "plan",
    aggregateId: input.plan.id,
    payload: {
      activityKind: "dependency_research",
      activityLabel: "Researching dependencies",
      activityDetail: "Checking current package and library versions before coding.",
      message: "Checking current package and library versions before coding.",
    },
    context: { planId: input.plan.id },
  });

  const tasks = await mutateDatabase((db) => tasksForPlan(db, input.plan.id).map((task) => ({ ...task, metadata: { ...task.metadata } })));
  const result = await researchDependenciesForApprovedPlan({
    workSession: input.workSession,
    plan: input.plan,
    tasks,
  });

  await mutateDatabase((db) => {
    const plan = findRequired(db.plans, (candidate) => candidate.id === input.plan.id, "Plan");
    plan.planJson.workspace = {
      ...(plan.planJson.workspace ?? {}),
      dependencyResearchPlanId: input.plan.id,
      dependencyResearchStatus: result.status,
      dependencyResearchSummary: result.summary,
    };
    const tasksForCurrentPlan = tasksForPlan(db, input.plan.id);
    for (const task of tasksForCurrentPlan) {
      task.metadata.dependencyResearchPlanId = input.plan.id;
      task.metadata.dependencyResearchStatus = result.status;
      task.metadata.dependencyResearchSummary = result.summary;
    }
  });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "task.progress",
    aggregateType: "plan",
    aggregateId: input.plan.id,
    payload: {
      activityKind: "dependency_research",
      activityLabel: "Researching dependencies",
      activityDetail: "Dependency research completed.",
      message: "Dependency research completed.",
      summary: result.summary,
      npmPackageCount: String(result.npmPackages.length),
      pythonPackageCount: String(result.pythonPackages.length),
    },
    context: { planId: input.plan.id },
  });

  await mirrorWorkSessionState(input.workSession.id);
  return { alreadyCompleted: false, summary: result.summary };
}

async function executeTask(
  workSession: WorkSessionRecord,
  runtimeProfile: RuntimeProfileRecord,
  task: TaskRecord
): Promise<TaskExecutionResult> {
  const config = getConfig();
  await assertSafeWorkspace(workSession.activeWorktreePath, { operation: "task execution" });
  const provider = workSession.agentProvider ?? config.agentProvider;
  const model = provider === "ollama"
    ? workSession.runtimeOverrides?.model ?? (config.ollamaModel.trim().length > 0 ? config.ollamaModel.trim() : runtimeProfile.model)
    : provider === "claude-code"
      ? workSession.runtimeOverrides?.model ?? (config.claudeModel.trim().length > 0 ? config.claudeModel.trim() : runtimeProfile.model)
      : provider === "antigravity-cli"
        ? "agy"
        : runtimeProfile.model;
  const agentRun = await mutateDatabase((db) => {
    closeActiveAgentRuns(db, {
      workSessionId: workSession.id,
      taskId: task.id,
      exceptAgentRunId: null,
      summary: "Superseded by a later attempt for the same task.",
    });
    const run = createAgentRunRecord({
      workSessionId: workSession.id,
      taskId: task.id,
      role: "executor",
      runtimeKind: runtimeKindForProvider(provider),
      model,
      status: "running",
      summary: "",
    });
    db.agentRuns.push(run);
    const mutableTask = findRequired(db.tasks, (candidate) => candidate.id === task.id, "Task");
    mutableTask.status = "in_progress";
    mutableTask.attemptCount += 1;
    return run;
  });
  const skillPrompt = await prepareSkillsForPrompt({ workSession, task, agentRun });
  const retryContext = config.dispatchRetryContext
    ? await buildRetryAddendum({ workSession, task, currentAgentRunId: agentRun.id }).catch((error: unknown) => {
        logProcess("warn", "dispatch_context.retry.failed", {
          workSessionId: workSession.id,
          taskId: task.id,
          message: error instanceof Error ? error.message : "Unknown retry-context error",
        });
        return null;
      })
    : null;
  const statelessProvider = provider === "antigravity-cli"
    || provider === "ollama"
    || (provider === "claude-code" && !config.claudePersistentSessions);
  const continuityContext = config.dispatchContinuityContext && statelessProvider
    ? await buildContinuityBlock({ workSession, task, currentAgentRunId: agentRun.id, compact: provider === "ollama" }).catch((error: unknown) => {
        logProcess("warn", "dispatch_context.continuity.failed", {
          workSessionId: workSession.id,
          taskId: task.id,
          message: error instanceof Error ? error.message : "Unknown continuity-context error",
        });
        return null;
      })
    : null;
  const dispatchMetadata: JsonObject = {};
  if (skillPrompt.promptBlock.length > 0) {
    dispatchMetadata.activatedSkillPrompt = skillPrompt.promptBlock;
    dispatchMetadata.activatedSkillIds = skillPrompt.skillIds;
    dispatchMetadata.activatedSkillPromptArtifactId = skillPrompt.promptArtifactId ?? "";
  }
  if (retryContext !== null) {
    dispatchMetadata.dispatchRetryContext = retryContext;
  }
  if (continuityContext !== null) {
    dispatchMetadata.dispatchContinuityContext = continuityContext;
  }
  const taskForExecution: TaskRecord = Object.keys(dispatchMetadata).length === 0
    ? task
    : {
        ...task,
        metadata: {
          ...task.metadata,
          ...dispatchMetadata,
        },
      };

  await emitEvent({
    workSessionId: workSession.id,
    eventName: "agent.started",
    aggregateType: "agent_run",
    aggregateId: agentRun.id,
    payload: {
      role: agentRun.role,
      taskId: task.id,
      provider,
      activatedSkillCount: String(skillPrompt.skillIds.length),
      dispatchRetryContext: retryContext !== null,
      dispatchContinuityContext: continuityContext !== null,
    },
    producer: { module: "runtime-adapter", runtimeKind: agentRun.runtimeKind, role: agentRun.role },
    context: { taskId: task.id, agentRunId: agentRun.id },
  });

  try {
    await ensureWorkspaceAgentsMd(workSession.activeWorktreePath);
    const preTaskCheckpoint = await createSessionCheckpoint({
      workSessionId: workSession.id,
      taskId: task.id,
      agentRunId: agentRun.id,
      trigger: workSession.checkpointRef === null ? "baseline" : "pre_task",
    });
    const execution = provider === "codex-cli"
      ? await executeCodexTask({ workSession, task: taskForExecution, agentRun })
      : provider === "ollama"
        ? await executeWithOllama({ workSession, task: taskForExecution, agentRun })
        : provider === "claude-code"
          ? await executeWithClaudeCode({ workSession, task: taskForExecution, agentRun })
          : await executeWithAgy({ workSession, task: taskForExecution, agentRun });
    if (execution.type === "failed" && execution.failureKind === "runtime_failure" && isProviderExhaustionMessage(execution.summary)) {
      execution.failureKind = "provider_exhausted";
    }
    const postTaskCheckpoint = await createSessionCheckpoint({
      workSessionId: workSession.id,
      taskId: task.id,
      agentRunId: agentRun.id,
      trigger: "post_task",
    }).catch(async (error: unknown) => {
      if (execution.codeChanges.length === 0 && preTaskCheckpoint !== null) {
        return preTaskCheckpoint;
      }
      throw error;
    });

    if (execution.type === "approval_required") {
      await mutateDatabase((db) => {
        const mutableRun = findRequired(db.agentRuns, (candidate) => candidate.id === agentRun.id, "Agent run");
        mutableRun.status = "waiting_approval";
        mutableRun.summary = execution.summary;
        const approval = createApprovalRecord({
          workSessionId: workSession.id,
          agentRunId: agentRun.id,
          approvalKind: "command",
          reason: execution.payload?.reason ?? "Runtime requested approval.",
          payload: { command: execution.payload?.command ?? "" },
          status: "pending",
        });
        db.approvals.push(approval);
      });
      await emitEvent({
        workSessionId: workSession.id,
        eventName: "approval.requested",
        aggregateType: "agent_run",
        aggregateId: agentRun.id,
        payload: {
          approvalKind: "command",
          reason: execution.payload?.reason ?? "Runtime requested approval.",
          command: execution.payload?.command ?? "",
        },
        producer: { module: "runtime-adapter", runtimeKind: agentRun.runtimeKind, role: agentRun.role },
        context: { taskId: task.id, agentRunId: agentRun.id },
      });
      await mirrorWorkSessionState(workSession.id);
      return { status: "approval_required", agentRun, summary: execution.summary, codeChangeCount: execution.codeChanges.length };
    }

    await mutateDatabase((db) => {
      const mutableRun = findRequired(db.agentRuns, (candidate) => candidate.id === agentRun.id, "Agent run");
      mutableRun.status = execution.type === "completed" ? "completed" : "failed";
      mutableRun.summary = execution.summary;
      markEnded(mutableRun);

      for (const change of execution.codeChanges) {
        db.codeChanges.push(
          createCodeChangeRecord({
            agentRunId: agentRun.id,
            filePath: change.filePath,
            changeKind: change.changeKind,
            diffExcerpt: change.diffExcerpt,
          })
        );
      }

      const mutableTask = findRequired(db.tasks, (candidate) => candidate.id === task.id, "Task");
      mutableTask.status = execution.type === "completed" ? "done" : "blocked";
      mutableTask.lastFailureSummary = execution.type === "completed" ? null : execution.summary;
      mutableTask.lastFailureFingerprint = execution.type === "completed" ? null : createHash("sha256").update(compactFailureText(execution.summary)).digest("hex").slice(0, 16);
      if (execution.type === "completed" && typeof mutableTask.metadata.repairForTaskId === "string") {
        const repairedTask = db.tasks.find((candidate) => candidate.id === mutableTask.metadata.repairForTaskId);
        if (repairedTask !== undefined && repairedTask.status === "blocked") {
          repairedTask.status = "done";
          repairedTask.lastFailureSummary = null;
          repairedTask.lastFailureFingerprint = null;
        }
      }
      if (execution.type === "failed" && execution.failureKind === "timeout" && execution.codeChanges.length > 0) {
        mutableTask.metadata.timeoutContinuationStatus = "pending";
        mutableTask.metadata.timeoutContinuationSummary = execution.summary;
        mutableTask.metadata.timeoutContinuationAgentRunId = agentRun.id;
        mutableTask.metadata.timeoutContinuationLogArtifactId = execution.logArtifactId ?? "";
        mutableTask.metadata.timeoutContinuationCodeChangeCount = String(execution.codeChanges.length);
        mutableTask.metadata.timeoutContinuationRawOutputBytes = String(execution.rawOutputBytes ?? 0);
      } else {
        delete mutableTask.metadata.timeoutContinuationStatus;
        delete mutableTask.metadata.timeoutContinuationSummary;
        delete mutableTask.metadata.timeoutContinuationAgentRunId;
        delete mutableTask.metadata.timeoutContinuationLogArtifactId;
        delete mutableTask.metadata.timeoutContinuationCodeChangeCount;
        delete mutableTask.metadata.timeoutContinuationRawOutputBytes;
      }
    });
    await recordTranscriptAndMaybeSwitchHandoff({
      workSessionId: workSession.id,
      agentRunId: agentRun.id,
      summary: execution.summary,
      transcript: execution.transcript,
    });

    await updateAcceptanceEvidenceForTask({
      taskId: task.id,
      status: execution.type === "completed" ? "satisfied" : "failed",
      source: execution.codeChanges.length > 0 ? "code_change" : "agent_summary",
      note: execution.summary.slice(0, 500),
    });

    await emitEvent({
      workSessionId: workSession.id,
      eventName: execution.type === "completed" ? "task.completed" : "task.failed",
      aggregateType: "task",
      aggregateId: task.id,
      payload: {
        summary: execution.summary,
        agentRunId: agentRun.id,
        failureKind: execution.failureKind ?? "",
        timedOut: execution.timedOut ?? false,
        logArtifactId: execution.logArtifactId ?? "",
        rawOutputBytes: String(execution.rawOutputBytes ?? 0),
        codeChangeCount: String(execution.codeChanges.length),
        continuationRecommended: execution.continuationRecommended ?? false,
        checkpointId: postTaskCheckpoint?.id ?? "",
      },
      context: { taskId: task.id, agentRunId: agentRun.id },
    });
    await emitEvent({
      workSessionId: workSession.id,
      eventName: execution.type === "completed" ? "agent.completed" : "agent.failed",
      aggregateType: "agent_run",
      aggregateId: agentRun.id,
      payload: {
        summary: execution.summary,
        failureKind: execution.failureKind ?? "",
        timedOut: execution.timedOut ?? false,
        logArtifactId: execution.logArtifactId ?? "",
        rawOutputBytes: String(execution.rawOutputBytes ?? 0),
        codeChangeCount: String(execution.codeChanges.length),
        continuationRecommended: execution.continuationRecommended ?? false,
        checkpointId: postTaskCheckpoint?.id ?? "",
      },
      producer: { module: "runtime-adapter", runtimeKind: agentRun.runtimeKind, role: agentRun.role },
      context: { taskId: task.id, agentRunId: agentRun.id },
    });
    for (const change of execution.codeChanges) {
      await emitEvent({
        workSessionId: workSession.id,
        eventName: "code.change.detected",
        aggregateType: "agent_run",
        aggregateId: agentRun.id,
        payload: { filePath: change.filePath, changeKind: change.changeKind },
        producer: { module: "runtime-adapter", runtimeKind: agentRun.runtimeKind, role: agentRun.role },
        context: { taskId: task.id, agentRunId: agentRun.id },
      });
    }
    await mirrorWorkSessionState(workSession.id);

    return {
      status: execution.type,
      agentRun,
      summary: execution.summary,
      failureKind: execution.failureKind,
      timedOut: execution.timedOut,
      logArtifactId: execution.logArtifactId,
      rawOutputBytes: execution.rawOutputBytes,
      codeChangeCount: execution.codeChanges.length,
      continuationRecommended: execution.continuationRecommended,
      checkpointId: postTaskCheckpoint?.id ?? preTaskCheckpoint?.id ?? null,
    };
  } catch (error) {
    const message = chatSummary(error instanceof Error ? error.message : "Unknown runtime error");
    await mutateDatabase((db) => {
      const mutableRun = findRequired(db.agentRuns, (candidate) => candidate.id === agentRun.id, "Agent run");
      mutableRun.status = "failed";
      mutableRun.summary = message;
      markEnded(mutableRun);
      const mutableTask = findRequired(db.tasks, (candidate) => candidate.id === task.id, "Task");
      mutableTask.status = "blocked";
      mutableTask.lastFailureSummary = message;
      mutableTask.lastFailureFingerprint = createHash("sha256").update(compactFailureText(message)).digest("hex").slice(0, 16);
    });
    await recordTranscriptAndMaybeSwitchHandoff({
      workSessionId: workSession.id,
      agentRunId: agentRun.id,
      summary: message,
      transcript: undefined,
    });
    await updateAcceptanceEvidenceForTask({
      taskId: task.id,
      status: "failed",
      source: "agent_summary",
      note: message.slice(0, 500),
    });
    await emitEvent({
      workSessionId: workSession.id,
      eventName: "agent.failed",
      aggregateType: "agent_run",
      aggregateId: agentRun.id,
      payload: { error: message },
      producer: { module: "runtime-adapter", runtimeKind: agentRun.runtimeKind, role: agentRun.role },
      context: { taskId: task.id, agentRunId: agentRun.id },
    });
    await mirrorWorkSessionState(workSession.id);
    return { status: "failed", agentRun, summary: message, failureKind: "environment_failure", codeChangeCount: 0 };
  }
}

function closeActiveAgentRuns(db: AppDatabase, input: {
  workSessionId: Identifier;
  taskId?: Identifier | null;
  exceptAgentRunId?: Identifier | null;
  summary: string;
  status?: "failed" | "canceled";
}): void {
  for (const run of db.agentRuns) {
    if (run.workSessionId !== input.workSessionId) {
      continue;
    }
    if (input.taskId !== undefined && run.taskId !== input.taskId) {
      continue;
    }
    if (input.exceptAgentRunId !== undefined && input.exceptAgentRunId !== null && run.id === input.exceptAgentRunId) {
      continue;
    }
    if (run.status !== "running" && run.status !== "waiting_approval") {
      continue;
    }
    run.status = input.status ?? "failed";
    run.summary = run.summary.trim().length > 0 ? run.summary : input.summary;
    markEnded(run);
  }
}

async function executeResearchSession(
  workSession: WorkSessionRecord,
  runtimeProfile: RuntimeProfileRecord
): Promise<ResearchSessionResult> {
  const config = getConfig();
  const provider = workSession.agentProvider ?? config.agentProvider;
  const model = provider === "ollama"
    ? workSession.runtimeOverrides?.model ?? (config.ollamaModel.trim().length > 0 ? config.ollamaModel.trim() : runtimeProfile.model)
    : provider === "antigravity-cli"
      ? workSession.runtimeOverrides?.model ?? runtimeProfile.model
    : workSession.runtimeOverrides?.model ?? runtimeProfile.model;
  const agentRun = await mutateDatabase((db) => {
    const run = createAgentRunRecord({
      workSessionId: workSession.id,
      taskId: null,
      role: "researcher",
      runtimeKind: runtimeKindForProvider(provider),
      model,
      status: "running",
      summary: "",
    });
    db.agentRuns.push(run);
    return run;
  });

  await emitEvent({
    workSessionId: workSession.id,
    eventName: "agent.started",
    aggregateType: "agent_run",
    aggregateId: agentRun.id,
    payload: { role: agentRun.role, provider, deliveryKind: "research" },
    producer: { module: "research-adapter", runtimeKind: agentRun.runtimeKind, role: agentRun.role },
    context: { agentRunId: agentRun.id },
  });

  try {
    const execution = provider === "codex-cli"
      ? await executeResearchWithCodexCli({ workSession, agentRun })
      : provider === "ollama"
        ? await executeResearchWithOllama({ workSession, agentRun })
        : provider === "claude-code"
          ? await executeResearchWithClaudeCode({ workSession, agentRun })
          : provider === "antigravity-cli"
            ? await executeResearchWithAgy({ workSession, agentRun })
            : {
                type: "failed" as const,
                summary: "Read-only research currently requires the Codex CLI, Claude Code, AGY CLI, or Ollama provider so the researcher can inspect the local workspace.",
                reportArtifact: null,
                logArtifact: null,
                rawOutputBytes: 0,
              };

    await mutateDatabase((db) => {
      const mutableRun = findRequired(db.agentRuns, (candidate) => candidate.id === agentRun.id, "Agent run");
      mutableRun.status = execution.type === "completed" ? "completed" : "failed";
      mutableRun.summary = execution.summary;
      markEnded(mutableRun);
    });
    await recordTranscriptAndMaybeSwitchHandoff({
      workSessionId: workSession.id,
      agentRunId: agentRun.id,
      summary: execution.summary,
      transcript: execution.transcript,
    });

    await emitEvent({
      workSessionId: workSession.id,
      eventName: execution.type === "completed" ? "agent.completed" : "agent.failed",
      aggregateType: "agent_run",
      aggregateId: agentRun.id,
      payload: {
        summary: execution.summary,
        reportArtifactId: execution.reportArtifact?.id ?? "",
        logArtifactId: execution.logArtifact?.id ?? "",
        rawOutputBytes: String(execution.rawOutputBytes),
        deliveryKind: "research",
      },
      producer: { module: "research-adapter", runtimeKind: agentRun.runtimeKind, role: agentRun.role },
      context: { agentRunId: agentRun.id },
    });
    await mirrorWorkSessionState(workSession.id);

    return {
      status: execution.type,
      agentRun,
      summary: execution.summary,
      reportArtifactId: execution.reportArtifact?.id ?? null,
      logArtifactId: execution.logArtifact?.id ?? null,
      rawOutputBytes: execution.rawOutputBytes,
    };
  } catch (error) {
    const message = chatSummary(error instanceof Error ? error.message : "Unknown research runtime error");
    await mutateDatabase((db) => {
      const mutableRun = findRequired(db.agentRuns, (candidate) => candidate.id === agentRun.id, "Agent run");
      mutableRun.status = "failed";
      mutableRun.summary = message;
      markEnded(mutableRun);
    });
    await recordTranscriptAndMaybeSwitchHandoff({
      workSessionId: workSession.id,
      agentRunId: agentRun.id,
      summary: message,
      transcript: undefined,
    });
    await emitEvent({
      workSessionId: workSession.id,
      eventName: "agent.failed",
      aggregateType: "agent_run",
      aggregateId: agentRun.id,
      payload: { error: message, deliveryKind: "research" },
      producer: { module: "research-adapter", runtimeKind: agentRun.runtimeKind, role: agentRun.role },
      context: { agentRunId: agentRun.id },
    });
    await mirrorWorkSessionState(workSession.id);
    return { status: "failed", agentRun, summary: message, reportArtifactId: null, logArtifactId: null, rawOutputBytes: 0 };
  }
}

async function runVerificationForSession(workSession: WorkSessionRecord, plan: PlanRecord | null, signal?: AbortSignal): Promise<VerificationRunRecord> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted by user.");
  }
  const started = await mutateDatabase((db) => {
    const record = createVerificationRunRecord({
      workSessionId: workSession.id,
      planId: plan?.id ?? null,
      status: "running",
      failureKind: "none",
      commands: [],
      summary: "Verification started.",
      rawOutput: "",
    });
    db.verificationRuns.push(record);
    return record;
  });

  await emitEvent({
    workSessionId: workSession.id,
    eventName: "verification.started",
    aggregateType: "verification_run",
    aggregateId: started.id,
    payload: { planId: plan?.id ?? "" },
    producer: { module: "verification-engine", runtimeKind: "codex", role: "verifier" },
    context: { planId: plan?.id, verificationRunId: started.id },
  });

  const result = await executeVerification(
    workSession,
    {
      workSessionId: workSession.id,
      verificationRunId: started.id,
      planId: plan?.id,
    },
    signal
  );

  await mutateDatabase((db) => {
    let record = db.verificationRuns.find((candidate) => candidate.id === started.id);
    if (record === undefined) {
      record = { ...started };
      db.verificationRuns.push(record);
    }
    record.status = result.status;
    record.failureKind = result.failureKind;
    record.commands = result.commands;
    record.summary = result.summary;
    record.rawOutput = result.rawOutput;
    record.commandResults = result.commandResults;
    markEnded(record);
  });

  await emitEvent({
    workSessionId: workSession.id,
    eventName: result.status === "passed" ? "verification.passed" : "verification.failed",
    aggregateType: "verification_run",
    aggregateId: started.id,
    payload: { summary: result.summary, commands: result.commands.join(";"), failureKind: result.failureKind },
    producer: { module: "verification-engine", runtimeKind: "codex", role: "verifier" },
    context: { planId: plan?.id, verificationRunId: started.id },
  });
  await mirrorWorkSessionState(workSession.id);

  return { ...started, status: result.status, failureKind: result.failureKind, commands: result.commands, summary: result.summary, rawOutput: result.rawOutput, commandResults: result.commandResults, endedAt: currentTimestamp() };
}

function renderPreviewIsApplicable(preview: PreviewServerRecord): boolean {
  return preview.status !== "unavailable" && preview.appType !== "node-cli";
}

function previewEvidenceOutput(preview: PreviewServerRecord): string {
  return [
    `Health failure: ${preview.lastFailureReason ?? "(none recorded)"}`,
    `Preview id: ${preview.id}`,
    `Preview status: ${preview.status}`,
    `App type: ${preview.appType}`,
    `Command: ${preview.command}`,
    `URL: ${preview.url || "(none)"}`,
    `Port: ${preview.port}`,
    `Started at: ${preview.startedAt}`,
    `Stopped at: ${preview.stoppedAt ?? "(not stopped)"}`,
    `Last health check: ${preview.lastHealthCheckAt ?? "(none)"}`,
    "",
    "STDOUT tail:",
    preview.stdoutTail.trim() || "(empty)",
    "",
    "STDERR tail:",
    preview.stderrTail.trim() || "(empty)",
  ].join("\n");
}

function classifySnapshotFailure(message: string): VerificationFailureKind {
  return /playwright|chromium|browser|executable|install/i.test(message)
    ? "environment_failure"
    : "functional_failure";
}

function classifyPreviewStartException(message: string): VerificationFailureKind {
  if (/no free preview ports|eaddrinuse|permission denied|eperm|eacces/i.test(message)) {
    return "environment_failure";
  }
  return "functional_failure";
}

async function markVerificationRunFailed(input: {
  workSessionId: Identifier;
  planId: Identifier | null;
  verification: VerificationRunRecord;
  failureKind: VerificationFailureKind;
  summary: string;
  rawOutput: string;
  previewId?: Identifier;
  snapshotId?: Identifier;
}): Promise<VerificationRunRecord> {
  const updated = await mutateDatabase((db) => {
    let record = db.verificationRuns.find((candidate) => candidate.id === input.verification.id);
    if (record === undefined) {
      record = { ...input.verification };
      db.verificationRuns.push(record);
    }
    record.status = "failed";
    record.failureKind = input.failureKind;
    record.summary = input.summary;
    record.rawOutput = [record.rawOutput, input.rawOutput].filter((entry) => entry.trim().length > 0).join("\n---\n");
    if (input.previewId !== undefined) {
      record.previewId = input.previewId;
    }
    markEnded(record);
    return { ...record };
  });
  await emitEvent({
    workSessionId: input.workSessionId,
    eventName: "verification.failed",
    aggregateType: "verification_run",
    aggregateId: input.verification.id,
    payload: {
      summary: input.summary,
      commands: updated.commands.join(";"),
      failureKind: input.failureKind,
      previewId: input.previewId ?? "",
      snapshotId: input.snapshotId ?? "",
    },
    priority: "high",
    producer: { module: "render-verification", runtimeKind: "codex", role: "verifier" },
    context: {
      planId: input.planId ?? undefined,
      verificationRunId: input.verification.id,
      previewId: input.previewId,
      snapshotId: input.snapshotId,
    },
  });
  await mirrorWorkSessionState(input.workSessionId);
  return updated;
}

async function runRenderVerificationGate(input: {
  workSession: WorkSessionRecord;
  plan: PlanRecord | null;
  verification: VerificationRunRecord;
  signal?: AbortSignal;
}): Promise<RenderVerificationGateResult> {
  if (input.signal?.aborted) {
    throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Operation aborted by user.");
  }
  if (input.verification.status !== "passed") {
    return { verification: input.verification, preview: null, snapshotEvidence: null, runtimeStructural: null };
  }

  logProcess("info", "workflow.render_gate.start", {
    workSessionId: input.workSession.id,
    verificationRunId: input.verification.id,
  });

  let preview: PreviewServerRecord;
  try {
    preview = await startPreviewForWorkSession(input.workSession, {
      policy: "reuse_if_safe_with_hard_fallback",
      signal: input.signal,
    });
  } catch (error) {
    if (isWorkSessionOperationAbortedError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown preview start failure.";
    logProcess("error", "workflow.render_gate.preview.exception", {
      workSessionId: input.workSession.id,
      verificationRunId: input.verification.id,
      message,
    });
    const failureKind = classifyPreviewStartException(message);
    const verification = await markVerificationRunFailed({
      workSessionId: input.workSession.id,
      planId: input.plan?.id ?? null,
      verification: input.verification,
      failureKind,
      summary: `Final preview could not be started: ${message}`,
      rawOutput: `Render verification failed while starting the final preview.\n\n${message}`,
    });
    return { verification, preview: null, snapshotEvidence: null, runtimeStructural: null };
  }
  logProcess("info", "workflow.render_gate.preview.completed", {
    workSessionId: input.workSession.id,
    verificationRunId: input.verification.id,
    previewId: preview.id,
    status: preview.status,
    appType: preview.appType,
    url: preview.url,
  });

  if (!renderPreviewIsApplicable(preview)) {
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "task.progress",
      aggregateType: "verification_run",
      aggregateId: input.verification.id,
      payload: {
        message: `Render verification skipped for ${preview.appType}.`,
        previewId: preview.id,
        previewStatus: preview.status,
      },
      producer: { module: "render-verification", runtimeKind: "codex", role: "verifier" },
      context: { planId: input.plan?.id, verificationRunId: input.verification.id, previewId: preview.id },
    });
    return { verification: input.verification, preview, snapshotEvidence: null, runtimeStructural: null };
  }

  if (input.signal?.aborted) {
    throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Operation aborted by user.");
  }
  if (preview.status !== "ready") {
    const failureDetail = preview.lastFailureReason ?? "No failure reason was recorded.";
    const summary = `Final preview failed to become ready for ${preview.appType}. ${failureDetail} The controller will repair the rendered app instead of completing.`;
    const rawOutput = `Render verification failed before snapshot capture.\n\n${previewEvidenceOutput(preview)}`;
    const verification = await markVerificationRunFailed({
      workSessionId: input.workSession.id,
      planId: input.plan?.id ?? null,
      verification: input.verification,
      failureKind: "functional_failure",
      summary,
      rawOutput,
      previewId: preview.id,
    });
    return { verification, preview, snapshotEvidence: null, runtimeStructural: null };
  }

  let snapshotEvidence: CapturePreviewSnapshotResult | null = null;
  try {
    logProcess("info", "workflow.render_gate.snapshot.start", {
      workSessionId: input.workSession.id,
      verificationRunId: input.verification.id,
      previewId: preview.id,
    });
    snapshotEvidence = await capturePreviewSnapshot({
      workSessionId: input.workSession.id,
      previewId: preview.id,
      verificationRunId: input.verification.id,
      reason: "post_verification",
      signal: input.signal,
    });
    if (input.signal?.aborted) {
      throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Operation aborted by user.");
    }
    logProcess("info", "workflow.render_gate.snapshot.completed", {
      workSessionId: input.workSession.id,
      verificationRunId: input.verification.id,
      previewId: preview.id,
      snapshotId: snapshotEvidence.snapshotId,
      status: snapshotEvidence.status,
      screenshotArtifactId: snapshotEvidence.screenshotArtifact?.id ?? null,
      domArtifactId: snapshotEvidence.domArtifact?.id ?? null,
      reportArtifactId: snapshotEvidence.reportArtifact?.id ?? null,
    });
  } catch (error) {
    if (isWorkSessionOperationAbortedError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown snapshot capture failure.";
    snapshotEvidence = {
      snapshotId: "snapshot-not-created",
      status: "failed",
      preview,
      screenshotArtifact: null,
      domArtifact: null,
      reportArtifact: null,
      inspection: null,
      failureSummary: message,
    };
  }

  if (snapshotEvidence.status === "failed" || snapshotEvidence.inspection === null) {
    const failureSummary = snapshotEvidence.failureSummary ?? "Snapshot capture failed.";
    const failureKind = classifySnapshotFailure(failureSummary);
    const summary = `Render verification could not capture required preview evidence: ${failureSummary}`;
    const rawOutput = [
      "Render verification failed during snapshot capture.",
      "",
      previewEvidenceOutput(preview),
      "",
      `Snapshot id: ${snapshotEvidence.snapshotId}`,
      `Snapshot status: ${snapshotEvidence.status}`,
      `Snapshot failure: ${failureSummary}`,
    ].join("\n");
    const verification = await markVerificationRunFailed({
      workSessionId: input.workSession.id,
      planId: input.plan?.id ?? null,
      verification: input.verification,
      failureKind,
      summary,
      rawOutput,
      previewId: preview.id,
      snapshotId: snapshotEvidence.snapshotId,
    });
    return { verification, preview, snapshotEvidence, runtimeStructural: null };
  }

  await markWorkSessionServableIfFirst(input.workSession, 200, "render_gate_snapshot");

  const runtimeStructural = await runFunctionalVerification({
    workSession: input.workSession,
    preview,
    verificationRunId: input.verification.id,
    capture: snapshotEvidence,
    forceEnabled: true,
    signal: input.signal,
  });
  if (input.signal?.aborted) {
    throw input.signal.reason instanceof Error ? input.signal.reason : new Error("Operation aborted by user.");
  }
  logProcess("info", "workflow.render_gate.dom.completed", {
    workSessionId: input.workSession.id,
    verificationRunId: input.verification.id,
    previewId: preview.id,
    snapshotId: snapshotEvidence.snapshotId,
    status: runtimeStructural.status,
    failureKind: runtimeStructural.failureKind,
  });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "task.progress",
    aggregateType: "verification_run",
    aggregateId: input.verification.id,
    payload: {
      message: `Runtime DOM/AX structural verification: ${runtimeStructural.status}. ${runtimeStructural.summary}`,
      status: runtimeStructural.status,
      summary: runtimeStructural.summary,
      previewId: preview.id,
      snapshotId: snapshotEvidence.snapshotId,
      screenshotArtifactId: snapshotEvidence.screenshotArtifact?.id ?? "",
      domArtifactId: snapshotEvidence.domArtifact?.id ?? "",
      reportArtifactId: snapshotEvidence.reportArtifact?.id ?? "",
    },
    producer: { module: "functional-verification", runtimeKind: "codex", role: "verifier" },
    context: { verificationRunId: input.verification.id, previewId: preview.id, snapshotId: snapshotEvidence.snapshotId },
  });

  if (runtimeStructural.status === "failed") {
    const summary = runtimeStructural.summary;
    const rawOutput = [
      "Render verification failed after snapshot capture.",
      "",
      previewEvidenceOutput(preview),
      "",
      runtimeStructural.rawOutput,
    ].join("\n");
    const verification = await markVerificationRunFailed({
      workSessionId: input.workSession.id,
      planId: input.plan?.id ?? null,
      verification: input.verification,
      failureKind: runtimeStructural.failureKind,
      summary,
      rawOutput,
      previewId: preview.id,
      snapshotId: snapshotEvidence.snapshotId,
    });
    return { verification, preview, snapshotEvidence, runtimeStructural };
  }

  logProcess("info", "workflow.render_gate.completed", {
    workSessionId: input.workSession.id,
    verificationRunId: input.verification.id,
    previewId: preview.id,
    snapshotId: snapshotEvidence.snapshotId,
  });
  return { verification: input.verification, preview, snapshotEvidence, runtimeStructural };
}

async function startProbePreviewIfEnabled(workSession: WorkSessionRecord): Promise<void> {
  const config = getConfig();
  if (!config.functionalVerificationEnabled && !config.snapshotCaptureEnabled) {
    logProcess("info", "workflow.probe_preview.skipped", {
      workSessionId: workSession.id,
      functionalVerificationEnabled: config.functionalVerificationEnabled,
      snapshotCaptureEnabled: config.snapshotCaptureEnabled,
    });
    return;
  }
  try {
    logProcess("info", "workflow.probe_preview.start", {
      workSessionId: workSession.id,
      functionalVerificationEnabled: config.functionalVerificationEnabled,
      snapshotCaptureEnabled: config.snapshotCaptureEnabled,
    });
    const preview = await startPreviewForWorkSession(workSession, { mode: "probe" });
    logProcess("info", "workflow.probe_preview.completed", {
      workSessionId: workSession.id,
      previewId: preview.id,
      status: preview.status,
      url: preview.url,
    });
    await emitEvent({
      workSessionId: workSession.id,
      eventName: "task.progress",
      aggregateType: "preview_server",
      aggregateId: preview.id,
      payload: {
        message: preview.status === "ready"
          ? `Probe preview is ready at ${preview.url}.`
          : `Probe preview recorded status ${preview.status}.`,
        previewId: preview.id,
        status: preview.status,
      },
      producer: { module: "preview-manager" },
      context: { previewId: preview.id },
    });
  } catch (error) {
    logProcess("warn", "workflow.probe_preview.failed", {
      workSessionId: workSession.id,
      message: error instanceof Error ? error.message : "unknown preview error",
    });
    await emitEvent({
      workSessionId: workSession.id,
      eventName: "task.progress",
      aggregateType: "work_session",
      aggregateId: workSession.id,
      payload: {
        message: `Probe preview could not start: ${error instanceof Error ? error.message : "unknown preview error"}`,
      },
      producer: { module: "preview-manager" },
    });
  }
}

const renderProbeBaselines = new Map<Identifier, boolean>();

async function markWorkSessionServableIfFirst(
  workSession: WorkSessionRecord,
  httpStatus: number,
  source: string,
): Promise<void> {
  if (httpStatus >= 400 || (workSession.previewFirstServableAt ?? null) !== null) {
    return;
  }
  const servableAt = await mutateDatabase((db) => {
    const record = db.workSessions.find((candidate) => candidate.id === workSession.id);
    if (record === undefined || (record.previewFirstServableAt ?? null) !== null) {
      return null;
    }
    record.previewFirstServableAt = currentTimestamp();
    return record.previewFirstServableAt;
  });
  if (servableAt !== null) {
    workSession.previewFirstServableAt = servableAt;
    logProcess("info", "workflow.preview.first_servable", {
      workSessionId: workSession.id,
      httpStatus,
      source,
    });
  }
}

async function detectPostTaskRenderRegression(
  workSession: WorkSessionRecord,
  task: TaskRecord,
  result: TaskExecutionResult,
): Promise<TaskExecutionResult | null> {
  if (result.codeChangeCount <= 0) {
    return null;
  }
  let preview: PreviewServerRecord;
  try {
    preview = await startPreviewForWorkSession(workSession, { mode: "probe" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown preview start error.";
    logProcess("warn", "workflow.render_probe.boot_exception", {
      workSessionId: workSession.id,
      taskId: task.id,
      message: message.slice(0, 4000),
    });
    await emitEvent({
      workSessionId: workSession.id,
      eventName: "task.progress",
      aggregateType: "task",
      aggregateId: task.id,
      payload: {
        message: `Post-task render probe could not boot a preview after '${task.title}' (probe skipped; not a task failure): ${message.slice(0, 600)}${message.length > 600 ? "… (full output in process logs)" : ""}`,
        mode: "render_probe_diagnostic",
      },
      context: { taskId: task.id },
    });
    return null;
  }
  if (stackCapabilities(preview.appType).previewSurface !== "live-web") {
    return null;
  }
  const baselineHealthy = renderProbeBaselines.get(workSession.id) === true;
  if (preview.status !== "ready") {
    if (!baselineHealthy) {
      return null;
    }
    renderProbeBaselines.set(workSession.id, false);
    logProcess("warn", "workflow.render_probe.boot_regression", {
      workSessionId: workSession.id,
      taskId: task.id,
      previewId: preview.id,
      reason: preview.lastFailureReason ?? "(none recorded)",
    });
    return {
      ...result,
      status: "failed",
      failureKind: "runtime_failure",
      summary: `Post-task render probe: the app stopped booting after task '${task.title}', although it booted and served the home page after a previous task — this task's changes broke the boot chain. Boot failure: ${preview.lastFailureReason ?? "(none recorded)"}\n\n${previewRuntimeLogEvidence(preview)}`,
    };
  }
  let httpStatus: number;
  try {
    const response = await fetch(preview.url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    httpStatus = response.status;
  } catch {
    return null;
  }
  await markWorkSessionServableIfFirst(workSession, httpStatus, "render_probe");
  if (httpStatus < 500) {
    renderProbeBaselines.set(workSession.id, true);
    return null;
  }
  if (!baselineHealthy) {
    logProcess("info", "workflow.render_probe.unhealthy_no_baseline", {
      workSessionId: workSession.id,
      taskId: task.id,
      httpStatus,
    });
    return null;
  }
  renderProbeBaselines.set(workSession.id, false);
  logProcess("warn", "workflow.render_probe.regression", {
    workSessionId: workSession.id,
    taskId: task.id,
    previewId: preview.id,
    httpStatus,
  });
  return {
    ...result,
    status: "failed",
    failureKind: "runtime_failure",
    summary: `Post-task render probe: the home page regressed after task '${task.title}' — GET ${preview.url} returned HTTP ${httpStatus}, and it was healthy after a previous task, so this task's changes broke it. Diagnose from the server traceback in the runtime logs below and fix the regression without rewriting unrelated work.\n\n${previewRuntimeLogEvidence(preview)}`,
  };
}

async function wakeIdleStoppedPreviewForDevelopment(workSession: WorkSessionRecord): Promise<void> {
  const idleStoppedPreview = await mutateDatabase((db) => {
    const previews = db.previewServers
      .filter((preview) => preview.workSessionId === workSession.id)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    const latest = previews[0] ?? null;
    return latest !== null && latest.status === "stopped" && latest.stoppedReason === "idle_timeout"
      ? { ...latest }
      : null;
  });
  if (idleStoppedPreview === null) {
    return;
  }
  try {
    logProcess("info", "workflow.preview.wake_idle_stopped.start", {
      workSessionId: workSession.id,
      previewId: idleStoppedPreview.id,
    });
    const preview = await startPreviewForWorkSession(workSession, {
      mode: "probe",
      policy: "refresh_existing_or_start",
    });
    await emitEvent({
      workSessionId: workSession.id,
      eventName: "task.progress",
      aggregateType: "preview_server",
      aggregateId: preview.id,
      payload: {
        message: preview.status === "ready"
          ? `Idle-stopped preview restarted for continued development at ${preview.url}.`
          : `Idle-stopped preview wake recorded status ${preview.status}.`,
        previewId: preview.id,
        status: preview.status,
      },
      producer: { module: "preview-manager" },
      context: { previewId: preview.id },
    });
  } catch (error) {
    logProcess("warn", "workflow.preview.wake_idle_stopped.failed", {
      workSessionId: workSession.id,
      previewId: idleStoppedPreview.id,
      message: error instanceof Error ? error.message : "unknown preview error",
    });
  }
}

async function resumeWorkSession(workSessionId: Identifier): Promise<ControllerResult> {
  const resumed = await mutateDatabase((db) => {
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
    const chatSession = findRequired(db.chatSessions, (candidate) => candidate.id === workSession.chatSessionId, "Chat session");
    const plan = latestPlanForSession(db, workSession.id);
    const tasks = plan === null ? [] : tasksForPlan(db, plan.id);
    const pendingApproval = db.approvals.find((approval) => approval.workSessionId === workSession.id && approval.status === "pending");
    const incompleteTasks = tasks.filter((task) => task.status !== "done" && task.status !== "skipped");

    if (pendingApproval !== undefined) {
      workSession.currentState = "awaiting_approval";
    } else if (plan === null) {
      workSession.currentState = "planning";
    } else if (plan.status !== "approved" && plan.status !== "completed") {
      workSession.currentState = "awaiting_approval";
    } else if (incompleteTasks.length > 0) {
      for (const task of incompleteTasks) {
        if (task.status === "blocked") {
          task.status = "todo";
        }
      }
      workSession.planModeEnabled = false;
      workSession.currentState = "executing";
    } else if (plan.status === "completed") {
      workSession.currentState = "completed";
    } else {
      workSession.currentState = "verifying";
    }

    workSession.executionMode = "resume";
    workSession.paused = false;
    workSession.awaitingStep = false;
    workSession.nextActionLabel = null;
    updateWorkSessionTimestamp(workSession);
    return {
      chatSessionId: chatSession.id,
      state: workSession.currentState,
      planId: plan?.id ?? null,
      incompleteTaskCount: incompleteTasks.length,
      pendingApprovalId: pendingApproval?.id ?? null,
    };
  });

  await emitEvent({
    workSessionId,
    eventName: "session.resumed",
    aggregateType: "work_session",
    aggregateId: workSessionId,
    payload: {
      state: resumed.state,
      incompleteTaskCount: resumed.incompleteTaskCount,
      pendingApprovalId: resumed.pendingApprovalId ?? "",
    },
    context: { planId: resumed.planId ?? undefined, approvalId: resumed.pendingApprovalId ?? undefined },
  });
  await addAssistantMessage(
    resumed.chatSessionId,
    resumed.pendingApprovalId === null
      ? `Resumed the durable work session from state '${resumed.state}'.`
      : "Resumed the durable work session. A pending approval must be resolved before execution can continue."
  );
  await mirrorWorkSessionState(workSessionId);

  if (resumed.state === "executing" || resumed.state === "planning" || resumed.state === "verifying") {
    scheduleControllerAdvance(workSessionId, "chat-resume");
    return { workSessionId, chatSessionId: resumed.chatSessionId, state: resumed.state, steps: ["resumed-background"] };
  }

  return { workSessionId, chatSessionId: resumed.chatSessionId, state: resumed.state, steps: ["resumed"] };
}

export async function handleUserMessage(input: {
  content: string;
  projectId?: Identifier;
  chatSessionId?: Identifier;
  attachments?: UploadedAttachment[];
}): Promise<ControllerResult> {
  const uploadedAttachments = input.attachments ?? [];
  const content = input.content.trim().length > 0
    ? input.content.trim()
    : uploadedAttachments.length > 0
      ? "Use the attached file(s) as reference material for this request."
      : "";
  if (content.length === 0) {
    throw new Error("Message content is empty.");
  }
  const intent = classifyMessage(content);

  const seed = await mutateDatabase((db) => {
    const user: UserRecord = db.users[0] ?? findRequired(db.users, () => true, "User");
    const project: ProjectRecord = input.projectId !== undefined
      ? findRequired(db.projects, (candidate) => candidate.id === input.projectId, "Project")
      : findRequired(db.projects, () => true, "Project");
    const chatSession: ChatSessionRecord = input.chatSessionId !== undefined
      ? findRequired(db.chatSessions, (candidate) => candidate.id === input.chatSessionId, "Chat session")
      : findRequired(db.chatSessions, (candidate) => candidate.projectId === project.id, "Chat session");
    const runtimeProfile: RuntimeProfileRecord = findRequired(
      db.runtimeProfiles,
      (candidate) => candidate.projectId === project.id,
      "Runtime profile"
    );
    const workSession: WorkSessionRecord = findRequired(
      db.workSessions,
      (candidate) => candidate.chatSessionId === chatSession.id && candidate.projectId === project.id,
      "Work session"
    );

    const routeAsSteering = shouldRouteMessageAsSteering(db, workSession, intent);
    const activeRun = runningAgentForSession(db, workSession.id);
    const latestPlan = latestPlanForSession(db, workSession.id);
    let materialize: PendingMaterializedAttachment[] = [];
    let directTask: TaskRecord | null = null;
    logProcess("info", "steering.route.decision", {
      workSessionId: workSession.id,
      chatSessionId: chatSession.id,
      intent,
      currentState: workSession.currentState,
      routeAsSteering,
      activeRunId: activeRun?.id ?? "",
      activeRunTaskId: activeRun?.taskId ?? "",
      latestPlanId: latestPlan?.id ?? "",
      latestPlanStatus: latestPlan?.status ?? "",
      contentExcerpt: steeringContentExcerpt(content),
    });

    const userMessage = createChatMessage({
      chatSessionId: chatSession.id,
      role: "user",
      content,
      messageKind: routeAsSteering ? "steering" : "chat",
      relatedEventId: null,
      attachments: [],
    });
    if (uploadedAttachments.length > 0) {
      const builtAttachments = buildChatAttachmentRecords({
        workSession,
        messageId: userMessage.id,
        uploads: uploadedAttachments,
        artifacts: db.artifacts,
      });
      userMessage.attachments = builtAttachments.attachments;
      materialize = builtAttachments.materialize;
    }
    db.chatMessages.push(userMessage);
    if (shouldRenameChatSession(chatSession.title)) {
      chatSession.title = titleFromMessage(content);
    }
    chatSession.updatedAt = currentTimestamp();
    const pendingPlanApproval = db.approvals.find(
      (approval) => approval.workSessionId === workSession.id && approval.approvalKind === "plan" && approval.status === "pending"
    );
    const deliveryKind = classifyDeliveryKindForInput(content, uploadedAttachments);
    const shouldCreateDirectTask =
      intent === "new-work" &&
      !routeAsSteering &&
      !workSession.planModeEnabled &&
      deliveryKind === "implementation" &&
      pendingPlanApproval === undefined &&
      activeRun === null &&
      latestPlan !== null &&
      (latestPlan.status === "approved" || latestPlan.status === "completed");
    const shouldStartFreshPlan =
      intent === "new-work" &&
      !routeAsSteering &&
      !shouldCreateDirectTask &&
      (
        ["blocked", "completed", "failed", "canceled", "handoff_needed"].includes(workSession.currentState) ||
        (
          ["queued", "executing", "verifying", "awaiting_approval"].includes(workSession.currentState) &&
          pendingPlanApproval === undefined &&
          (latestPlan === null || latestPlan.status !== "draft")
        )
      );

    if (routeAsSteering) {
      const steering = createSteeringMessageRecord({
        workSessionId: workSession.id,
        chatSessionId: chatSession.id,
        taskId: activeRun?.taskId ?? null,
        agentRunId: activeRun?.id ?? null,
        content,
        attachments: userMessage.attachments,
        status: "pending",
        applyMode: "next_boundary",
      });
      db.steeringMessages.push(steering);
      logProcess("info", "steering.persisted", {
        workSessionId: workSession.id,
        chatSessionId: chatSession.id,
        steeringId: steering.id,
        taskId: steering.taskId ?? "",
        agentRunId: steering.agentRunId ?? "",
        applyMode: steering.applyMode,
        status: steering.status,
        contentExcerpt: steeringContentExcerpt(content),
      });
      updateWorkSessionTimestamp(workSession);
      return { user, project, chatSession, runtimeProfile, workSession, steering, directTask: null, materialize, attachmentCount: userMessage.attachments.length };
    } else {
      workSession.lastUserMessage = content;
      workSession.deliveryKind = deliveryKind;
      if (shouldCreateDirectTask && latestPlan !== null) {
        directTask = createDirectFollowUpTask({
          db,
          workSession,
          plan: latestPlan,
          content,
          attachments: userMessage.attachments,
        });
      } else if (intent !== "resume" && shouldStartFreshPlan) {
        workSession.currentState = "intake";
        workSession.activePlanId = null;
      }
    }
    updateWorkSessionTimestamp(workSession);
    return { user, project, chatSession, runtimeProfile, workSession, steering: null, directTask, materialize, attachmentCount: userMessage.attachments.length };
  });

  await materializeChatAttachments(seed.materialize);

  await emitEvent({
    workSessionId: seed.workSession.id,
    eventName: "chat.message.received",
    aggregateType: "chat_session",
    aggregateId: seed.chatSession.id,
    payload: { content, attachmentCount: String(seed.attachmentCount) },
  });

  await emitEvent({
    workSessionId: seed.workSession.id,
    eventName: "intent.classified",
    aggregateType: "work_session",
    aggregateId: seed.workSession.id,
    payload: { intent, deliveryKind: seed.workSession.deliveryKind },
  });

  if (seed.steering !== null) {
    await emitSteeringEvent({
      workSessionId: seed.workSession.id,
      eventName: "steering.received",
      steeringId: seed.steering.id,
      taskId: seed.steering.taskId,
      agentRunId: seed.steering.agentRunId,
      message: steeringContentExcerpt(content),
      applyMode: "next_boundary",
    });
    const liveSteer = await steerWorkSessionProcess(seed.workSession.id, {
      steeringId: seed.steering.id,
      clientUserMessageId: seed.steering.id,
      content,
    });
    if (liveSteer.ok) {
      await mutateDatabase((db) => {
        const message = db.steeringMessages.find((candidate) => candidate.id === seed.steering?.id);
        if (message !== undefined) {
          message.status = "applied";
          message.applyMode = "live_steer_attempted";
          message.delivery = "live";
          message.appliedAt = currentTimestamp();
          message.codexThreadId = typeof liveSteer.data?.threadId === "string" ? liveSteer.data.threadId : message.codexThreadId ?? null;
          message.codexTurnId = typeof liveSteer.data?.turnId === "string" ? liveSteer.data.turnId : message.codexTurnId ?? null;
          message.failureReason = null;
        }
      });
      await emitSteeringEvent({
        workSessionId: seed.workSession.id,
        eventName: "steering.applied",
        steeringId: seed.steering.id,
        taskId: seed.steering.taskId,
        agentRunId: seed.steering.agentRunId,
        message: "Sent live steering to the active Codex turn.",
        applyMode: "live_steer_attempted",
        extra: {
          delivery: "live",
          threadId: typeof liveSteer.data?.threadId === "string" ? liveSteer.data.threadId : "",
          turnId: typeof liveSteer.data?.turnId === "string" ? liveSteer.data.turnId : "",
        },
      });
      await addAssistantMessage(seed.chatSession.id, "Sent your steering to the active Codex turn.");
      await mirrorWorkSessionState(seed.workSession.id);
      return { workSessionId: seed.workSession.id, chatSessionId: seed.chatSession.id, state: seed.workSession.currentState, steps: ["steering-live"] };
    }
    await mutateDatabase((db) => {
      const message = db.steeringMessages.find((candidate) => candidate.id === seed.steering?.id);
      if (message !== undefined) {
        message.delivery = "queued";
        message.failureReason = liveSteer.message;
      }
    });
    await emitSteeringEvent({
      workSessionId: seed.workSession.id,
      eventName: "steering.queued",
      steeringId: seed.steering.id,
      taskId: seed.steering.taskId,
      agentRunId: seed.steering.agentRunId,
      message: liveSteer.message === "No live agent process supports this control request."
        ? "Queued for the next provider prompt boundary."
        : `Live steering was not accepted; queued for the next provider prompt boundary. ${liveSteer.message}`,
      applyMode: "next_boundary",
      extra: { delivery: "queued", liveFailure: liveSteer.message },
    });
    await addAssistantMessage(seed.chatSession.id, "Queued your steering for the next provider step. Use Apply now if you want to interrupt the current run and restart the task with this guidance.");
    await mirrorWorkSessionState(seed.workSession.id);
    return { workSessionId: seed.workSession.id, chatSessionId: seed.chatSession.id, state: seed.workSession.currentState, steps: ["steering-queued"] };
  }

  if (seed.directTask !== null) {
    await emitEvent({
      workSessionId: seed.workSession.id,
      eventName: "task.queued",
      aggregateType: "task",
      aggregateId: seed.directTask.id,
      payload: { title: seed.directTask.title, reason: "Plan mode is off; follow-up request was queued directly for execution." },
      context: { planId: seed.directTask.planId, taskId: seed.directTask.id },
    });
    await addAssistantMessage(seed.chatSession.id, `Plan mode is off, so I queued your follow-up directly as task '${seed.directTask.title}'.`);
    await mirrorWorkSessionState(seed.workSession.id);
    scheduleControllerAdvance(seed.workSession.id, "plan-mode-off-direct-task");
    return {
      workSessionId: seed.workSession.id,
      chatSessionId: seed.chatSession.id,
      state: "executing",
      steps: ["plan-mode-off-direct-task-background"],
    };
  }

  if (intent === "cancel") {
    await transitionWorkSession(seed.workSession.id, "canceled");
    await emitEvent({
      workSessionId: seed.workSession.id,
      eventName: "session.canceled",
      aggregateType: "work_session",
      aggregateId: seed.workSession.id,
      payload: { reason: "User requested cancel." },
    });
    await addAssistantMessage(seed.chatSession.id, "Canceled the active work session.");
    return { workSessionId: seed.workSession.id, chatSessionId: seed.chatSession.id, state: "canceled", steps: ["canceled"] };
  }

  if (intent === "resume") {
    return resumeWorkSession(seed.workSession.id);
  }

  if (intent === "handoff") {
    await createHandoff(seed.workSession.id, "User requested handoff summary.");
    await transitionWorkSession(seed.workSession.id, "handoff_needed");
    await addAssistantMessage(seed.chatSession.id, "Created a handoff summary from the current durable state.");
    return { workSessionId: seed.workSession.id, chatSessionId: seed.chatSession.id, state: "handoff_needed", steps: ["handoff"] };
  }

  if (intent === "explain") {
    await addAssistantMessage(seed.chatSession.id, "I checked the event log and artifacts. Use the Timeline and Artifacts panels to inspect the latest backend state and verification output.");
    return { workSessionId: seed.workSession.id, chatSessionId: seed.chatSession.id, state: seed.workSession.currentState, steps: ["explained"] };
  }

  scheduleControllerAdvance(seed.workSession.id, "chat-message");
  return {
    workSessionId: seed.workSession.id,
    chatSessionId: seed.chatSession.id,
    state: seed.workSession.currentState,
    steps: ["controller-background"],
  };
}

export async function approveOrRejectApproval(input: {
  approvalId: Identifier;
  status: "approved" | "rejected";
  userId?: Identifier;
  note?: string;
}, options: { advance?: "sync" | "background" | "none" } = {}): Promise<ControllerResult> {
  const updated = await mutateDatabase((db) => {
    const approval = findRequired(db.approvals, (candidate) => candidate.id === input.approvalId, "Approval");
    approval.status = input.status;
    approval.resolvedAt = currentTimestamp();
    approval.resolvedBy = input.userId ?? db.users[0]?.id ?? null;

    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === approval.workSessionId, "Work session");
    const chatSession = findRequired(db.chatSessions, (candidate) => candidate.id === workSession.chatSessionId, "Chat session");

    let approvedPlanId: Identifier | null = null;
    if (approval.approvalKind === "plan" && input.status === "approved") {
      const planId = typeof approval.payload.planId === "string" ? approval.payload.planId : workSession.activePlanId;
      if (planId !== null) {
        const plan = findRequired(db.plans, (candidate) => candidate.id === planId, "Plan");
        plan.status = "approved";
        plan.approvedAt = currentTimestamp();
        approvedPlanId = plan.id;
      }
      workSession.planModeEnabled = false;
      workSession.currentState = "executing";
    } else if (input.status === "approved") {
      workSession.currentState = "executing";
    }

    if (input.status === "rejected") {
      workSession.currentState = "blocked";
      db.chatMessages.push(
        createChatMessage({
          chatSessionId: chatSession.id,
          role: "assistant",
          content: `Approval was rejected${input.note ? `: ${input.note}` : "."} The session is blocked until you send a new instruction.`,
          messageKind: "chat",
          relatedEventId: null,
        })
      );
    }
    updateWorkSessionTimestamp(workSession);
    return { workSessionId: workSession.id, chatSessionId: chatSession.id, approvalKind: approval.approvalKind, approvedPlanId };
  });

  await emitEvent({
    workSessionId: updated.workSessionId,
    eventName: input.status === "approved" ? "approval.approved" : "approval.rejected",
    aggregateType: "approval",
    aggregateId: input.approvalId,
    payload: { note: input.note ?? "", approvalKind: updated.approvalKind },
    context: { approvalId: input.approvalId },
  });
  await mirrorWorkSessionState(updated.workSessionId);

  if (input.status === "approved") {
    if (updated.approvedPlanId !== null) {
      await ensurePlanApprovalCheckpoint(updated.workSessionId, updated.approvedPlanId);
      await emitEvent({
        workSessionId: updated.workSessionId,
        eventName: "plan.approved",
        aggregateType: "plan",
        aggregateId: updated.approvedPlanId,
        payload: { automatic: false },
        context: { planId: updated.approvedPlanId, approvalId: input.approvalId },
      });
    }
    await addAssistantMessage(updated.chatSessionId, "Approval recorded. I am continuing the backend controller loop.");
    const advanceMode = options.advance ?? "sync";
    if (advanceMode === "background") {
      scheduleControllerAdvance(updated.workSessionId, "approval-approved");
      return { workSessionId: updated.workSessionId, chatSessionId: updated.chatSessionId, state: "executing", steps: ["approval-approved-background"] };
    }
    if (advanceMode === "none") {
      return { workSessionId: updated.workSessionId, chatSessionId: updated.chatSessionId, state: "executing", steps: ["approval-approved"] };
    }
    return advanceController(updated.workSessionId);
  }

  return { workSessionId: updated.workSessionId, chatSessionId: updated.chatSessionId, state: "blocked", steps: ["approval-rejected"] };
}

async function revisePlan(input: {
  workSessionId: Identifier;
  planId: Identifier;
  rawPlanJson: unknown;
}): Promise<{ chatSessionId: Identifier; approvalId: Identifier; version: number; taskCount: number }> {
  const revised = await mutateDatabase((db) => {
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === input.workSessionId, "Work session");
    const chatSession = findRequired(db.chatSessions, (candidate) => candidate.id === workSession.chatSessionId, "Chat session");
    const plan = findRequired(db.plans, (candidate) => candidate.id === input.planId, "Plan");

    if (plan.workSessionId !== workSession.id) {
      throw new PlanNotEditableError("The plan does not belong to this work session.");
    }
    if (plan.status !== "draft") {
      throw new PlanNotEditableError(`Plan v${plan.version} is ${plan.status} and can no longer be edited.`);
    }

    const planTasks = db.tasks.filter((task) => task.planId === plan.id);
    if (planTasks.some((task) => task.status !== "todo")) {
      throw new PlanNotEditableError("Execution has already started, so the plan can no longer be edited.");
    }

    const approval = db.approvals.find(
      (candidate) => candidate.workSessionId === workSession.id && candidate.approvalKind === "plan" && candidate.status === "pending"
    );
    if (approval === undefined) {
      throw new PlanNotEditableError("There is no pending plan approval to edit.");
    }

    const validation = validateAndNormalizeEditedPlan(input.rawPlanJson, plan.planJson);
    if (!validation.ok) {
      throw new PlanValidationError(validation.errors);
    }
    assertPlanTargetsStayInsideWorkspace(workSession, validation.plan);

    db.tasks = db.tasks.filter((task) => task.planId !== plan.id);
    validation.plan.tasks.forEach((task, index) => {
      db.tasks.push(
        createTaskRecord({
          planId: plan.id,
          parentTaskId: null,
          ordinal: index + 1,
          title: task.title,
          description: task.description,
          status: "todo",
          acceptanceCriteria: task.acceptanceCriteria,
          metadata: {
            objective: task.objective ?? task.description,
            taskKind: task.taskKind ?? "modify",
            targetFiles: task.targetFiles ?? [],
            expectedChanges: task.expectedChanges ?? [],
            verificationHints: task.verificationHints ?? [],
            riskLevel: task.riskLevel ?? "low",
          },
        })
      );
    });

    plan.planJson = validation.plan;
    plan.title = validation.plan.title;
    plan.goal = validation.plan.goal;
    plan.planMarkdown = planToMarkdown(validation.plan);

    workSession.executionMode = chooseExecutionMode();
    updateWorkSessionTimestamp(workSession);

    return {
      chatSessionId: chatSession.id,
      approvalId: approval.id,
      version: plan.version,
      taskCount: validation.plan.tasks.length,
      title: plan.title,
      planMarkdown: plan.planMarkdown,
    };
  });

  await saveArtifact({
    workSessionId: input.workSessionId,
    kind: "plan",
    fileName: `plan-v${revised.version}-${input.planId}.md`,
    content: revised.planMarkdown,
    metadata: { planId: input.planId, version: revised.version, edited: true },
  });
  await emitEvent({
    workSessionId: input.workSessionId,
    eventName: "plan.updated",
    aggregateType: "plan",
    aggregateId: input.planId,
    payload: { title: revised.title, taskCount: revised.taskCount, editedByUser: true },
    context: { planId: input.planId },
  });
  await addAssistantMessage(revised.chatSessionId, `Saved your edited plan '${revised.title}' with ${revised.taskCount} ${revised.taskCount === 1 ? "task" : "tasks"} and started execution.`);
  await mirrorWorkSessionState(input.workSessionId);

  return { chatSessionId: revised.chatSessionId, approvalId: revised.approvalId, version: revised.version, taskCount: revised.taskCount };
}

export async function setPlanStack(input: {
  workSessionId: Identifier;
  planId: Identifier;
  stack: unknown;
}): Promise<{ stack: ProjectStack; rescaffolded: boolean; note: string }> {
  if (!isAllowedTargetStack(input.stack)) {
    throw new PlanValidationError([`Unknown stack value: ${String(input.stack)}.`]);
  }
  const stack = input.stack;
  const { workSession, plan, previousStack } = await mutateDatabase((db) => {
    const session = findRequired(db.workSessions, (candidate) => candidate.id === input.workSessionId, "Work session");
    const planRecord = findRequired(db.plans, (candidate) => candidate.id === input.planId, "Plan");
    if (planRecord.workSessionId !== session.id) {
      throw new PlanNotEditableError("The plan does not belong to this work session.");
    }
    if (planRecord.status !== "draft" && planRecord.status !== "approved") {
      throw new PlanNotEditableError(`Plan v${planRecord.version} is ${planRecord.status}; the stack can no longer be changed.`);
    }
    const planTasks = db.tasks.filter((task) => task.planId === planRecord.id);
    if (planTasks.some((task) => task.status !== "todo")) {
      throw new PlanNotEditableError("Execution has already started, so the stack can no longer be changed. Fork the session to rebuild on a different stack.");
    }
    const previous = workSessionStackOf(session);
    session.stackDecision = {
      stack,
      source: "user",
      confidence: "high",
      rationale: "Selected by the operator from the plan card.",
      decidedAt: new Date().toISOString(),
    };
    planRecord.planJson = { ...planRecord.planJson, targetStack: stack };
    updateWorkSessionTimestamp(session);
    return { workSession: session, plan: planRecord, previousStack: previous };
  });

  let rescaffolded = false;
  let note = "";
  if (previousStack !== stack) {
    const result = await rescaffoldWorkspaceForStack(workSession, stack);
    rescaffolded = result.rescaffolded;
    note = result.reason;
    if (result.rescaffolded) {
      await mutateDatabase((db) => {
        const session = findRequired(db.workSessions, (candidate) => candidate.id === input.workSessionId, "Work session");
        session.scaffoldManifest = result.filesCreated;
      });
    }
  }

  await emitEvent({
    workSessionId: input.workSessionId,
    eventName: "plan.stack.changed",
    aggregateType: "plan",
    aggregateId: plan.id,
    payload: {
      previousStack: previousStack ?? "",
      stack,
      rescaffolded,
      note,
    },
    producer: { module: "workflow-controller" },
  });
  return { stack, rescaffolded, note };
}

function workSessionStackOf(session: WorkSessionRecord): ProjectStack | null {
  return session.stackDecision?.stack ?? null;
}

export async function saveEditedPlanAndRun(input: {
  workSessionId: Identifier;
  planId: Identifier;
  planJson: unknown;
  userId?: Identifier;
}): Promise<ControllerResult> {
  const revised = await revisePlan({
    workSessionId: input.workSessionId,
    planId: input.planId,
    rawPlanJson: input.planJson,
  });
  return approveOrRejectApproval({ approvalId: revised.approvalId, status: "approved", userId: input.userId });
}

export async function advanceController(
  workSessionId: Identifier,
  options: { trigger?: "auto" | "step" } = {}
): Promise<ControllerResult> {
  if (runningControllerRuns.has(workSessionId)) {
    logProcess("info", "controller.advance.concurrent.skipped", { workSessionId, trigger: options.trigger ?? "auto" });
    return currentControllerResult(workSessionId, "controller-already-running");
  }
  runningControllerRuns.add(workSessionId);
  let controllerFileLock: { release: () => Promise<void> } | null = null;
  let controllerOperation: WorkSessionOperationHandle | null = null;
  let followUpReason: string | null = null;
  try {
    controllerFileLock = await acquireControllerFileLock(workSessionId);
    if (controllerFileLock === null) {
      logProcess("info", "controller.advance.file_lock.skipped", { workSessionId, trigger: options.trigger ?? "auto" });
      return currentControllerResult(workSessionId, "controller-already-running");
    }
    controllerOperation = registerWorkSessionOperation({
      workSessionId,
      kind: "controller",
      label: "Controller advance",
    });
    const config = getConfig();
    const steps: string[] = [];
    let currentState = "unknown";
    let chatSessionId = "";

    const trigger = options.trigger ?? "auto";
    let stepsAuthorized = trigger === "step" ? 1 : 0;
    await clearAwaitingStep(workSessionId);

    let stepIndex = 0;
    for (; stepIndex < config.controllerMaxStepsPerTick; stepIndex += 1) {
      controllerOperation.throwIfAborted();
      await throwIfWorkSessionCanceled(workSessionId);
      const snapshot = await mutateDatabase((db) => {
        const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
        const project = findRequired(db.projects, (candidate) => candidate.id === workSession.projectId, "Project");
        const chatSession = findRequired(db.chatSessions, (candidate) => candidate.id === workSession.chatSessionId, "Chat session");
        const runtimeProfile = findRequired(db.runtimeProfiles, (candidate) => candidate.id === workSession.runtimeProfileId, "Runtime profile");
        const plan = latestPlanForSession(db, workSession.id);
        return {
          workSession: { ...workSession },
          project: { ...project },
          chatSession: { ...chatSession },
          runtimeProfile: { ...runtimeProfile },
          plan: plan === null ? null : { ...plan },
        };
      });

      currentState = snapshot.workSession.currentState;
      chatSessionId = snapshot.chatSession.id;

      if (snapshot.workSession.currentState === "planning" || snapshot.workSession.currentState === "queued" || snapshot.workSession.currentState === "executing" || snapshot.workSession.currentState === "verifying") {
        await clearPreviewIdleStopForWorkSession(workSessionId, `controller-${snapshot.workSession.currentState}`);
      }

      if (snapshot.workSession.paused) {
        steps.push("paused");
        break;
      }

      if (
        snapshot.workSession.currentState !== "blocked" &&
        snapshot.workSession.currentState !== "completed" &&
        snapshot.workSession.currentState !== "canceled" &&
        snapshot.workSession.currentState !== "failed" &&
        await blockUnsafeWorkspaceIfNeeded({
          workSession: snapshot.workSession,
          project: snapshot.project,
          chatSessionId: snapshot.chatSession.id,
        })
      ) {
        steps.push("workspace-safety-blocked");
        currentState = "blocked";
        break;
      }

      if (snapshot.workSession.currentState === "intake") {
        if (shouldClarify(snapshot.workSession.lastUserMessage)) {
          await transitionWorkSession(workSessionId, "clarifying");
          await emitEvent({
            workSessionId,
            eventName: "clarification.requested",
            aggregateType: "work_session",
            aggregateId: workSessionId,
            payload: { reason: "The request is too short or vague." },
          });
          await addAssistantMessage(
            chatSessionId,
            snapshot.workSession.deliveryKind === "research"
              ? "I need one concrete research target before starting. Please tell me what repo, area, or question the report should cover."
              : "I need one concrete development goal before planning. Please tell me the feature, bug, or refactor target and the expected acceptance criteria."
          );
          steps.push("clarification-requested");
          currentState = "clarifying";
          break;
        }
        if (snapshot.workSession.deliveryKind === "research") {
          await transitionWorkSession(workSessionId, "executing");
          await emitEvent({
            workSessionId,
            eventName: "session.started",
            aggregateType: "work_session",
            aggregateId: workSessionId,
            payload: { mode: "research", deliveryKind: "research" },
          });
          const result = await executeResearchSession(snapshot.workSession, snapshot.runtimeProfile);
          steps.push(`research-${result.status}`);
          if (result.status === "completed") {
            await mutateDatabase((db) => {
              const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
              workSession.currentState = "completed";
              updateWorkSessionTimestamp(workSession);
            });
            await emitEvent({
              workSessionId,
              eventName: "session.finished",
              aggregateType: "work_session",
              aggregateId: workSessionId,
              payload: {
                deliveryKind: "research",
                reportArtifactId: result.reportArtifactId ?? "",
                logArtifactId: result.logArtifactId ?? "",
              },
            });
            const reportReference = result.reportArtifactId !== null ? `\n\nFull report artifact: /api/artifacts/${result.reportArtifactId}` : "";
            await addAssistantMessage(chatSessionId, `${result.summary}${reportReference}`, null, {
              maxChars: null,
              messageKind: "research_report",
            });
            await mirrorWorkSessionState(workSessionId);
            await armPreviewIdleStopForWorkSession(workSessionId, "research-completed");
            currentState = "completed";
            break;
          }

          await transitionWorkSession(workSessionId, "blocked");
          await emitEvent({
            workSessionId,
            eventName: "session.blocked",
            aggregateType: "work_session",
            aggregateId: workSessionId,
            payload: {
              reason: "Read-only research failed.",
              summary: result.summary,
              logArtifactId: result.logArtifactId ?? "",
            },
            context: { agentRunId: result.agentRun.id },
          });
          await addAssistantMessage(chatSessionId, `Research failed: ${result.summary}`);
          currentState = "blocked";
          break;
        }
        await transitionWorkSession(workSessionId, "planning");
        await emitEvent({
          workSessionId,
          eventName: "session.started",
          aggregateType: "work_session",
          aggregateId: workSessionId,
          payload: { mode: snapshot.workSession.executionMode, deliveryKind: "implementation" },
        });
        steps.push("session-started");
        continue;
      }

      if (snapshot.workSession.currentState === "clarifying") {
        await transitionWorkSession(workSessionId, snapshot.workSession.deliveryKind === "research" ? "intake" : "planning");
        await emitEvent({
          workSessionId,
          eventName: "clarification.answered",
          aggregateType: "work_session",
          aggregateId: workSessionId,
          payload: { message: snapshot.workSession.lastUserMessage },
        });
        steps.push("clarification-answered");
        continue;
      }

      if (snapshot.workSession.currentState === "planning") {
        if (snapshot.workSession.deliveryKind === "research") {
          await transitionWorkSession(workSessionId, "intake");
          steps.push("research-rerouted-before-planning");
          continue;
        }
        let plan: PlanRecord;
        try {
          plan = await createPlan(snapshot.workSession);
        } catch (planError) {
          const reason = planError instanceof Error ? planError.message : "Planning failed.";
          await transitionWorkSession(workSessionId, "blocked");
          await emitEvent({
            workSessionId,
            eventName: "session.blocked",
            aggregateType: "work_session",
            aggregateId: workSessionId,
            payload: { reason, mode: "planning_failed" },
            priority: "critical",
            producer: { module: "workflow-controller" },
          });
          await addAssistantMessage(chatSessionId, `Planning failed, so I stopped instead of retrying in a loop: ${reason} You can retry, adjust the request, or switch the planner provider.`);
          currentState = "blocked";
          steps.push("planning-failed-blocked");
          break;
        }
        if (config.autoApprovePlans) {
          await approvePlanAutomatically(workSessionId, plan.id);
          await addAssistantMessage(chatSessionId, `Created and auto-approved plan: ${plan.title}`);
          steps.push("plan-created-auto-approved");
          continue;
        }
        await createPlanApproval(workSessionId, plan.id);
        await transitionWorkSession(workSessionId, "awaiting_approval");
        await addAssistantMessage(chatSessionId, `Created plan '${plan.title}'. Please approve it in the Approvals panel before execution.`);
        steps.push("plan-created-awaiting-approval");
        currentState = "awaiting_approval";
        break;
      }

      if (snapshot.workSession.currentState === "awaiting_approval") {
        const pendingApproval = await mutateDatabase((db) =>
          db.approvals.find((approval) => approval.workSessionId === workSessionId && approval.status === "pending")
            ? true
            : false
        );
        if (!pendingApproval) {
          const draftPlanId = await mutateDatabase((db) => {
            const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
            const plan = latestPlanForSession(db, workSession.id);
            if (plan?.status === "draft") {
              return plan.id;
            }
            workSession.currentState = "planning";
            workSession.activePlanId = null;
            updateWorkSessionTimestamp(workSession);
            return null;
          });
          if (draftPlanId !== null) {
            await createPlanApproval(workSessionId, draftPlanId);
            steps.push("missing-pending-approval-recreated");
            currentState = "awaiting_approval";
            break;
          }
          steps.push("missing-pending-approval-replan");
          continue;
        }
        steps.push("awaiting-approval");
        currentState = "awaiting_approval";
        break;
      }

      if (snapshot.workSession.currentState === "executing" || snapshot.workSession.currentState === "queued") {
        if (snapshot.workSession.deliveryKind === "research") {
          await transitionWorkSession(workSessionId, "intake");
          steps.push("research-rerouted-from-executing");
          continue;
        }
        const plan = snapshot.plan;
        if (plan === null || plan.status !== "approved") {
          const pendingApproval = await mutateDatabase((db) =>
            db.approvals.find((approval) => approval.workSessionId === workSessionId && approval.status === "pending")
              ? true
              : false
          );
          if (pendingApproval) {
            await transitionWorkSession(workSessionId, "awaiting_approval");
            steps.push("missing-approved-plan");
            currentState = "awaiting_approval";
            break;
          }
          await mutateDatabase((db) => {
            const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
            workSession.currentState = "planning";
            workSession.activePlanId = null;
            updateWorkSessionTimestamp(workSession);
          });
          steps.push("missing-approved-plan-replan");
          continue;
        }

        const dependencyResearch = await ensureDependencyResearchForPlan({
          workSession: snapshot.workSession,
          plan,
        });
        if (!dependencyResearch.alreadyCompleted) {
          steps.push("dependency-research-completed");
          continue;
        }

        const nextTask = await mutateDatabase((db) => {
          return getNextRunnableTask(db, plan.id);
        });

        if (nextTask === null) {
          const steeringTask = await createFollowUpTaskForPendingSteering({ workSessionId, plan });
          if (steeringTask !== null) {
            steps.push("steering-follow-up-task-created");
            continue;
          }
          await transitionWorkSession(workSessionId, "verifying");
          steps.push("all-tasks-complete-start-verification");
          continue;
        }

        if (nextTask.metadata.taskKind === "verify") {
          await mutateDatabase((db) => {
            const mutableTask = findRequired(db.tasks, (candidate) => candidate.id === nextTask.id, "Task");
            mutableTask.status = "done";
          });
          await emitEvent({
            workSessionId,
            eventName: "task.completed",
            aggregateType: "task",
            aggregateId: nextTask.id,
            payload: {
              summary: "Skipped agent-executed verification task. Formal verification will run in the orchestrator.",
            },
            context: { taskId: nextTask.id },
          });
          await transitionWorkSession(workSessionId, "verifying");
          steps.push("agent-verify-task-delegated-to-orchestrator");
          continue;
        }

        if (nextTask.attemptCount >= maxAttemptsPerTask) {
          await mutateDatabase((db) => {
            const mutableTask = findRequired(db.tasks, (candidate) => candidate.id === nextTask.id, "Task");
            mutableTask.status = "blocked";
            mutableTask.lastFailureSummary = `Task reached the maximum attempt ceiling of ${maxAttemptsPerTask}.`;
          });
          await transitionWorkSession(workSessionId, "blocked");
          await createHandoff(workSessionId, `Task '${nextTask.title}' reached the maximum attempt ceiling.`);
          await emitEvent({
            workSessionId,
            eventName: "session.blocked",
            aggregateType: "work_session",
            aggregateId: workSessionId,
            payload: { reason: `Task '${nextTask.title}' reached the maximum attempt ceiling.` },
            context: { taskId: nextTask.id },
          });
          await addAssistantMessage(chatSessionId, `Task '${nextTask.title}' reached the maximum attempt ceiling. I created a handoff with the current state.`);
          currentState = "blocked";
          break;
        }

        const isRepairTask = typeof nextTask.metadata.repairForVerificationRunId === "string";
        const dependencyInstall = isRepairTask
          ? {
              handled: false as const,
              status: "completed" as const,
              packages: [],
              command: "",
              summary: "Repair tasks are executed by Codex, not the dependency installer.",
              rawOutput: "",
              manifestOnly: false,
            }
          : await installDependenciesForTask({
              workSession: snapshot.workSession,
              task: nextTask,
            });
        let dependencyInstallPreflightSummary: string | null = null;
        if (dependencyInstall.handled) {
          const closesTask = dependencyInstall.manifestOnly
            || getConfig().dependencyTaskAutoclose === "legacy";
          if (closesTask) {
            await mutateDatabase((db) => {
              const mutableTask = findRequired(db.tasks, (candidate) => candidate.id === nextTask.id, "Task");
              mutableTask.status = dependencyInstall.status === "completed" ? "done" : "blocked";
            });
            await emitEvent({
              workSessionId,
              eventName: dependencyInstall.status === "completed" ? "task.completed" : "task.failed",
              aggregateType: "task",
              aggregateId: nextTask.id,
              payload: {
                summary: dependencyInstall.summary,
                packages: dependencyInstall.packages.join(","),
                command: dependencyInstall.command,
                mode: "completed_task",
              },
              producer: { module: "dependency-installer", runtimeKind: "codex", role: "executor" },
              context: { taskId: nextTask.id },
            });
            steps.push(`dependency-install-${dependencyInstall.status}`);

            if (dependencyInstall.status === "failed") {
              await setAwaitingStep(workSessionId, "Dependency installation failed. Continue?");
              await addAssistantMessage(chatSessionId, chatSummary(`${dependencyInstall.summary}\n\nThe session is waiting for your decision. Use the task controls to re-run, skip, or continue after adjusting the environment.`));
              currentState = "blocked";
              break;
            }

            continue;
          }

          dependencyInstallPreflightSummary = dependencyInstall.summary;
          await emitEvent({
            workSessionId,
            eventName: "task.progress",
            aggregateType: "task",
            aggregateId: nextTask.id,
            payload: {
              message: dependencyInstall.status === "failed"
                ? "Pre-flight dependency install reported a failure; proceeding to the executor, which owns dependency declarations (the manifest sync and verification gate are the authoritative installs)."
                : "Dependencies were installed as a pre-flight step; the task still has non-manifest deliverables and will run with an executor.",
              summary: dependencyInstall.summary,
              packages: dependencyInstall.packages.join(","),
              command: dependencyInstall.command,
              mode: "preflight_for_executor",
            },
            producer: { module: "dependency-installer", runtimeKind: "codex", role: "executor" },
            context: { taskId: nextTask.id },
          });
          steps.push(dependencyInstall.status === "failed" ? "dependency-install-preflight-advisory-failure" : "dependency-install-preflight");
        }

        if (actionIsGated(snapshot.workSession.autonomyLevel, "execute_task", nextTask)) {
          if (stepsAuthorized > 0) {
            stepsAuthorized -= 1;
          } else {
            await setAwaitingStep(workSessionId, `Run task #${nextTask.ordinal}: ${nextTask.title}`);
            steps.push("awaiting-step-task");
            currentState = "executing";
            break;
          }
        }

        const manifestSync = await syncWorkspaceManifestDependencies({
          workSession: snapshot.workSession,
          taskId: nextTask.id,
        });
        if (manifestSync.attempted) {
          await emitEvent({
            workSessionId,
            eventName: "task.progress",
            aggregateType: "task",
            aggregateId: nextTask.id,
            payload: {
              message: manifestSync.summary,
              command: manifestSync.command,
              status: manifestSync.status,
              mode: "manifest_sync",
            },
            producer: { module: "dependency-installer", runtimeKind: "codex", role: "executor" },
            context: { taskId: nextTask.id },
          });
          steps.push(`manifest-sync-${manifestSync.status}`);
        }

        const steeringApplication = await applyPendingSteeringToTask({
          workSessionId,
          taskId: nextTask.id,
          applyMode: nextTask.status === "in_progress" ? "restart_current_task" : "next_boundary",
        });
        const taskForExecution = dependencyInstallPreflightSummary === null
          ? steeringApplication.task
          : {
              ...steeringApplication.task,
              metadata: {
                ...steeringApplication.task.metadata,
                dependencyInstallSummary: dependencyInstallPreflightSummary,
              },
            };
        if (steeringApplication.applied.length > 0) {
          steps.push("steering-applied-to-task");
        }

        const bootstrap = await bootstrapWorkspaceIfNeeded(snapshot.workSession);
        if (bootstrap !== null) {
          steps.push(`workspace-bootstrap-${bootstrap.kind}`);
          await emitEvent({
            workSessionId,
            eventName: "task.progress",
            aggregateType: "work_session",
            aggregateId: workSessionId,
            payload: {
              message: `Prepared a stable ${bootstrap.kind} workspace scaffold before agent execution.`,
              filesCreated: bootstrap.filesCreated,
            },
          });
        }
        await wakeIdleStoppedPreviewForDevelopment(snapshot.workSession);
        await startProbePreviewIfEnabled(snapshot.workSession);

        await emitEvent({
          workSessionId,
          eventName: "task.started",
          aggregateType: "task",
          aggregateId: taskForExecution.id,
          payload: { title: taskForExecution.title, ordinal: taskForExecution.ordinal },
        });
        let result = await executeTask(snapshot.workSession, snapshot.runtimeProfile, taskForExecution);
        await throwIfWorkSessionCanceled(workSessionId);
        steps.push(`task-${taskForExecution.ordinal}-${result.status}`);

        if (result.status === "completed") {
          const regression = await detectPostTaskRenderRegression(snapshot.workSession, taskForExecution, result);
          await throwIfWorkSessionCanceled(workSessionId);
          if (regression !== null) {
            result = regression;
            steps.push("post-task-render-regression");
            await emitEvent({
              workSessionId,
              eventName: "task.render_regression",
              aggregateType: "task",
              aggregateId: taskForExecution.id,
              payload: {
                title: taskForExecution.title,
                message: "The home page stopped rendering after this task completed; routing the regression into the execution repair loop.",
              },
              context: { taskId: taskForExecution.id, agentRunId: result.agentRun.id },
            });
          }
        }

        if (result.status === "approval_required") {
          await transitionWorkSession(workSessionId, "blocked");
          currentState = "blocked";
          break;
        }

        if (result.status === "failed") {
          if (result.failureKind === "interrupted_by_user_steering") {
            await mutateDatabase((db) => {
              const mutableTask = findRequired(db.tasks, (candidate) => candidate.id === taskForExecution.id, "Task");
              mutableTask.status = "todo";
              mutableTask.lastFailureSummary = null;
              mutableTask.lastFailureFingerprint = null;
              mutableTask.metadata.steeringInterruptAgentRunId = result.agentRun.id;
            });
            await addAssistantMessage(chatSessionId, `Interrupted '${taskForExecution.title}' to apply queued steering. Restarting that task with the new guidance.`);
            currentState = "executing";
            steps.push("steering-interrupt-requeued-task");
            continue;
          }
          if (result.failureKind === "timeout" && result.codeChangeCount > 0) {
            await setAwaitingStep(workSessionId, `Task timed out after partial progress. Continue?`);
            await emitEvent({
              workSessionId,
              eventName: "task.timeout.needs_decision",
              aggregateType: "task",
              aggregateId: taskForExecution.id,
              payload: {
                title: taskForExecution.title,
                summary: result.summary,
                agentRunId: result.agentRun.id,
                logArtifactId: result.logArtifactId ?? "",
                codeChangeCount: String(result.codeChangeCount),
                rawOutputBytes: String(result.rawOutputBytes ?? 0),
              },
              context: { taskId: taskForExecution.id, agentRunId: result.agentRun.id },
            });
            await addAssistantMessage(chatSessionId, `Task '${taskForExecution.title}' timed out after partial progress. ${result.codeChangeCount} changed file(s) were captured. Continue?`);
            currentState = "executing";
            steps.push("timeout-awaiting-continue");
            break;
          }
          if (result.failureKind === "provider_exhausted") {
            await mutateDatabase((db) => {
              const mutableTask = findRequired(db.tasks, (candidate) => candidate.id === taskForExecution.id, "Task");
              mutableTask.status = "todo";
              mutableTask.lastFailureSummary = null;
              mutableTask.lastFailureFingerprint = null;
              if (mutableTask.attemptCount > 0) {
                mutableTask.attemptCount -= 1;
              }
            });
            const retryHint = providerExhaustionRetryHint(result.summary);
            await setAwaitingStep(
              workSessionId,
              retryHint !== null
                ? `Coding provider quota reached — ${retryHint}, then resume to retry this task`
                : "Coding provider quota reached — resume to retry this task",
            );
            await emitEvent({
              workSessionId,
              eventName: "session.provider_quota_paused",
              aggregateType: "work_session",
              aggregateId: workSessionId,
              payload: {
                taskTitle: taskForExecution.title,
                summary: result.summary,
                retryHint: retryHint ?? "",
                failureKind: "provider_exhausted",
                logArtifactId: result.logArtifactId ?? "",
              },
              context: { taskId: taskForExecution.id, agentRunId: result.agentRun.id },
            });
            await addAssistantMessage(
              chatSessionId,
              `Paused before '${taskForExecution.title}': the coding provider's usage limit was reached, so no changes were made and no work was lost.${
                retryHint !== null ? ` You can ${retryHint}.` : ""
              } Resume to retry this task from where the plan left off.`,
            );
            currentState = "executing";
            steps.push("provider-quota-paused");
            break;
          }

          const repairability = executionFailureRepairability(result);
          if (!repairability.repairable) {
            await transitionWorkSession(workSessionId, "blocked");
            await emitEvent({
              workSessionId,
              eventName: "session.blocked",
              aggregateType: "work_session",
              aggregateId: workSessionId,
              payload: {
                reason: repairability.reason,
                summary: result.summary,
                failureKind: result.failureKind ?? "runtime_failure",
                logArtifactId: result.logArtifactId ?? "",
                codeChangeCount: String(result.codeChangeCount),
                rawOutputBytes: String(result.rawOutputBytes ?? 0),
              },
              priority: "critical",
              context: { taskId: taskForExecution.id, agentRunId: result.agentRun.id },
            });
            await addAssistantMessage(chatSessionId, `Task '${taskForExecution.title}' failed and was not converted into a code repair task: ${repairability.reason} ${result.summary}`);
            currentState = "blocked";
            steps.push("execution-failure-blocked-without-repair");
            break;
          }

          const repairStatus = await mutateDatabase((db) => {
            const tasks = tasksForPlan(db, plan.id);
            const rootFailedTask = executionRepairRootTask(tasks, taskForExecution);
            const repairTasks = tasks.filter((task) => isExecutionRepairForRoot(tasks, task, rootFailedTask.id));
            return { repairBudgetRemaining: repairTasks.length < maxRepairAttemptsPerSession, repairCount: repairTasks.length };
          });
          if (repairStatus.repairBudgetRemaining) {
            const repairTask = await createExecutionRepairTask({ workSessionId, plan, failedTask: taskForExecution, result });
            await emitEvent({
              workSessionId,
              eventName: "task.queued",
              aggregateType: "task",
              aggregateId: repairTask.id,
              payload: {
                title: repairTask.title,
                reason: "Task execution failed; queued repair task.",
                failureKind: result.failureKind ?? "runtime_failure",
                repairAttempt: String(repairStatus.repairCount + 1),
                logArtifactId: result.logArtifactId ?? "",
              },
              context: { planId: plan.id, taskId: repairTask.id, agentRunId: result.agentRun.id },
            });
            await addAssistantMessage(chatSessionId, `Task '${taskForExecution.title}' failed, so I queued repair task '${repairTask.title}' and will continue the loop.`);
            currentState = "executing";
            steps.push("execution-repair-task-created");
            continue;
          }

          await transitionWorkSession(workSessionId, "blocked");
          await addAssistantMessage(chatSessionId, `Task '${taskForExecution.title}' failed: ${result.summary}`);
          currentState = "blocked";
          break;
        }

        continue;
      }

      if (snapshot.workSession.currentState === "verifying") {
        if (snapshot.workSession.deliveryKind === "research") {
          await transitionWorkSession(workSessionId, "intake");
          steps.push("research-rerouted-from-verifying");
          continue;
        }
        if (actionIsGated(snapshot.workSession.autonomyLevel, "run_verification", null)) {
          if (stepsAuthorized > 0) {
            stepsAuthorized -= 1;
          } else {
            await setAwaitingStep(workSessionId, "Run verification");
            steps.push("awaiting-step-verification");
            currentState = "verifying";
            break;
          }
        }

        await throwIfWorkSessionCanceled(workSessionId);
        let verification = await runVerificationForSession(snapshot.workSession, snapshot.plan, controllerOperation.signal);
        await throwIfWorkSessionCanceled(workSessionId);
        steps.push(`verification-${verification.status}`);
        if (snapshot.plan === null) {
          await transitionWorkSession(workSessionId, "blocked");
          await createHandoff(workSessionId, "Verification finished without an active plan.");
          currentState = "blocked";
          break;
        }

        const renderGate = await runRenderVerificationGate({
          workSession: snapshot.workSession,
          plan: snapshot.plan,
          verification,
          signal: controllerOperation.signal,
        });
        await throwIfWorkSessionCanceled(workSessionId);
        verification = renderGate.verification;
        if (verification.status === "failed" && renderGate.preview !== null) {
          steps.push(`render-verification-${renderGate.preview.status}`);
        } else if (renderGate.preview !== null) {
          steps.push("render-verification-passed");
        }

        const acceptanceEvidenceSatisfied = verification.status === "passed"
          ? await finalizeAcceptanceEvidence(workSessionId, snapshot.plan.id, verification.id)
          : false;
        const fingerprint = failureFingerprint(verification);
        const repairStatus = await mutateDatabase((db) => {
          const tasks = tasksForPlan(db, snapshot.plan!.id);
          const repairTasks = tasks.filter((task) => typeof task.metadata.repairForVerificationRunId === "string");
          const sameFingerprintCount = repairTasks.filter((task) => task.lastFailureFingerprint === fingerprint || task.metadata.failureFingerprint === fingerprint).length;
          return {
            repairBudgetRemaining: repairTasks.length < maxVerificationRepairsPerSession,
            repeatedFailure: sameFingerprintCount >= maxRepairAttemptsPerSession - 1,
            repairCount: repairTasks.length,
          };
        });
        const transition = decideVerificationTransition({
          currentState: "verifying",
          verificationStatus: verification.status === "passed" ? "passed" : "failed",
          failureKind: verification.failureKind,
          repairBudgetRemaining: repairStatus.repairBudgetRemaining,
          repeatedFailure: repairStatus.repeatedFailure,
          acceptanceEvidenceSatisfied,
        });

        if (transition.sideEffectIntent === "create_repair_task") {
          await throwIfWorkSessionCanceled(workSessionId);
          const repairTask = await createVerificationRepairTask({
            workSessionId,
            plan: snapshot.plan,
            verification,
            fingerprint,
          });
          await emitEvent({
            workSessionId,
            eventName: "task.queued",
            aggregateType: "task",
            aggregateId: repairTask.id,
            payload: {
              title: repairTask.title,
              reason: transition.reason,
              verificationRunId: verification.id,
              failureKind: verification.failureKind,
              repairAttempt: String(repairStatus.repairCount + 1),
            },
            context: { planId: snapshot.plan.id, taskId: repairTask.id, verificationRunId: verification.id },
          });
          await addAssistantMessage(chatSessionId, `Verification failed, so I queued repair task '${repairTask.title}' and will rerun verification after the fix.`);
          await mirrorWorkSessionState(workSessionId);
          steps.push("verification-repair-task-created");
          currentState = "executing";
          if (snapshot.workSession.autonomyLevel === "supervised") {
            await setAwaitingStep(workSessionId, `Verification failed - step to run repair '${repairTask.title}'`);
            steps.push("awaiting-step-repair");
            break;
          }
          continue;
        }

        if (transition.sideEffectIntent === "create_blocking_handoff") {
          await throwIfWorkSessionCanceled(workSessionId);
          await transitionWorkSession(workSessionId, "blocked");
          await createHandoff(workSessionId, `${transition.reason} Summary: ${verification.summary}`);
          await emitEvent({
            workSessionId,
            eventName: "session.blocked",
            aggregateType: "work_session",
            aggregateId: workSessionId,
            payload: { reason: transition.reason, verificationRunId: verification.id, failureKind: verification.failureKind },
            context: { planId: snapshot.plan.id, verificationRunId: verification.id },
          });
          await addAssistantMessage(chatSessionId, `Verification could not be repaired automatically. ${transition.reason} I created a handoff. Summary: ${verification.summary}`);
          currentState = "blocked";
          break;
        }

        await throwIfWorkSessionCanceled(workSessionId);
        const completed = await mutateWorkSessionIfNotCanceled(workSessionId, (db, workSession) => {
          const plan = findRequired(db.plans, (candidate) => candidate.id === snapshot.plan?.id, "Plan");
          plan.status = "completed";
          workSession.currentState = "completed";
          closeActiveAgentRuns(db, {
            workSessionId,
            taskId: undefined,
            exceptAgentRunId: null,
            summary: "Closed because the session completed.",
          });
          updateWorkSessionTimestamp(workSession);
        });
        if (completed === null) {
          await throwIfWorkSessionCanceled(workSessionId);
        }
        await createHandoff(workSessionId, "Session completed and verification passed.");
        await emitEvent({
          workSessionId,
          eventName: "session.finished",
          aggregateType: "work_session",
          aggregateId: workSessionId,
          payload: {
            verificationRunId: verification.id,
            previewUrl: renderGate.preview?.url ?? "",
            previewStatus: renderGate.preview?.status ?? "skipped",
            snapshotEvidenceStatus: renderGate.snapshotEvidence?.status ?? "skipped",
            runtimeStructuralStatus: renderGate.runtimeStructural?.status ?? "skipped",
          },
        });
        await addAssistantMessage(chatSessionId, `The closed dev loop completed. Tasks are done, verification passed, and the preview is running at ${renderGate.preview?.url ?? "not applicable"}`);
        await armPreviewIdleStopForWorkSession(workSessionId, "session-completed");
        currentState = "completed";
        break;
      }

      if (snapshot.workSession.currentState === "blocked") {
        const recovery = await recoverImplicitAppServerInterruptedFailure({ workSessionId });
        if (recovery.recovered) {
          if (recovery.repairTask !== null) {
            await emitEvent({
              workSessionId,
              eventName: "task.queued",
              aggregateType: "task",
              aggregateId: recovery.repairTask.id,
              payload: {
                title: recovery.repairTask.title,
                reason: "Recovered a Codex app-server interrupted turn that had been misclassified as a user abort.",
                failureKind: "runtime_failure",
                repairAttempt: String(recovery.repairTask.metadata.repairAttempt ?? ""),
                logArtifactId: recovery.logArtifactId,
                codeChangeCount: String(recovery.codeChangeCount),
              },
              context: { planId: snapshot.plan?.id ?? "", taskId: recovery.repairTask.id },
            });
            await addAssistantMessage(
              chatSessionId,
              `Recovered '${recovery.failedTaskTitle}' as a repairable Codex app-server interruption with ${recovery.codeChangeCount} captured file change(s), so I queued repair task '${recovery.repairTask.title}' and will continue the loop.`
            );
          }
          steps.push("legacy-appserver-interruption-recovered");
          currentState = "executing";
          continue;
        }
      }

      if (["blocked", "handoff_needed", "completed", "failed", "canceled"].includes(snapshot.workSession.currentState)) {
        steps.push(`terminal-or-paused-${snapshot.workSession.currentState}`);
        currentState = snapshot.workSession.currentState;
        break;
      }

      steps.push(`unhandled-${snapshot.workSession.currentState}`);
      break;
    }

    if (stepIndex >= config.controllerMaxStepsPerTick) {
      const latest = await getDatabaseSnapshot();
      const workSession = latest.workSessions.find((candidate) => candidate.id === workSessionId);
      const activeStates = new Set(["queued", "planning", "executing", "verifying"]);
      if (
        workSession !== undefined &&
        activeStates.has(workSession.currentState) &&
        !workSession.paused &&
        !workSession.awaitingStep
      ) {
        followUpReason = "step-budget-exhausted";
        steps.push("continuation-scheduled");
      }
    }

    return { workSessionId, chatSessionId, state: currentState, steps };
  } catch (error) {
    if (!isWorkSessionOperationAbortedError(error)) {
      throw error;
    }
    const pausedAbort = error instanceof Error && /pause/i.test(error.message);
    const canceledAbort = !pausedAbort;
    const aborted = await mutateDatabase((db) => {
      const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
      const chatSession = findRequired(db.chatSessions, (candidate) => candidate.id === workSession.chatSessionId, "Chat session");
      for (const verificationRun of db.verificationRuns) {
        if (verificationRun.workSessionId === workSessionId && verificationRun.status === "running") {
          verificationRun.status = "failed";
          verificationRun.failureKind = "environment_failure";
          verificationRun.summary = pausedAbort ? "Verification was paused by the user." : "Verification was canceled by the user.";
          verificationRun.rawOutput = [verificationRun.rawOutput, pausedAbort ? "Verification was paused by the user." : "Verification was canceled by the user."].filter((entry) => entry.trim().length > 0).join("\n---\n");
          markEnded(verificationRun);
        }
      }
      if (pausedAbort) {
        workSession.paused = true;
      } else if (canceledAbort) {
        workSession.currentState = "canceled";
        workSession.paused = false;
      }
      workSession.awaitingStep = false;
      workSession.nextActionLabel = null;
      updateWorkSessionTimestamp(workSession);
      return { chatSessionId: chatSession.id, state: workSession.currentState };
    });
    await emitEvent({
      workSessionId,
      eventName: pausedAbort ? "task.progress" : "session.canceled",
      aggregateType: "work_session",
      aggregateId: workSessionId,
      priority: "high",
      payload: {
        reason: pausedAbort ? "Operation paused by user." : "Operation canceled by user.",
        summary: pausedAbort ? "Validation or controller work was stopped by Pause." : "Validation or controller work was canceled by Abort.",
        message: pausedAbort ? "Controller operation paused." : "Controller operation canceled.",
      },
    });
    await addAssistantMessage(
      aborted.chatSessionId,
      pausedAbort
        ? "Validation was paused. Resume the session to run validation again."
        : "Validation was aborted and the session was canceled. Start or resume work explicitly to continue from here."
    );
    await mirrorWorkSessionState(workSessionId);
    return { workSessionId, chatSessionId: aborted.chatSessionId, state: aborted.state, steps: [pausedAbort ? "operation-paused" : "operation-aborted"] };
  } finally {
    controllerOperation?.unregister();
    await controllerFileLock?.release();
    runningControllerRuns.delete(workSessionId);
    const rerunRequested = pendingControllerReruns.delete(workSessionId);
    if (followUpReason !== null || rerunRequested) {
      scheduleControllerAdvance(workSessionId, followUpReason ?? "deferred-request");
    }
  }
}

export async function forceHandoff(workSessionId: Identifier): Promise<ControllerResult> {
  const chatSessionId = await mutateDatabase((db) => {
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
    workSession.currentState = "handoff_needed";
    updateWorkSessionTimestamp(workSession);
    return workSession.chatSessionId;
  });
  await createHandoff(workSessionId, "Manual handoff requested.");
  await addAssistantMessage(chatSessionId, "Manual handoff created.");
  return { workSessionId, chatSessionId, state: "handoff_needed", steps: ["manual-handoff"] };
}

export interface TaskEdit {
  title: string;
  description: string;
  objective: string;
  taskKind: PlanTaskKind;
  targetFiles: string[];
  expectedChanges: string[];
  acceptanceCriteria: string[];
  verificationHints: string[];
  riskLevel: RiskLevel;
}

function resetEvidence(criteria: string[], note: string): TaskRecord["acceptanceEvidence"] {
  return criteria.map((criterion) => ({
    criterion,
    status: "unknown" as const,
    source: "manual_note" as const,
    note,
    updatedAt: currentTimestamp(),
  }));
}

function findSessionTask(db: AppDatabase, workSessionId: Identifier, taskId: Identifier): { workSession: WorkSessionRecord; chatSession: ChatSessionRecord; plan: PlanRecord; task: TaskRecord } {
  const workSession = findRequired(db.workSessions, (candidate) => candidate.id === workSessionId, "Work session");
  const chatSession = findRequired(db.chatSessions, (candidate) => candidate.id === workSession.chatSessionId, "Chat session");
  const task = findRequired(db.tasks, (candidate) => candidate.id === taskId, "Task");
  const plan = findRequired(db.plans, (candidate) => candidate.id === task.planId, "Plan");
  if (plan.workSessionId !== workSession.id) {
    throw new Error("Task does not belong to this work session.");
  }
  return { workSession, chatSession, plan, task };
}

export async function rerunTask(input: { workSessionId: Identifier; taskId: Identifier; note?: string | null }): Promise<ControllerResult> {
  const seed = await mutateDatabase((db) => {
    const { workSession, chatSession, plan, task } = findSessionTask(db, input.workSessionId, input.taskId);
    task.status = "todo";
    task.attemptCount = 0;
    task.lastFailureSummary = null;
    task.lastFailureFingerprint = null;
    task.acceptanceEvidence = resetEvidence(task.acceptanceCriteria, "Reset for a user-requested re-run.");
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (note.length > 0) {
      task.metadata.steeringNote = note.slice(0, 2000);
    } else {
      delete task.metadata.steeringNote;
    }
    if (plan.status === "completed") {
      plan.status = "approved";
    }
    workSession.currentState = "executing";
    workSession.awaitingStep = false;
    workSession.nextActionLabel = null;
    updateWorkSessionTimestamp(workSession);
    return { workSessionId: workSession.id, chatSessionId: chatSession.id, taskId: task.id, title: task.title, state: workSession.currentState };
  });

  await emitEvent({
    workSessionId: seed.workSessionId,
    eventName: "task.queued",
    aggregateType: "task",
    aggregateId: seed.taskId,
    payload: { title: seed.title, reason: "User requested re-run." },
    context: { taskId: seed.taskId },
  });
  await mirrorWorkSessionState(seed.workSessionId);
  return { workSessionId: seed.workSessionId, chatSessionId: seed.chatSessionId, state: seed.state, steps: ["task-rerun"] };
}

export async function repairPreviewFailure(input: { workSessionId: Identifier; previewId: Identifier }): Promise<ControllerResult> {
  const seed = await mutateDatabase((db) => {
    const workSession = findRequired(db.workSessions, (candidate) => candidate.id === input.workSessionId, "Work session");
    const chatSession = findRequired(db.chatSessions, (candidate) => candidate.id === workSession.chatSessionId, "Chat session");
    const plan = latestPlanForSession(db, workSession.id);
    if (plan === null || (plan.status !== "approved" && plan.status !== "completed")) {
      throw new Error("Preview repair requires an approved or completed plan.");
    }
    const preview = findRequired(db.previewServers, (candidate) => candidate.id === input.previewId, "Preview");
    if (preview.workSessionId !== workSession.id) {
      throw new Error("Preview does not belong to this work session.");
    }
    if (preview.status !== "failed") {
      throw new Error("Only failed previews can be repaired.");
    }
    const repairability = classifyPreviewRepairability(preview);
    if (!repairability.repairable) {
      throw new Error(repairability.reason);
    }
    const fingerprint = createHash("sha256")
      .update(compactFailureText(`${repairability.failureKind}\n${repairability.reason}\n${previewFailureEvidence(preview)}`))
      .digest("hex")
      .slice(0, 16);
    return {
      workSessionId: workSession.id,
      chatSessionId: chatSession.id,
      plan: { ...plan },
      preview: { ...preview },
      failureKind: repairability.failureKind,
      reason: repairability.reason,
      fingerprint,
    };
  });

  const repairTask = await createPreviewRepairTask({
    workSessionId: seed.workSessionId,
    plan: seed.plan,
    preview: seed.preview,
    failureKind: seed.failureKind,
    reason: seed.reason,
    fingerprint: seed.fingerprint,
  });
  await emitEvent({
    workSessionId: seed.workSessionId,
    eventName: "task.queued",
    aggregateType: "task",
    aggregateId: repairTask.id,
    payload: {
      title: repairTask.title,
      reason: "User requested repair for failed preview.",
      previewId: seed.preview.id,
      failureKind: seed.failureKind,
    },
    context: { planId: seed.plan.id, taskId: repairTask.id, previewId: seed.preview.id },
  });
  await addAssistantMessage(seed.chatSessionId, `Queued repair task '${repairTask.title}' from the failed preview evidence. I will rerun verification after the fix.`);
  await mirrorWorkSessionState(seed.workSessionId);
  scheduleControllerAdvance(seed.workSessionId, "preview-repair");
  return { workSessionId: seed.workSessionId, chatSessionId: seed.chatSessionId, state: "executing", steps: ["preview-repair-task-created"] };
}

export async function continueTimedOutTask(input: { workSessionId: Identifier; taskId: Identifier }): Promise<ControllerResult> {
  const seed = await mutateDatabase((db) => {
    const { workSession, chatSession, plan, task } = findSessionTask(db, input.workSessionId, input.taskId);
    if (task.metadata.timeoutContinuationStatus !== "pending") {
      throw new Error("This task is not waiting on a timeout continuation decision.");
    }
    const priorSummary = typeof task.metadata.timeoutContinuationSummary === "string" ? task.metadata.timeoutContinuationSummary : "";
    const logArtifactId = typeof task.metadata.timeoutContinuationLogArtifactId === "string" ? task.metadata.timeoutContinuationLogArtifactId : "";
    task.status = "todo";
    task.lastFailureSummary = null;
    task.lastFailureFingerprint = null;
    task.metadata.timeoutContinuationStatus = "queued";
    task.metadata.steeringNote = chatSummary(`Continue from the previous timed-out partial progress without restarting from scratch. Preserve useful file changes already made. Prior bounded summary: ${priorSummary}${logArtifactId.length > 0 ? ` Full runtime log artifact: ${logArtifactId}.` : ""}`);
    task.acceptanceEvidence = resetEvidence(task.acceptanceCriteria, "Queued continuation after timed-out partial progress.");
    if (plan.status === "completed") {
      plan.status = "approved";
    }
    workSession.currentState = "executing";
    workSession.paused = false;
    workSession.awaitingStep = false;
    workSession.nextActionLabel = null;
    updateWorkSessionTimestamp(workSession);
    return { workSessionId: workSession.id, chatSessionId: chatSession.id, taskId: task.id, title: task.title, state: workSession.currentState, logArtifactId };
  });

  await emitEvent({
    workSessionId: seed.workSessionId,
    eventName: "task.queued",
    aggregateType: "task",
    aggregateId: seed.taskId,
    payload: { title: seed.title, reason: "User chose to continue after timeout.", logArtifactId: seed.logArtifactId },
    context: { taskId: seed.taskId },
  });
  await addAssistantMessage(seed.chatSessionId, `Continuing task '${seed.title}' from the timed-out partial progress.`);
  await mirrorWorkSessionState(seed.workSessionId);
  scheduleControllerAdvance(seed.workSessionId, "timeout-continue");
  return { workSessionId: seed.workSessionId, chatSessionId: seed.chatSessionId, state: seed.state, steps: ["task-timeout-continue-background"] };
}

export async function skipTask(input: { workSessionId: Identifier; taskId: Identifier }): Promise<ControllerResult> {
  const seed = await mutateDatabase((db) => {
    const { workSession, chatSession, task } = findSessionTask(db, input.workSessionId, input.taskId);
    task.status = "skipped";
    if (workSession.currentState === "blocked") {
      workSession.currentState = "executing";
      workSession.awaitingStep = false;
      workSession.nextActionLabel = null;
    }
    updateWorkSessionTimestamp(workSession);
    return { workSessionId: workSession.id, chatSessionId: chatSession.id, taskId: task.id, title: task.title, state: workSession.currentState };
  });

  await emitEvent({
    workSessionId: seed.workSessionId,
    eventName: "task.progress",
    aggregateType: "task",
    aggregateId: seed.taskId,
    payload: { message: `Skipped task '${seed.title}' at your request.` },
    context: { taskId: seed.taskId },
  });
  await mirrorWorkSessionState(seed.workSessionId);
  return { workSessionId: seed.workSessionId, chatSessionId: seed.chatSessionId, state: seed.state, steps: ["task-skip"] };
}

export async function editTask(input: { workSessionId: Identifier; taskId: Identifier; edit: TaskEdit }): Promise<ControllerResult> {
  const seed = await mutateDatabase((db) => {
    const { workSession, chatSession, plan, task } = findSessionTask(db, input.workSessionId, input.taskId);
    if (task.status !== "todo") {
      throw new Error("Only not-started tasks can be edited.");
    }
    assertPlanTargetsStayInsideWorkspace(workSession, {
      schemaVersion: 2,
      title: plan.title,
      goal: plan.goal,
      risks: [],
      verificationCommands: [],
      workspace: plan.planJson.workspace,
      tasks: [{ ...input.edit, description: input.edit.description }],
    });
    task.title = input.edit.title;
    task.description = input.edit.description;
    task.acceptanceCriteria = input.edit.acceptanceCriteria;
    task.acceptanceEvidence = resetEvidence(input.edit.acceptanceCriteria, "Reset after a task edit.");
    task.metadata.objective = input.edit.objective;
    task.metadata.taskKind = input.edit.taskKind;
    task.metadata.targetFiles = input.edit.targetFiles;
    task.metadata.expectedChanges = input.edit.expectedChanges;
    task.metadata.verificationHints = input.edit.verificationHints;
    task.metadata.riskLevel = input.edit.riskLevel;
    updateWorkSessionTimestamp(workSession);
    return { workSessionId: workSession.id, chatSessionId: chatSession.id, planId: plan.id, taskId: task.id, state: workSession.currentState };
  });

  await emitEvent({
    workSessionId: seed.workSessionId,
    eventName: "plan.updated",
    aggregateType: "plan",
    aggregateId: seed.planId,
    payload: { editedTaskId: seed.taskId, editedByUser: true },
    context: { planId: seed.planId, taskId: seed.taskId },
  });
  await mirrorWorkSessionState(seed.workSessionId);
  return { workSessionId: seed.workSessionId, chatSessionId: seed.chatSessionId, state: seed.state, steps: ["task-edit"] };
}
