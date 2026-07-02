import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { getConfig, type AppConfig } from "@/lib/server/config";
import { saveArtifact } from "@/lib/server/artifacts";
import { registerProcess, unregisterProcess } from "@/lib/server/runtime/process-registry";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolveCodexCliBin } from "@/lib/server/runtime/codex-cli-resolver";
import { ensureWorkspaceAgentsMd } from "@/lib/server/runtime/agents-md";
import { runCodexDoctor } from "@/lib/server/runtime/codex-doctor";
import { validateCodexModelReasoning } from "@/lib/server/runtime/codex-model-catalog";
import { compareWorkspaceSnapshots, snapshotWorkspace } from "@/lib/server/runtime/workspace-diff";
import { buildCodexTaskPrompt, requestsNativeCodexSubagents } from "@/lib/server/runtime/codex-task-prompt";
import { codexAppServerInputItems } from "@/lib/server/chat-attachments";
import { recordRuntimeUsage } from "@/lib/server/runtime/runtime-usage";
import { createApprovalRecord, currentTimestamp, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { isWindowsBatchCommand, windowsBatchSpawnTarget, type SpawnTarget } from "@/lib/server/runtime/windows-command";
import { emitEvent } from "@/lib/server/events";
import { logProcess } from "@/lib/server/logging";
import { boundedText, tailExcerpt } from "@/lib/server/text-bounds";
import { standardServiceTier } from "@/lib/shared/runtime-overrides";
import { asRecord, codexErrorMessage, decodeCodexAppServerLine } from "@/lib/server/runtime/codex-app-server-protocol";
import { collabCallSummary, markCodexCollabCallStale, parseCodexCollabToolCall, subagentRecordsFromCollabCall } from "@/lib/server/runtime/codex-collab";
import { codexRuntimeWorkspaceRoots } from "@/lib/server/runtime/codex-native-thread";
import { resolveCodexTransport, type CodexTransportDecision } from "@/lib/server/runtime/codex-transport";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import type { AgentRunRecord, CodexCollabCallRecord, JsonObject, TaskRecord, WorkSessionRecord } from "@/lib/shared/types";
import type { ApprovalKind } from "@/lib/shared/types";
import type { RuntimeExecutionResult } from "@/lib/server/runtime/execution-result";


interface ResolvedRuntime {
  sandboxMode: string;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  networkAccess: boolean | null;
  timeoutMs: number;
}

async function resolveRuntime(workSession: WorkSessionRecord, config: AppConfig): Promise<ResolvedRuntime> {
  const overrides = workSession.runtimeOverrides;
  const rawEffort = (overrides?.reasoningEffort ?? config.codexReasoningEffort)?.trim();
  const normalizedEffort = rawEffort === undefined || rawEffort.length === 0 || rawEffort === "minimal" ? null : rawEffort;
  const resolved = await validateCodexModelReasoning({
    model: overrides?.model ?? (config.codexModel.trim().length > 0 ? config.codexModel.trim() : null),
    reasoningEffort: normalizedEffort,
    serviceTier: overrides?.serviceTier ?? null,
  });
  return {
    sandboxMode: overrides?.sandboxMode ?? config.codexSandboxMode,
    model: resolved.model,
    reasoningEffort: resolved.reasoningEffort,
    serviceTier: resolved.serviceTier,
    networkAccess: overrides?.networkAccess ?? null,
    timeoutMs: overrides?.timeoutMs ?? config.codexTimeoutMs,
  };
}

function spawnTargetFor(command: string, args: string[]): SpawnTarget {
  if (process.platform === "win32" && isWindowsBatchCommand(command)) {
    return windowsBatchSpawnTarget(command, args);
  }
  return { command, args };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function serviceTierParam(serviceTier: string | null): string | null | undefined {
  if (serviceTier === null) return undefined;
  if (serviceTier === standardServiceTier) return null;
  return serviceTier;
}

function nativeSubagentRootUsageHint(maxThreads: number): string {
  const childSlots = Math.max(1, maxThreads - 1);
  return `You are /root, the primary agent in an app-owned Codex multi-agent run.
This run is configured with max_concurrent_threads_per_session = ${maxThreads}, which includes /root, so at most ${childSlots} subagent thread(s) can be open at the same time.
Use spawn_agent only for genuinely independent backend/frontend/research slices. Keep the graph shallow: prefer direct children of /root, and do not ask subagents to spawn their own children unless the user explicitly requested nested delegation.
Do not set the spawn_agent model or reasoning_effort fields unless the user explicitly requested a different child model; inherited model/settings are the default and safest path.
Wait for useful subagent output and integrate it yourself. If a helper does not produce useful output after one wait, continue the task directly. Only close agents when you must free capacity before spawning another child; do not issue close_agent as final cleanup after a child has reported.`;
}

function nativeSubagentChildUsageHint(maxThreads: number): string {
  const childSlots = Math.max(1, maxThreads - 1);
  return `You are a subagent in an app-owned Codex multi-agent run.
The entire session has max_concurrent_threads_per_session = ${maxThreads}, including /root, so only ${childSlots} subagent thread(s) can be open at once.
Complete your assigned task yourself and report back to your parent. Do not spawn further subagents unless your parent prompt explicitly says you may spawn nested subagents.
If your parent explicitly permits nested spawning, omit model and reasoning_effort unless the user requested a different child model, wait for the result, and close agents only when you must free capacity before spawning another child.`;
}

const staleCollabReason = "The parent Codex app-server turn ended before this collab tool reported completion.";

function collabSortTime(call: Pick<CodexCollabCallRecord, "startedAt" | "completedAt">): string {
  return call.completedAt ?? call.startedAt ?? "";
}

function mergeCodexCollabCall(previous: CodexCollabCallRecord, incoming: CodexCollabCallRecord): CodexCollabCallRecord {
  const status = incoming.status === "unknown" ? previous.status : incoming.status;
  return {
    ...previous,
    ...incoming,
    status,
    senderThreadId: incoming.senderThreadId ?? previous.senderThreadId,
    receiverThreadIds: incoming.receiverThreadIds.length > 0 ? incoming.receiverThreadIds : previous.receiverThreadIds,
    prompt: incoming.prompt ?? previous.prompt,
    model: incoming.model ?? previous.model,
    reasoningEffort: incoming.reasoningEffort ?? previous.reasoningEffort,
    agentsStates: { ...previous.agentsStates, ...incoming.agentsStates },
    failureReason: status === "completed" && incoming.failureReason === null ? null : incoming.failureReason ?? previous.failureReason,
    startedAt: previous.startedAt ?? incoming.startedAt,
    completedAt: incoming.completedAt ?? previous.completedAt,
    raw: { ...previous.raw, ...incoming.raw },
  };
}

function completedSubagentReports(calls: CodexCollabCallRecord[], rootThreadId: string | null): CodexCollabCallRecord[] {
  return calls
    .filter((call) => {
      if (call.tool !== "sendInput" || call.status !== "completed") return false;
      if (call.prompt === null || call.prompt.trim().length === 0) return false;
      const effectiveRootThreadId = rootThreadId ?? call.rootThreadId;
      if (effectiveRootThreadId === null) return true;
      return call.senderThreadId !== null && call.senderThreadId !== effectiveRootThreadId;
    })
    .sort((a, b) => collabSortTime(a).localeCompare(collabSortTime(b)) || a.id.localeCompare(b.id));
}

function hasSupersedingSpawn(call: CodexCollabCallRecord, calls: CodexCollabCallRecord[]): boolean {
  return calls.some((candidate) => {
    if (candidate.id === call.id || candidate.tool !== "spawnAgent" || candidate.status !== "completed" || candidate.receiverThreadIds.length === 0) {
      return false;
    }
    const callTime = call.startedAt ?? call.completedAt ?? "";
    const candidateTime = collabSortTime(candidate);
    return callTime.length === 0 || candidateTime.length === 0 || candidateTime >= callTime;
  });
}

function staleCallIsBenignAfterSubagentReport(
  call: CodexCollabCallRecord,
  calls: CodexCollabCallRecord[],
  reportSenderThreadIds: Set<string>,
): boolean {
  if (call.status !== "stale") return true;
  if (call.tool === "closeAgent") {
    return call.receiverThreadIds.length === 0 || call.receiverThreadIds.some((threadId) => reportSenderThreadIds.has(threadId));
  }
  if (call.tool === "wait") {
    return reportSenderThreadIds.size > 0;
  }
  if (call.tool === "spawnAgent") {
    if (call.receiverThreadIds.length === 0) {
      return hasSupersedingSpawn(call, calls);
    }
    return call.receiverThreadIds.some((threadId) => reportSenderThreadIds.has(threadId));
  }
  return false;
}

function interruptedCollabRecovery(input: {
  calls: CodexCollabCallRecord[];
  rootThreadId: string | null;
  codeChangeCount: number;
}): { latestReport: string; staleCallCount: number; acceptedStaleCallCount: number } | null {
  if (input.codeChangeCount <= 0) return null;
  const reports = completedSubagentReports(input.calls, input.rootThreadId);
  if (reports.length === 0) return null;
  const reportSenderThreadIds = new Set(reports.map((call) => call.senderThreadId).filter((threadId): threadId is string => threadId !== null));
  const staleCalls = input.calls.filter((call) => call.status === "stale");
  const unresolved = staleCalls.filter((call) => !staleCallIsBenignAfterSubagentReport(call, input.calls, reportSenderThreadIds));
  if (unresolved.length > 0) return null;
  const latestReport = reports[reports.length - 1]?.prompt?.trim() ?? "";
  if (latestReport.length === 0) return null;
  return {
    latestReport,
    staleCallCount: staleCalls.length,
    acceptedStaleCallCount: staleCalls.length,
  };
}

function formatCollabReport(calls: CodexCollabCallRecord[]): string {
  if (calls.length === 0) return "- (none)";
  return calls
    .slice()
    .sort((a, b) => collabSortTime(a).localeCompare(collabSortTime(b)) || a.id.localeCompare(b.id))
    .map((call) => {
      const targetText = call.receiverThreadIds.length > 0 ? ` -> ${call.receiverThreadIds.map((id) => id.slice(0, 8)).join(",")}` : "";
      const reasonText = call.failureReason !== null && call.failureReason.trim().length > 0 ? ` (${call.failureReason.trim()})` : "";
      const promptText = call.tool === "sendInput" && call.prompt !== null && call.prompt.trim().length > 0
        ? `\n  Report: ${boundedText(call.prompt, 1200).replace(/\n/g, "\n  ")}`
        : "";
      return `- ${call.tool}${targetText}: ${call.status}${reasonText}${promptText}`;
    })
    .join("\n");
}

export class CodexAppServerProtocolError extends Error {}
export class CodexAppServerStartupError extends CodexAppServerProtocolError {}

interface RunOutcome {
  status: "completed" | "interrupted" | "failed" | "timeout";
  summary: string;
  errorMessage: string | null;
}

function isGenericCodexAppServerError(message: string | null): boolean {
  return message?.trim().replace(/\.+$/, "").toLowerCase() === "codex app-server error";
}

function appServerErrorText(params: Record<string, unknown>): string {
  if (typeof params.message === "string" && params.message.trim().length > 0) return params.message;
  const nested = asRecord(params.error);
  if (typeof nested?.message === "string" && nested.message.trim().length > 0) return nested.message;
  try {
    const serialized = JSON.stringify(params);
    if (typeof serialized === "string" && serialized !== "{}") {
      return `Codex app-server error: ${serialized.slice(0, 600)}`;
    }
  } catch {
  }
  return "Codex app-server error.";
}

function isToolDeclarationRejection(message: string | null): boolean {
  if (message === null) return false;
  const normalized = message.toLowerCase();
  const rejection =
    normalized.includes("invalid") ||
    normalized.includes("not configured") ||
    normalized.includes("unsupported") ||
    normalized.includes("not supported");
  const aboutTools =
    normalized.includes("'tools'") ||
    normalized.includes("\"tools\"") ||
    normalized.includes("tool use") ||
    normalized.includes("spawn_agent");
  return rejection && aboutTools;
}

function latestAgentMessage(messages: string[]): string {
  return messages[messages.length - 1]?.trim() ?? "";
}

export async function executeWithCodexAppServer(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  agentRun: AgentRunRecord;
  transportDecision?: CodexTransportDecision;
}): Promise<RuntimeExecutionResult> {
  const config = getConfig();
  const transportDecision = input.transportDecision ?? resolveCodexTransport({
    intent: "execute",
    workSession: input.workSession,
    task: input.task,
    explicitNativeFeatureRequested: requestsNativeCodexSubagents({ workSession: input.workSession, task: input.task }),
  });
  const workspacePath = input.workSession.activeWorktreePath;
  await assertSafeWorkspace(workspacePath, { operation: "Codex app-server execution" });
  await mkdir(workspacePath, { recursive: true });
  await ensureWorkspaceAgentsMd(workspacePath);

  const emit = (eventName: Parameters<typeof emitEvent>[0]["eventName"], message: string, extra: Record<string, string | boolean> = {}, priority: "low" | "normal" | "high" = "normal"): Promise<void> =>
    emitEvent({
      workSessionId: input.workSession.id,
      eventName,
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { message, ...extra },
      priority,
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });

  await emit("agent.preflight.started", "Checking Codex CLI availability (app-server).");
  const doctor = await runCodexDoctor();
  if (!doctor.available) {
    await emit("agent.preflight.failed", doctor.error ?? "Codex CLI is unavailable.", { version: doctor.version ?? "" }, "high");
    throw new CodexAppServerStartupError(`Codex app-server preflight failed: ${doctor.error ?? "unavailable."}`);
  }
  await emit("agent.preflight.passed", "Codex CLI preflight passed (app-server).", { version: doctor.version ?? "" });

  const beforeSnapshot = await snapshotWorkspace(workspacePath);
  const runtime = await resolveRuntime(input.workSession, config);
  const executable = await resolveCodexCliBin();

  const persistent = transportDecision.persistentThread;
  const existingThreadId = persistent ? input.workSession.codexThreadId : null;
  let willResume = existingThreadId !== null;
  const built = await buildCodexTaskPrompt({ workSession: input.workSession, task: input.task, includeOrchestratorContext: !willResume });
  let prompt = built.prompt;
  const { steeringBlock, steeringMessageIds } = built;

  logProcess("info", "codex.appserver.prompt.prepared", {
    workSessionId: input.workSession.id,
    taskId: input.task.id,
    agentRunId: input.agentRun.id,
    promptChars: prompt.length,
    appliedSteeringCount: steeringMessageIds.length,
    steeringBlockChars: steeringBlock.length,
  });

  const transcript: string[] = [];
  const agentMessages: string[] = [];
  const reasoningMessages: string[] = [];
  const collabCalls = new Map<string, CodexCollabCallRecord>();
  let threadId: string | null = null;
  let turnId: string | null = null;
  let abortReason: string | null = null;
  let lastUsage: { prompt: number | null; output: number | null; window: number | null } = { prompt: null, output: null, window: null };
  let liveStatus: "starting" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted" = "starting";
  let threadStarted = false;
  let turnStarted = false;
  let workspaceMutationPossible = false;

  const target = spawnTargetFor(executable.command, ["app-server"]);

  const runAttempt = (allowNativeSubagents: boolean): Promise<RunOutcome> => new Promise<RunOutcome>((resolve) => {
    let settled = false;
    let nextId = 1;
    const pending = new Map<number, (message: Record<string, unknown>) => void>();
    const pendingApprovals = new Map<string, { requestId: number; method: string; params: Record<string, unknown> }>();
    let buffer = "";

    const child = spawnChild();

    function spawnChild(): ReturnType<typeof spawn> {
      try {
        return spawn(target.command, target.args, {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: target.windowsVerbatimArguments,
          cwd: workspacePath,
          env: createSanitizedProcessEnv({
            PORT: process.env.GENERATED_APP_PORT ?? "3100",
            CI: "true",
            NEXT_TELEMETRY_DISABLED: "1",
          }) as NodeJS.ProcessEnv,
        });
      } catch (error) {
        throw new CodexAppServerStartupError(error instanceof Error ? error.message : "Codex app-server spawn failed.");
      }
    }

    const finish = (value: RunOutcome): void => {
      if (settled) return;
      settled = true;
      liveStatus = value.status === "completed" ? "completed" : value.status === "interrupted" ? "interrupted" : "failed";
      clearTimeout(timer);
      void expirePendingApprovals(value.status);
      try {
        child.kill();
      } catch {
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish({ status: "timeout", summary: "", errorMessage: `Codex app-server timed out after ${runtime.timeoutMs}ms.` }), runtime.timeoutMs);

    const writeRaw = (message: Record<string, unknown>): void => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish({ status: "failed", summary: "", errorMessage: "Codex app-server stdin closed." });
      }
    };
    const request = (method: string, params: Record<string, unknown> | undefined): Promise<Record<string, unknown>> =>
      new Promise<Record<string, unknown>>((resolveReq, rejectReq) => {
        const id = nextId++;
        pending.set(id, (message) => {
          const error = asRecord(message.error);
          if (error !== null) {
            rejectReq(new CodexAppServerProtocolError(codexErrorMessage(error, `error from ${method}`)));
            return;
          }
          resolveReq(asRecord(message.result) ?? {});
        });
        writeRaw({ jsonrpc: "2.0", id, method, params });
      });
    const notify = (method: string, params: Record<string, unknown>): void => writeRaw({ jsonrpc: "2.0", method, params });

    const approvalKindForMethod = (method: string): ApprovalKind | null => {
      switch (method) {
        case "item/commandExecution/requestApproval":
          return "codex_command";
        case "item/fileChange/requestApproval":
          return "codex_file_change";
        case "item/permissions/requestApproval":
          return "codex_permissions";
        case "item/tool/requestUserInput":
          return "codex_tool_input";
        case "mcpServer/elicitation/request":
          return "codex_mcp_elicitation";
        default:
          return null;
      }
    };

    const approvalReason = (method: string, params: Record<string, unknown>): string => {
      const reason = typeof params.reason === "string" && params.reason.trim().length > 0 ? params.reason.trim() : "";
      if (reason.length > 0) return reason.slice(0, 500);
      const command = Array.isArray(params.command) ? params.command.join(" ") : typeof params.command === "string" ? params.command : "";
      if (command.length > 0) return `Codex requests approval to run: ${command.slice(0, 300)}`;
      if (method === "item/fileChange/requestApproval") return "Codex requests approval for file changes.";
      if (method === "item/permissions/requestApproval") return "Codex requests additional permissions.";
      if (method === "item/tool/requestUserInput") return "Codex requests user input.";
      if (method === "mcpServer/elicitation/request") return "Codex requests MCP elicitation input.";
      return "Codex requests approval.";
    };

    const responseForApproval = (method: string, status: "approved" | "rejected", params: Record<string, unknown>): Record<string, unknown> => {
      const approved = status === "approved";
      switch (method) {
        case "item/commandExecution/requestApproval":
          return { decision: approved ? "accept" : "decline" };
        case "item/fileChange/requestApproval":
          return { decision: approved ? "accept" : "decline" };
        case "item/permissions/requestApproval":
          if (!approved) {
            return { permissions: {}, scope: "turn", strictAutoReview: true };
          }
          return {
            permissions: asRecord(params.permissions) ?? asRecord(params.additionalPermissions) ?? {},
            scope: "turn",
          };
        default:
          return approved ? { response: "" } : { canceled: true };
      }
    };

    const expirePendingApprovals = async (status: RunOutcome["status"]): Promise<void> => {
      if (pendingApprovals.size === 0) return;
      const ids = [...pendingApprovals.keys()];
      await mutateDatabase((db) => {
        const now = currentTimestamp();
        for (const approval of db.approvals) {
          if (ids.includes(approval.id) && approval.status === "pending") {
            approval.status = "expired";
            approval.resolvedAt = now;
            approval.resolvedBy = null;
          }
        }
      }).catch(() => undefined);
      pendingApprovals.clear();
      logProcess("warn", "codex.appserver.pending_approvals_expired", {
        workSessionId: input.workSession.id,
        agentRunId: input.agentRun.id,
        status,
        approvalIds: ids.join(","),
      });
    };

    const handleServerRequest = async (requestId: number, method: string, params: Record<string, unknown>): Promise<void> => {
      const approvalKind = approvalKindForMethod(method);
      if (approvalKind === null) {
        logProcess("warn", "codex.appserver.unexpected_request", {
          workSessionId: input.workSession.id,
          method,
        });
        writeRaw({ jsonrpc: "2.0", id: requestId, error: { code: -32601, message: "Unsupported Codex app-server request." } });
        return;
      }
      const now = currentTimestamp();
      const approval = await mutateDatabase((db) => {
        const record = createApprovalRecord({
          workSessionId: input.workSession.id,
          agentRunId: input.agentRun.id,
          approvalKind,
          reason: approvalReason(method, params),
          payload: {
            codexAppServer: true,
            method,
            requestId: String(requestId),
            threadId: typeof params.threadId === "string" ? params.threadId : threadId ?? "",
            turnId: typeof params.turnId === "string" ? params.turnId : turnId ?? "",
            sourceThreadId: typeof params.threadId === "string" ? params.threadId : threadId ?? "",
            sourceTurnId: typeof params.turnId === "string" ? params.turnId : turnId ?? "",
            isSubagentApproval: typeof params.threadId === "string" && threadId !== null && params.threadId !== threadId,
            itemId: typeof params.itemId === "string" ? params.itemId : "",
            params: jsonObject(params),
          },
          status: "pending",
          externalRequestId: String(requestId),
          externalRequestMethod: method,
          codexThreadId: typeof params.threadId === "string" ? params.threadId : threadId,
          codexTurnId: typeof params.turnId === "string" ? params.turnId : turnId,
        });
        db.approvals.push(record);
        const run = db.agentRuns.find((candidate) => candidate.id === input.agentRun.id);
        if (run !== undefined) {
          run.status = "waiting_approval";
        }
        const ws = db.workSessions.find((candidate) => candidate.id === input.workSession.id);
        if (ws !== undefined) {
          ws.currentState = "awaiting_approval";
          updateWorkSessionTimestamp(ws);
        }
        return { ...record };
      });
      pendingApprovals.set(approval.id, { requestId, method, params });
      liveStatus = "waiting_approval";
      await emitEvent({
        workSessionId: input.workSession.id,
        eventName: "approval.requested",
        aggregateType: "approval",
        aggregateId: approval.id,
        priority: "high",
        payload: {
          message: approval.reason,
          approvalKind,
          method,
          requestId: String(requestId),
          threadId: typeof params.threadId === "string" ? params.threadId : threadId ?? "",
          isSubagentApproval: typeof params.threadId === "string" && threadId !== null && params.threadId !== threadId,
          requestedAt: now,
        },
        context: { taskId: input.task.id, agentRunId: input.agentRun.id, approvalId: approval.id },
      });
    };

    registerProcess({
      agentRunId: input.agentRun.id,
      workSessionId: input.workSession.id,
      abort: (reason?: string) => {
        abortReason = reason ?? "user";
        if (threadId !== null && turnId !== null) {
          void request("turn/interrupt", { threadId, turnId }).catch(() => undefined);
        }
        finish({ status: "interrupted", summary: agentMessages[agentMessages.length - 1] ?? "", errorMessage: null });
      },
      steer: async (steering) => {
        if (threadId === null || turnId === null) {
          return { ok: false, message: "Codex app-server has no active turn to steer." };
        }
        if (liveStatus !== "running" && liveStatus !== "waiting_approval") {
          return { ok: false, message: `Codex app-server turn is not steerable in status ${liveStatus}.` };
        }
        await request("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: steering.clientUserMessageId ?? steering.steeringId,
          input: [{ type: "text", text: steering.content, text_elements: [] }],
        });
        await emitEvent({
          workSessionId: input.workSession.id,
          eventName: "task.progress",
          aggregateType: "agent_run",
          aggregateId: input.agentRun.id,
          payload: { message: "Live steering injected into the running Codex turn." },
          producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
          context: { taskId: input.task.id, agentRunId: input.agentRun.id },
        });
        return { ok: true, message: "Live steering sent to Codex.", data: { threadId, turnId } };
      },
      updateSettings: async (settings) => {
        if (threadId === null) {
          return { ok: false, message: "Codex app-server has no active thread to update." };
        }
        await request("thread/settings/update", { threadId, ...settings });
        return { ok: true, message: "Codex thread settings update requested.", data: { threadId } };
      },
      resolveApproval: async (resolution) => {
        const pendingApproval = pendingApprovals.get(resolution.approvalId);
        if (pendingApproval === undefined) {
          return { ok: false, message: "Codex approval request is no longer live." };
        }
        const result = responseForApproval(pendingApproval.method, resolution.status, pendingApproval.params);
        writeRaw({ jsonrpc: "2.0", id: pendingApproval.requestId, result });
        pendingApprovals.delete(resolution.approvalId);
        liveStatus = "running";
        await mutateDatabase((db) => {
          const run = db.agentRuns.find((candidate) => candidate.id === input.agentRun.id);
          if (run !== undefined && run.status === "waiting_approval") {
            run.status = "running";
          }
          const ws = db.workSessions.find((candidate) => candidate.id === input.workSession.id);
          if (ws !== undefined && ws.currentState === "awaiting_approval") {
            ws.currentState = "executing";
            updateWorkSessionTimestamp(ws);
          }
        });
        return { ok: true, message: "Codex approval request resolved.", data: { threadId, turnId } };
      },
      getNativeThreadState: () => ({
        agentRunId: input.agentRun.id,
        workSessionId: input.workSession.id,
        threadId,
        turnId,
        status: liveStatus,
      }),
    });

    const onCompaction = (): void => {
      const trigger = "auto" as const;
      transcript.push(`### context compaction (${trigger})`);
      logProcess("info", "compaction.live.observed", {
        workSessionId: input.workSession.id,
        agentRunId: input.agentRun.id,
        threadId,
        trigger,
        promptTokens: lastUsage.prompt ?? -1,
        contextWindow: lastUsage.window ?? -1,
      });
      void recordRuntimeUsage({
        workSessionId: input.workSession.id,
        agentRunId: input.agentRun.id,
        taskId: input.task.id,
        provider: "codex-cli",
        model: runtime.model,
        promptTokens: lastUsage.prompt,
        outputTokens: lastUsage.output,
        contextWindow: lastUsage.window,
        threadId,
        compactionTrigger: trigger,
        compactionAt: new Date().toISOString(),
      });
    };

    const handleCollabItem = (
      item: Record<string, unknown>,
      method: "item/started" | "item/completed",
      source: { threadId: string | null; turnId: string | null },
    ): void => {
      const call = parseCodexCollabToolCall({
        item,
        workSessionId: input.workSession.id,
        agentRunId: input.agentRun.id,
        rootThreadId: threadId,
        turnId: source.turnId ?? turnId,
        startedAt: method === "item/started" ? new Date().toISOString() : null,
        completedAt: method === "item/completed" ? new Date().toISOString() : null,
      });
      if (call === null) return;
      const previousLocal = collabCalls.get(call.id);
      const mergedLocal = previousLocal === undefined ? call : mergeCodexCollabCall(previousLocal, call);
      collabCalls.set(call.id, mergedLocal);
      void mutateDatabase((db) => {
        const ws = db.workSessions.find((candidate) => candidate.id === input.workSession.id);
        if (ws === undefined) return;
        ws.codexCollabCalls ??= [];
        ws.codexSubagents ??= [];
        const previous = ws.codexCollabCalls.find((candidate) => candidate.id === call.id);
        const merged = previous === undefined ? call : mergeCodexCollabCall(previous, call);
        ws.codexCollabCalls = [...ws.codexCollabCalls.filter((candidate) => candidate.id !== call.id), merged].slice(-200);
        ws.codexSubagents = subagentRecordsFromCollabCall(merged, ws.codexSubagents);
        updateWorkSessionTimestamp(ws);
      }).catch(() => undefined);

      const eventName = method === "item/started" ? "codex.collab.started" : "codex.collab.completed";
      void emitEvent({
        workSessionId: input.workSession.id,
        eventName,
        aggregateType: "agent_run",
        aggregateId: input.agentRun.id,
        payload: {
          message: collabCallSummary(mergedLocal),
          callId: mergedLocal.id,
          tool: mergedLocal.tool,
          status: mergedLocal.status,
          rootThreadId: mergedLocal.rootThreadId ?? "",
          turnId: mergedLocal.turnId ?? "",
          sourceThreadId: source.threadId ?? "",
          sourceTurnId: source.turnId ?? "",
          senderThreadId: mergedLocal.senderThreadId ?? "",
          receiverThreadIds: mergedLocal.receiverThreadIds.join(","),
          receiverThreadIdList: mergedLocal.receiverThreadIds,
          prompt: mergedLocal.prompt ?? "",
          model: mergedLocal.model ?? "",
          reasoningEffort: mergedLocal.reasoningEffort ?? "",
          agentsStates: jsonObject(mergedLocal.agentsStates),
          failureReason: mergedLocal.failureReason ?? "",
        },
        priority: "low",
        producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
        context: { taskId: input.task.id, agentRunId: input.agentRun.id },
      });
      if (mergedLocal.tool === "spawnAgent" && method === "item/completed" && mergedLocal.receiverThreadIds.length > 0) {
        void emitEvent({
          workSessionId: input.workSession.id,
          eventName: "codex.subagent.spawned",
          aggregateType: "agent_run",
          aggregateId: input.agentRun.id,
          payload: {
            message: collabCallSummary(mergedLocal),
            callId: mergedLocal.id,
            rootThreadId: mergedLocal.rootThreadId ?? "",
            turnId: mergedLocal.turnId ?? "",
            sourceThreadId: source.threadId ?? "",
            sourceTurnId: source.turnId ?? "",
            senderThreadId: mergedLocal.senderThreadId ?? "",
            receiverThreadIds: mergedLocal.receiverThreadIds.join(","),
            receiverThreadIdList: mergedLocal.receiverThreadIds,
            prompt: mergedLocal.prompt ?? "",
            model: mergedLocal.model ?? "",
            reasoningEffort: mergedLocal.reasoningEffort ?? "",
            agentsStates: jsonObject(mergedLocal.agentsStates),
            failureReason: mergedLocal.failureReason ?? "",
          },
          priority: "normal",
          producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
          context: { taskId: input.task.id, agentRunId: input.agentRun.id },
        });
      }
      if (method === "item/completed") {
        void streamDelta(collabCallSummary(mergedLocal).slice(0, 240));
      }
    };

    const markInProgressCollabCallsStale = (completedAt: string = new Date().toISOString()): void => {
      for (const [id, call] of collabCalls.entries()) {
        if (call.agentRunId !== input.agentRun.id || call.turnId !== turnId || call.status !== "inProgress") {
          continue;
        }
        collabCalls.set(id, markCodexCollabCallStale(call, completedAt, staleCollabReason));
      }
      void mutateDatabase((db) => {
        const ws = db.workSessions.find((candidate) => candidate.id === input.workSession.id);
        if (ws === undefined || ws.codexCollabCalls === undefined) return;
        ws.codexCollabCalls = ws.codexCollabCalls.map((call) => {
          if (call.agentRunId !== input.agentRun.id || call.turnId !== turnId || call.status !== "inProgress") {
            return call;
          }
          return markCodexCollabCallStale(call, completedAt, staleCollabReason);
        });
        updateWorkSessionTimestamp(ws);
      }).catch(() => undefined);
    };

    const discardInProgressCollabCallsForCompletedTurn = (): void => {
      for (const [id, call] of collabCalls.entries()) {
        if (call.agentRunId === input.agentRun.id && call.turnId === turnId && call.status === "inProgress") {
          collabCalls.delete(id);
        }
      }
      void mutateDatabase((db) => {
        const ws = db.workSessions.find((candidate) => candidate.id === input.workSession.id);
        if (ws === undefined || ws.codexCollabCalls === undefined) return;
        ws.codexCollabCalls = ws.codexCollabCalls.filter((call) => {
          return !(call.agentRunId === input.agentRun.id && call.turnId === turnId && call.status === "inProgress");
        });
        updateWorkSessionTimestamp(ws);
      }).catch(() => undefined);
    };

    const handleNotification = (method: string, params: Record<string, unknown>): void => {
      switch (method) {
        case "thread/tokenUsage/updated": {
          const usage = asRecord(params.tokenUsage);
          const last = asRecord(usage?.last);
          lastUsage = {
            prompt: numberOrNull(last?.inputTokens),
            output: numberOrNull(last?.outputTokens),
            window: numberOrNull(usage?.modelContextWindow),
          };
          void recordRuntimeUsage({
            workSessionId: input.workSession.id,
            agentRunId: input.agentRun.id,
            taskId: input.task.id,
            provider: "codex-cli",
            model: runtime.model,
            promptTokens: lastUsage.prompt,
            outputTokens: lastUsage.output,
            contextWindow: lastUsage.window,
            threadId,
            emit: false,
          });
          break;
        }
        case "thread/compacted": {
          onCompaction();
          break;
        }
        case "item/started":
        case "item/completed": {
          const item = asRecord(params.item);
          const itemType = typeof item?.type === "string" ? item.type : "";
          const source = {
            threadId: stringOrNull(params.threadId),
            turnId: stringOrNull(params.turnId),
          };
          if (itemType === "contextCompaction") {
            onCompaction();
          } else if (item !== null && itemType === "collabAgentToolCall") {
            handleCollabItem(item, method, source);
          } else if (itemType === "agentMessage" && method === "item/completed") {
            const text = typeof item?.text === "string" ? item.text.trim() : "";
            if (text.length > 0) {
              agentMessages.push(text);
              void streamDelta(text.slice(0, 400));
            }
          } else if ((itemType === "reasoning" || itemType === "reasoningMessage") && method === "item/completed") {
            const text = typeof item?.text === "string"
              ? item.text.trim()
              : typeof item?.summary === "string"
                ? item.summary.trim()
                : "";
            if (text.length > 0) {
              reasoningMessages.push(text);
            }
          } else if (itemType === "commandExecution" && method === "item/completed") {
            const command = typeof item?.command === "string" ? item.command : "";
            if (command.length > 0) void streamDelta(`$ ${command.slice(0, 200)}`);
          }
          break;
        }
        case "item/agentMessage/delta": {
          const delta = typeof params.delta === "string" ? params.delta : "";
          if (delta.trim().length > 0) void streamDelta(delta.slice(0, 200));
          break;
        }
        case "turn/completed": {
          const turn = asRecord(params.turn);
          const completedThreadId = stringOrNull(params.threadId) ?? threadId;
          const completedTurnId = stringOrNull(turn?.id) ?? stringOrNull(params.turnId) ?? turnId;
          if ((threadId !== null && completedThreadId !== threadId) || (turnId !== null && completedTurnId !== turnId)) {
            break;
          }
          const status = typeof turn?.status === "string" ? turn.status : "completed";
          const error = asRecord(turn?.error);
          if (status === "failed") {
            markInProgressCollabCallsStale();
            finish({ status: "failed", summary: agentMessages[agentMessages.length - 1] ?? "", errorMessage: typeof error?.message === "string" ? error.message : "Codex turn failed." });
          } else if (status === "interrupted") {
            markInProgressCollabCallsStale();
            finish({ status: "interrupted", summary: agentMessages[agentMessages.length - 1] ?? "", errorMessage: null });
          } else {
            discardInProgressCollabCallsForCompletedTurn();
            finish({ status: "completed", summary: agentMessages[agentMessages.length - 1] ?? "Codex completed the task.", errorMessage: null });
          }
          break;
        }
        case "error": {
          const message = appServerErrorText(params);
          transcript.push(`### error: ${message}`);
          markInProgressCollabCallsStale();
          finish({ status: "failed", summary: agentMessages[agentMessages.length - 1] ?? "", errorMessage: message });
          break;
        }
        default:
          break;
      }
    };

    const streamDelta = async (text: string): Promise<void> => {
      const summary = text.replace(/\s+/g, " ").trim();
      if (summary.length === 0) return;
      await emitEvent({
        workSessionId: input.workSession.id,
        eventName: "agent.process.output.delta",
        aggregateType: "agent_run",
        aggregateId: input.agentRun.id,
        payload: { stream: "stdout", text: summary, message: `stdout: ${summary}` },
        priority: "low",
        producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
        context: { taskId: input.task.id, agentRunId: input.agentRun.id },
      });
    };

    child.on("error", () => {
      markInProgressCollabCallsStale();
      finish({ status: "failed", summary: "", errorMessage: "Codex app-server process error." });
    });
    child.on("close", () => {
      markInProgressCollabCallsStale();
      finish({ status: "failed", summary: agentMessages[agentMessages.length - 1] ?? "", errorMessage: abortReason !== null ? null : "Codex app-server closed before completion." });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length === 0) continue;
        const decoded = decodeCodexAppServerLine(line);
        if (decoded.kind === "invalid") {
          logProcess("warn", "codex.appserver.protocol.invalid_message", {
            workSessionId: input.workSession.id,
            reason: decoded.reason,
          });
          continue;
        }
        if (decoded.kind === "response") {
          const resolver = pending.get(decoded.id);
          if (resolver !== undefined) {
            pending.delete(decoded.id);
            resolver({ result: decoded.result, error: decoded.error });
          }
          continue;
        }
        if (decoded.kind === "server_request") {
          void handleServerRequest(decoded.id, decoded.method, decoded.params).catch((error) => {
            const message = error instanceof Error ? error.message : "Codex app-server request handling failed.";
            logProcess("warn", "codex.appserver.request_failed", {
              workSessionId: input.workSession.id,
              method: decoded.method,
              message,
            });
            writeRaw({ jsonrpc: "2.0", id: decoded.id, error: { code: -32000, message } });
          });
          continue;
        }
        if (decoded.kind === "notification") {
          handleNotification(decoded.method, decoded.params);
        }
      }
    });

    void (async () => {
      try {
        await request("initialize", {
          clientInfo: { name: "closed-loop", title: "closed-loop codex app-server", version: "0.0.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        notify("initialized", {});

        const nativeSubagentsRequested = allowNativeSubagents && requestsNativeCodexSubagents({ workSession: input.workSession, task: input.task });
        const config2: Record<string, unknown> = {
          web_search: "disabled",
          "features.image_generation": false,
          "features.apps": false,
          "features.browser_use": false,
          "features.plugins": false,
        };
        if (nativeSubagentsRequested) {
          config2["features.multi_agent_v2.enabled"] = true;
          config2["features.multi_agent_v2.max_concurrent_threads_per_session"] = config.codexMultiAgentMaxThreads;
          config2["features.multi_agent_v2.usage_hint_enabled"] = true;
          config2["features.multi_agent_v2.root_agent_usage_hint_text"] = nativeSubagentRootUsageHint(config.codexMultiAgentMaxThreads);
          config2["features.multi_agent_v2.subagent_usage_hint_text"] = nativeSubagentChildUsageHint(config.codexMultiAgentMaxThreads);
          config2["features.collab"] = true;
        }
        if (runtime.networkAccess !== null) {
          config2["sandbox_workspace_write.network_access"] = runtime.networkAccess;
        }
        const effectiveServiceTier = serviceTierParam(runtime.serviceTier);
        if (effectiveServiceTier === null) {
          config2.service_tier = null;
        } else if (typeof effectiveServiceTier === "string") {
          config2.service_tier = effectiveServiceTier;
          config2["features.fast_mode"] = true;
        }
        const baseParams: Record<string, unknown> = {
          cwd: workspacePath,
          runtimeWorkspaceRoots: codexRuntimeWorkspaceRoots(input.workSession),
          approvalPolicy: config.codexApprovalPolicy,
          sandbox: runtime.sandboxMode,
          config: config2,
        };
        if (runtime.model !== null) baseParams.model = runtime.model;
        if (effectiveServiceTier !== undefined) baseParams.serviceTier = effectiveServiceTier;

        let resolvedThreadId: string | null = null;
        if (willResume && existingThreadId !== null) {
          try {
            const resumeResult = await request("thread/resume", { ...baseParams, threadId: existingThreadId, excludeTurns: true });
            const resumedThread = asRecord(resumeResult.thread);
            resolvedThreadId = typeof resumedThread?.id === "string" ? resumedThread.id : existingThreadId;
            threadStarted = true;
            logProcess("info", "codex.appserver.thread_resumed", {
            workSessionId: input.workSession.id,
            threadId: resolvedThreadId,
            orchestratorContextReinjected: false,
            nativeSubagentsRequested,
          });
            await emit("agent.process.started", `Codex app-server thread resumed (${resolvedThreadId.slice(0, 8)}).`, { pid: "" });
          } catch (resumeError) {
            logProcess("warn", "codex.appserver.resume_failed", {
              workSessionId: input.workSession.id,
              threadId: existingThreadId,
              error: resumeError instanceof Error ? resumeError.message : String(resumeError),
            });
            willResume = false;
            prompt = (await buildCodexTaskPrompt({ workSession: input.workSession, task: input.task, includeOrchestratorContext: true })).prompt;
          }
        }
        if (resolvedThreadId === null) {
          const threadResult = await request("thread/start", baseParams);
          const thread = asRecord(threadResult.thread);
          resolvedThreadId = typeof thread?.id === "string" ? thread.id : null;
          if (resolvedThreadId === null) {
            throw new CodexAppServerProtocolError("thread/start returned no thread id");
          }
          threadStarted = true;
          if (persistent) {
            const newThreadId = resolvedThreadId;
            await mutateDatabase((db) => {
              const ws = db.workSessions.find((candidate) => candidate.id === input.workSession.id);
              if (ws !== undefined) {
                ws.codexThreadId = newThreadId;
                updateWorkSessionTimestamp(ws);
              }
            });
          }
          logProcess("info", "codex.appserver.thread_started", {
            workSessionId: input.workSession.id,
            threadId: resolvedThreadId,
            persistent,
            persistedForReuse: persistent,
            orchestratorContextReinjected: true,
            nativeSubagentsRequested,
          });
          await emit("agent.process.started", `Codex app-server thread started (${resolvedThreadId.slice(0, 8)}).`, { pid: "" });
        }
        threadId = resolvedThreadId;
        await mutateDatabase((db) => {
          const run = db.agentRuns.find((candidate) => candidate.id === input.agentRun.id);
          if (run !== undefined) {
            run.codexThreadId = threadId;
            run.codexTransport = "app-server";
          }
          const ws = db.workSessions.find((candidate) => candidate.id === input.workSession.id);
          if (ws !== undefined) {
            ws.codexThreadId = persistent ? threadId : ws.codexThreadId;
            updateWorkSessionTimestamp(ws);
          }
        });
        void recordRuntimeUsage({
          workSessionId: input.workSession.id,
          agentRunId: input.agentRun.id,
          taskId: input.task.id,
          provider: "codex-cli",
          model: runtime.model,
          promptTokens: null,
          outputTokens: null,
          contextWindow: null,
          threadId,
          emit: false,
        });

        const turnParams: Record<string, unknown> = {
          threadId,
          runtimeWorkspaceRoots: codexRuntimeWorkspaceRoots(input.workSession),
          input: await codexAppServerInputItems(prompt, input.workSession),
        };
        if (runtime.reasoningEffort !== null) turnParams.effort = runtime.reasoningEffort;
        if (effectiveServiceTier !== undefined) turnParams.serviceTier = effectiveServiceTier;
        workspaceMutationPossible = true;
        const turnResult = await request("turn/start", turnParams);
        turnStarted = true;
        const turn = asRecord(turnResult.turn);
        turnId = typeof turn?.id === "string" ? turn.id : null;
        liveStatus = "running";
        await mutateDatabase((db) => {
          const run = db.agentRuns.find((candidate) => candidate.id === input.agentRun.id);
          if (run !== undefined) {
            run.codexThreadId = threadId;
            run.codexTurnId = turnId;
            run.codexTransport = "app-server";
          }
          const ws = db.workSessions.find((candidate) => candidate.id === input.workSession.id);
          if (ws !== undefined) {
            ws.codexLastTurnId = turnId;
            updateWorkSessionTimestamp(ws);
          }
        });
      } catch (error) {
        finish({ status: "failed", summary: "", errorMessage: error instanceof Error ? error.message : "Codex app-server handshake failed." });
      }
    })();
  }).finally(() => {
    unregisterProcess(input.agentRun.id);
  });

  let outcome = await runAttempt(true);

  const nativeSubagentsWanted = requestsNativeCodexSubagents({ workSession: input.workSession, task: input.task });
  if (
    outcome.status === "failed"
    && nativeSubagentsWanted
    && isToolDeclarationRejection(outcome.errorMessage)
    && agentMessages.length === 0
    && collabCalls.size === 0
  ) {
    const rejectionMessage = outcome.errorMessage ?? "tool declaration rejected";
    transcript.push(`### orchestrator: the provider rejected the native subagent tooling for this model (${rejectionMessage}). Retrying once without native subagents.`);
    await emit(
      "task.progress",
      `Codex rejected the native subagent tooling for this model; retrying the turn once without native subagents. Provider error: ${rejectionMessage.slice(0, 300)}`,
      { nativeSubagentsDisabled: true },
      "high",
    );
    logProcess("warn", "codex.appserver.native_subagents.rejected", {
      workSessionId: input.workSession.id,
      taskId: input.task.id,
      agentRunId: input.agentRun.id,
      errorMessage: rejectionMessage.slice(0, 500),
    });
    if (willResume) {
      willResume = false;
      prompt = (await buildCodexTaskPrompt({ workSession: input.workSession, task: input.task, includeOrchestratorContext: true })).prompt;
    }
    threadId = null;
    turnId = null;
    abortReason = null;
    liveStatus = "starting";
    threadStarted = false;
    turnStarted = false;
    workspaceMutationPossible = false;
    outcome = await runAttempt(false);
  }

  if (outcome.status === "failed" && !workspaceMutationPossible) {
    const state = threadStarted ? "thread-started" : "no-thread";
    throw new CodexAppServerStartupError(`${outcome.errorMessage ?? "app-server did not start a turn"} (${state})`);
  }

  const afterSnapshot = await snapshotWorkspace(workspacePath);
  const codeChanges = await compareWorkspaceSnapshots({ workspacePath, before: beforeSnapshot, after: afterSnapshot });
  const finalCollabCalls = Array.from(collabCalls.values());
  const acceptedInterruptedCollab = outcome.status === "interrupted" && abortReason === null
    ? interruptedCollabRecovery({ calls: finalCollabCalls, rootThreadId: threadId, codeChangeCount: codeChanges.length })
    : null;
  const acceptedLateAppServerError = outcome.status === "failed"
    && abortReason === null
    && isGenericCodexAppServerError(outcome.errorMessage)
    && codeChanges.length > 0
    && latestAgentMessage(agentMessages).length > 0;
  const effectiveStatus = acceptedLateAppServerError ? "completed" : outcome.status;

  await recordRuntimeUsage({
    workSessionId: input.workSession.id,
    agentRunId: input.agentRun.id,
    taskId: input.task.id,
    provider: "codex-cli",
    model: runtime.model,
    promptTokens: lastUsage.prompt,
    outputTokens: lastUsage.output,
    contextWindow: lastUsage.window,
    threadId,
  });

  await emit(
    "agent.process.exited",
    acceptedInterruptedCollab !== null
      ? "Codex app-server run ended (interrupted; accepted completed native subagent output)."
      : acceptedLateAppServerError
        ? "Codex app-server run ended (accepted captured work after late generic app-server error)."
        : `Codex app-server run ended (${outcome.status}).`,
    { exitCode: effectiveStatus === "completed" ? "0" : "", timedOut: outcome.status === "timeout" },
    effectiveStatus === "completed" || acceptedInterruptedCollab !== null ? "normal" : "high",
  );

  const report = `# Codex app-server execution report

## Outcome
${effectiveStatus}${acceptedLateAppServerError ? `\nRecovered from late generic app-server error: ${outcome.errorMessage ?? "unknown error"}` : outcome.errorMessage !== null ? `\nError: ${outcome.errorMessage}` : ""}

## Changed files
${codeChanges.length > 0 ? codeChanges.map((change) => `- ${change.changeKind}: ${change.filePath}`).join("\n") : "- (none)"}

## Transcript
${transcript.join("\n")}

## Native collaboration
${formatCollabReport(finalCollabCalls)}

## Agent messages
${agentMessages.join("\n\n---\n\n")}

## Prompt
${prompt}
`;
  const logArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `codex-app-server-task-${input.task.ordinal}.md`,
    content: report,
    metadata: {
      taskId: input.task.id,
      agentRunId: input.agentRun.id,
      provider: "codex-cli",
      transport: "app-server",
      outcome: effectiveStatus,
      originalOutcome: outcome.status,
      threadId: threadId ?? "",
      abortReason: abortReason ?? "",
      transportMode: transportDecision.mode,
      transportReason: transportDecision.reason,
      turnStarted,
      workspaceMutationPossible,
      acceptedInterruptedCollab: acceptedInterruptedCollab !== null,
      acceptedLateAppServerError,
      staleCollabCallCount: acceptedInterruptedCollab?.staleCallCount ?? finalCollabCalls.filter((call) => call.status === "stale").length,
      acceptedStaleCollabCallCount: acceptedInterruptedCollab?.acceptedStaleCallCount ?? 0,
    },
  });

  if (outcome.status === "interrupted") {
    const bySteering = abortReason === "steering";
    const byExplicitAbort = abortReason !== null && !bySteering;
    if (acceptedInterruptedCollab !== null) {
      const summary = boundedText(
        `Codex app-server parent turn was interrupted after completed native subagent work. ${codeChanges.length} changed file(s) captured; ${acceptedInterruptedCollab.acceptedStaleCallCount} stale cleanup/retry collab call(s) were accepted. Transcript artifact: ${logArtifact.id}.\n\n${acceptedInterruptedCollab.latestReport}`,
      );
      return {
        type: "completed",
        summary,
        codeChanges,
        logArtifactId: logArtifact.id,
        transcript: [{
          provider: "codex",
          model: runtime.model ?? input.agentRun.model,
          role: input.agentRun.role,
          finalText: summary,
          reasoning: reasoningMessages.length > 0 ? boundedText(reasoningMessages.join("\n\n"), 4000) : undefined,
          ts: new Date().toISOString(),
        }],
      };
    }
    if (!bySteering && !byExplicitAbort) {
      return {
        type: "failed",
        summary: boundedText(
          `Codex app-server turn was interrupted before normal completion. ${codeChanges.length} changed file(s) captured. Transcript artifact: ${logArtifact.id}.`,
        ),
        codeChanges,
        failureKind: "runtime_failure",
        logArtifactId: logArtifact.id,
        continuationRecommended: codeChanges.length > 0,
      };
    }
    return {
      type: "failed",
      summary: bySteering
        ? `Codex app-server run was interrupted to apply new user steering. Transcript artifact: ${logArtifact.id}.`
        : `Codex app-server run was aborted by the user. Transcript artifact: ${logArtifact.id}.`,
      codeChanges,
      failureKind: bySteering ? "interrupted_by_user_steering" : "aborted",
      logArtifactId: logArtifact.id,
    };
  }
  if (outcome.status === "timeout") {
    return {
      type: "failed",
      summary: boundedText(`Codex app-server timed out after ${runtime.timeoutMs}ms. ${codeChanges.length} changed file(s) captured. Transcript artifact: ${logArtifact.id}.`),
      codeChanges,
      failureKind: "timeout",
      timedOut: true,
      logArtifactId: logArtifact.id,
      continuationRecommended: codeChanges.length > 0,
    };
  }
  if (acceptedLateAppServerError) {
    const finalMessage = latestAgentMessage(agentMessages);
    const summary = boundedText(
      `${finalMessage}\n\nNote: Codex app-server emitted a late generic error after producing this final response; ${codeChanges.length} changed file(s) were captured and accepted. Transcript artifact: ${logArtifact.id}.`,
    );
    return {
      type: "completed",
      summary,
      codeChanges,
      logArtifactId: logArtifact.id,
      transcript: [{
        provider: "codex",
        model: runtime.model ?? input.agentRun.model,
        role: input.agentRun.role,
        finalText: summary,
        reasoning: reasoningMessages.length > 0 ? boundedText(reasoningMessages.join("\n\n"), 4000) : undefined,
        ts: new Date().toISOString(),
      }],
    };
  }
  if (outcome.status === "failed") {
    const failureText = outcome.errorMessage ?? "";
    const contextExhausted = /ran out of room|context window/i.test(failureText);
    const failedAfterCompaction = transcript.some((line) => line.includes("context compaction"));
    let threadReset = false;
    if (persistent && (contextExhausted || failedAfterCompaction)) {
      threadReset = true;
      await mutateDatabase((db) => {
        const ws = db.workSessions.find((candidate) => candidate.id === input.workSession.id);
        if (ws !== undefined) {
          ws.codexThreadId = null;
          ws.codexLastTurnId = null;
          updateWorkSessionTimestamp(ws);
        }
      });
      logProcess("warn", "codex.appserver.thread_reset_after_failure", {
        workSessionId: input.workSession.id,
        taskId: input.task.id,
        contextExhausted,
        failedAfterCompaction,
      });
    }
    return {
      type: "failed",
      summary: boundedText(`Codex app-server failed: ${outcome.errorMessage ?? "unknown error"}.${threadReset ? " The persistent Codex thread was at context capacity and has been reset; the next attempt starts a fresh thread." : ""} Transcript artifact: ${logArtifact.id}.${tailExcerpt(transcript.join("\n")).length > 0 ? ` Last output:\n${tailExcerpt(transcript.join("\n"))}` : ""}`),
      codeChanges,
      failureKind: "runtime_failure",
      logArtifactId: logArtifact.id,
    };
  }

  const summary = boundedText(outcome.summary.trim().length > 0 ? outcome.summary : "Codex app-server completed the task.");
  return {
    type: "completed",
    summary,
    codeChanges,
    logArtifactId: logArtifact.id,
    transcript: [{
      provider: "codex",
      model: runtime.model ?? input.agentRun.model,
      role: input.agentRun.role,
      finalText: summary,
      reasoning: reasoningMessages.length > 0 ? boundedText(reasoningMessages.join("\n\n"), 4000) : undefined,
      ts: new Date().toISOString(),
    }],
  };
}
