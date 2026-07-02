import { NextRequest, NextResponse } from "next/server";
import { getDatabaseSnapshot, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { activeProcessesForWorkSession } from "@/lib/server/runtime/process-registry";
import { withCodexAppServerControl } from "@/lib/server/runtime/codex-app-server-control";
import { ensureLiveCodexThread, isCodexThreadUnavailableError } from "@/lib/server/runtime/codex-native-thread";
import { resolveCodexTransport } from "@/lib/server/runtime/codex-transport";
import {
  buildCodexSubagentTree,
  extractCollabCallsFromThread,
  markCodexCollabCallStale,
  mergeSubagentRecords,
  normalizeCodexCollabStatus,
  normalizeCodexCollabTool,
  normalizeCodexAgentStatus,
  subagentRecordFromThread,
  subagentRecordsFromCollabCall,
} from "@/lib/server/runtime/codex-collab";
import type { CodexCollabAgentState, CodexCollabCallRecord, CodexCollabCallStatus, CodexSubagentRecord, EventRecord, JsonObject, WorkSessionRecord } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const staleNativeThreadMessage = "Native Codex thread history is no longer available in Codex. The stale thread id was cleared; start a new Codex run or Native Review to create a fresh thread.";

function numberFromBody(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return [];
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function agentStates(value: unknown): Record<string, CodexCollabAgentState> {
  const record = asRecord(value);
  if (record === null) return {};
  const result: Record<string, CodexCollabAgentState> = {};
  for (const [threadId, rawState] of Object.entries(record)) {
    const state = asRecord(rawState);
    if (state === null) continue;
    result[threadId] = {
      status: normalizeCodexAgentStatus(state.status),
      message: stringOrNull(state.message),
    };
  }
  return result;
}

function eventCollabCall(event: EventRecord, workSessionId: string, rootThreadId: string): CodexCollabCallRecord | null {
  if (event.eventName !== "codex.collab.started" && event.eventName !== "codex.collab.completed" && event.eventName !== "codex.subagent.spawned") {
    return null;
  }
  const callId = stringOrNull(event.payload.callId);
  if (callId === null) return null;
  const status = event.eventName === "codex.collab.started"
    ? "inProgress"
    : event.eventName === "codex.subagent.spawned"
      ? "completed"
      : normalizeCodexCollabStatus(event.payload.status);
  const tool = event.eventName === "codex.subagent.spawned" ? "spawnAgent" : normalizeCodexCollabTool(event.payload.tool);
  const receivers = stringArray(event.payload.receiverThreadIdList).length > 0
    ? stringArray(event.payload.receiverThreadIdList)
    : stringArray(event.payload.receiverThreadIds);
  return {
    id: callId,
    workSessionId,
    agentRunId: event.context.agentRunId ?? null,
    rootThreadId: stringOrNull(event.payload.rootThreadId) ?? rootThreadId,
    turnId: stringOrNull(event.payload.turnId),
    tool,
    status,
    senderThreadId: stringOrNull(event.payload.senderThreadId),
    receiverThreadIds: receivers,
    prompt: stringOrNull(event.payload.prompt),
    model: stringOrNull(event.payload.model),
    reasoningEffort: stringOrNull(event.payload.reasoningEffort),
    agentsStates: agentStates(event.payload.agentsStates),
    failureReason: stringOrNull(event.payload.failureReason) ?? (status === "failed" && tool === "spawnAgent" && receivers.length === 0
      ? "Codex did not return a child thread. Common causes are the native subagent concurrency limit, an invalid requested model or reasoning effort, or spawn validation failure."
      : null),
    startedAt: event.eventName === "codex.collab.started" ? event.createdAt : null,
    completedAt: event.eventName === "codex.collab.completed" || event.eventName === "codex.subagent.spawned" ? event.createdAt : null,
    raw: jsonObject(event.payload),
  };
}

function mergeStatus(previous: CodexCollabCallStatus, incoming: CodexCollabCallStatus): CodexCollabCallStatus {
  if (incoming === "unknown") return previous;
  if ((previous === "completed" || previous === "failed" || previous === "stale") && incoming === "inProgress") return previous;
  if (previous === "stale" && (incoming === "completed" || incoming === "failed")) return incoming;
  return incoming;
}

function mergeCollabCalls(records: CodexCollabCallRecord[]): CodexCollabCallRecord[] {
  const merged = new Map<string, CodexCollabCallRecord>();
  for (const record of records) {
    const previous = merged.get(record.id);
    if (previous === undefined) {
      merged.set(record.id, record);
      continue;
    }
    const receiverThreadIds = [...new Set([...previous.receiverThreadIds, ...record.receiverThreadIds])];
    const status = mergeStatus(previous.status, record.status);
    merged.set(record.id, {
      ...previous,
      ...record,
      status,
      senderThreadId: record.senderThreadId ?? previous.senderThreadId,
      receiverThreadIds,
      prompt: record.prompt ?? previous.prompt,
      model: record.model ?? previous.model,
      reasoningEffort: record.reasoningEffort ?? previous.reasoningEffort,
      agentsStates: { ...previous.agentsStates, ...record.agentsStates },
      failureReason: status === "completed" && record.failureReason === null ? null : record.failureReason ?? previous.failureReason,
      startedAt: previous.startedAt ?? record.startedAt,
      completedAt: record.completedAt ?? previous.completedAt,
      raw: { ...previous.raw, ...record.raw },
    });
  }
  return [...merged.values()].sort((a, b) => (a.startedAt ?? a.completedAt ?? "").localeCompare(b.startedAt ?? b.completedAt ?? "") || a.id.localeCompare(b.id));
}

function terminalAgentRunTimes(events: EventRecord[]): Map<string, string> {
  const terminal = new Map<string, string>();
  for (const event of events) {
    if (event.eventName !== "agent.process.exited" && event.eventName !== "agent.completed") continue;
    const agentRunId = event.aggregateType === "agent_run" ? event.aggregateId : event.context.agentRunId;
    if (typeof agentRunId === "string" && agentRunId.length > 0) {
      terminal.set(agentRunId, event.createdAt);
    }
  }
  return terminal;
}

function completedAgentRunIds(events: EventRecord[]): Set<string> {
  const completed = new Set<string>();
  for (const event of events) {
    if (event.eventName !== "agent.completed") continue;
    const agentRunId = event.aggregateType === "agent_run" ? event.aggregateId : event.context.agentRunId;
    if (typeof agentRunId === "string" && agentRunId.length > 0) {
      completed.add(agentRunId);
    }
  }
  return completed;
}

function markTerminalRunCallsStale(calls: CodexCollabCallRecord[], events: EventRecord[]): CodexCollabCallRecord[] {
  const terminalTimes = terminalAgentRunTimes(events);
  if (terminalTimes.size === 0) return calls;
  const completedRuns = completedAgentRunIds(events);
  return calls.map((call) => {
    if (call.status !== "inProgress" || call.agentRunId === null) return call;
    if (call.rootThreadId !== null && call.senderThreadId !== null && call.senderThreadId !== call.rootThreadId) return call;
    const completedAt = terminalTimes.get(call.agentRunId);
    if (completedAt === undefined) return call;
    if (completedRuns.has(call.agentRunId)) {
      return markCodexCollabCallStale(call, completedAt, "The parent Codex app-server turn completed before this optional collab tool reported completion.");
    }
    return markCodexCollabCallStale(call, completedAt, "The parent Codex app-server run ended before this collab tool reported completion.");
  });
}

function isLegacyNestedParentEndedStale(call: CodexCollabCallRecord): boolean {
  if (call.status !== "stale") return false;
  if (call.rootThreadId === null || call.senderThreadId === null || call.senderThreadId === call.rootThreadId) return false;
  const reason = call.failureReason ?? "";
  return reason.includes("parent Codex app-server") && reason.includes("before this collab tool reported completion");
}

function isNonActionableParentEndedStale(call: CodexCollabCallRecord, completedRuns: Set<string>): boolean {
  if (call.status !== "stale") return false;
  const reason = call.failureReason ?? "";
  if (reason.includes("parent Codex app-server turn completed before this optional collab tool reported completion")) return true;
  if (!reason.includes("parent Codex app-server") || !reason.includes("before this collab tool reported completion")) return false;
  if (call.agentRunId !== null && completedRuns.has(call.agentRunId)) return true;
  return call.tool === "wait" || call.tool === "closeAgent" || isLegacyNestedParentEndedStale(call);
}

function visibleCollabCalls(calls: CodexCollabCallRecord[], events: EventRecord[]): CodexCollabCallRecord[] {
  const completedRuns = completedAgentRunIds(events);
  return calls.filter((call) => !isNonActionableParentEndedStale(call, completedRuns));
}

async function sessionSeed(workSessionId: string): Promise<{ workSessionId: string; cwd: string; threadId: string; workSession: WorkSessionRecord; events: EventRecord[] }> {
  const snapshot = await getDatabaseSnapshot();
  const workSession = snapshot.workSessions.find((candidate) => candidate.id === workSessionId);
  if (workSession === undefined) {
    throw new Error("Work session was not found.");
  }
  if (workSession.codexThreadId === null) {
    throw new Error("This work session has no native Codex thread yet.");
  }
  const events = snapshot.eventLog.filter((event) => event.workSessionId === workSessionId);
  return { workSessionId: workSession.id, cwd: workSession.activeWorktreePath, threadId: workSession.codexThreadId, workSession, events };
}

async function clearNativeCodexThread(workSessionId: string): Promise<void> {
  await mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === workSessionId);
    if (workSession !== undefined) {
      workSession.codexThreadId = null;
      workSession.codexLastTurnId = null;
      workSession.codexSubagents = [];
      workSession.codexCollabCalls = [];
      updateWorkSessionTimestamp(workSession);
    }
  });
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const seed = await sessionSeed(params.id);
    const decision = resolveCodexTransport({ intent: "thread-control", workSession: seed.workSession });
    if (decision.primary === "exec") {
      return NextResponse.json({ ok: false, error: decision.reason }, { status: 409 });
    }
    const cachedCollabCalls = seed.workSession.codexCollabCalls ?? [];
    const eventCollabCalls = seed.events
      .map((event) => eventCollabCall(event, seed.workSessionId, seed.threadId))
      .filter((call): call is CodexCollabCallRecord => call !== null);
    const cachedSubagents = seed.workSession.codexSubagents ?? [];
    const result = await withCodexAppServerControl(seed.cwd, async (client) => {
      let effectiveThreadId = seed.threadId;
      let read: Record<string, unknown>;
      try {
        read = await client.request("thread/read", { threadId: effectiveThreadId, includeTurns: true });
      } catch (readError) {
        if (!isCodexThreadUnavailableError(readError)) throw readError;
        const liveThread = await ensureLiveCodexThread(client, seed.workSession, {
          startIfMissing: false,
          operation: "Native Codex thread history read",
        });
        effectiveThreadId = liveThread.threadId;
        read = await client.request("thread/read", { threadId: effectiveThreadId, includeTurns: true });
      }
      const rootThread = typeof read.thread === "object" && read.thread !== null && !Array.isArray(read.thread) ? read.thread as Record<string, unknown> : null;
      let collabCalls = markTerminalRunCallsStale(mergeCollabCalls([
        ...cachedCollabCalls,
        ...eventCollabCalls,
        ...extractCollabCallsFromThread({
          thread: rootThread,
          turns: read.turns,
          workSessionId: seed.workSessionId,
          rootThreadId: effectiveThreadId,
        }),
      ]), seed.events);
      let subagents: CodexSubagentRecord[] = [...cachedSubagents];
      for (const call of collabCalls) {
        subagents = subagentRecordsFromCollabCall(call, subagents);
      }
      const childIds = new Set<string>();
      for (const call of collabCalls) {
        for (const threadId of call.receiverThreadIds) childIds.add(threadId);
      }
      const discoveredThreads: Record<string, unknown>[] = [];
      try {
        const listed = await client.request("thread/list", {});
        const rawThreads = Array.isArray(listed.threads) ? listed.threads : Array.isArray(listed.items) ? listed.items : [];
        for (const rawThread of rawThreads) {
          if (typeof rawThread !== "object" || rawThread === null || Array.isArray(rawThread)) continue;
          const candidate = rawThread as Record<string, unknown>;
          const candidateRecord = subagentRecordFromThread(candidate, effectiveThreadId);
          if (candidateRecord !== null && (candidateRecord.parentThreadId === effectiveThreadId || (candidateRecord.parentThreadId !== null && childIds.has(candidateRecord.parentThreadId)))) {
            discoveredThreads.push(candidate);
            childIds.add(candidateRecord.threadId);
          }
        }
      } catch {
      }
      for (const thread of discoveredThreads) {
        const record = subagentRecordFromThread(thread, effectiveThreadId);
        if (record !== null) subagents.push(record);
      }
      const childReads: Record<string, unknown>[] = [];
      for (const childId of childIds) {
        try {
          const childRead = await client.request("thread/read", { threadId: childId, includeTurns: true });
          const childThread = typeof childRead.thread === "object" && childRead.thread !== null && !Array.isArray(childRead.thread) ? childRead.thread as Record<string, unknown> : null;
          if (childThread !== null) {
            childReads.push(childThread);
            const record = subagentRecordFromThread(childThread, effectiveThreadId);
            if (record !== null) subagents.push(record);
          }
          collabCalls = collabCalls.concat(extractCollabCallsFromThread({
            thread: childThread,
            turns: childRead.turns,
            workSessionId: seed.workSessionId,
            rootThreadId: effectiveThreadId,
          }));
        } catch {
        }
      }
      const mergedCalls = visibleCollabCalls(markTerminalRunCallsStale(mergeCollabCalls(collabCalls), seed.events), seed.events);
      for (const call of mergedCalls) {
        subagents = subagentRecordsFromCollabCall(call, subagents);
      }
      const mergedSubagents = mergeSubagentRecords(subagents);
      return {
        threadId: effectiveThreadId,
        thread: read.thread ?? null,
        turns: read.turns ?? null,
        subagents: mergedSubagents,
        collabCalls: mergedCalls,
        childThreads: childReads,
        tree: buildCodexSubagentTree(effectiveThreadId, mergedSubagents),
      };
    });
    await mutateDatabase((db) => {
      const workSession = db.workSessions.find((candidate) => candidate.id === params.id);
      if (workSession !== undefined) {
        workSession.codexThreadId = result.threadId;
        workSession.codexSubagents = result.subagents;
        workSession.codexCollabCalls = result.collabCalls;
        updateWorkSessionTimestamp(workSession);
      }
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Codex thread error.";
    if (isCodexThreadUnavailableError(error)) {
      const params = await context.params;
      await clearNativeCodexThread(params.id);
      return NextResponse.json({ ok: false, error: staleNativeThreadMessage }, { status: 409 });
    }
    const status = message.includes("not found") ? 404 : message.includes("no native Codex thread") ? 409 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = (await request.json().catch(() => null)) as unknown;
    const action = typeof body === "object" && body !== null ? (body as Record<string, unknown>).action : null;
    if (action !== "rollback") {
      return NextResponse.json({ ok: false, error: "Unsupported Codex thread action." }, { status: 400 });
    }
    const active = activeProcessesForWorkSession(params.id);
    if (active.length > 0) {
      return NextResponse.json({ ok: false, error: "Stop the running work before rolling back native Codex history." }, { status: 409 });
    }
    const numTurns = numberFromBody(body, "numTurns");
    if (numTurns === null) {
      return NextResponse.json({ ok: false, error: "numTurns must be a positive integer." }, { status: 400 });
    }
    const seed = await sessionSeed(params.id);
    const decision = resolveCodexTransport({ intent: "thread-control", workSession: seed.workSession });
    if (decision.primary === "exec") {
      return NextResponse.json({ ok: false, error: decision.reason }, { status: 409 });
    }
    const result = await withCodexAppServerControl(seed.cwd, async (client) => {
      const liveThread = await ensureLiveCodexThread(client, seed.workSession, {
        startIfMissing: false,
        operation: "Native Codex thread rollback",
      });
      const rollback = await client.request("thread/rollback", { threadId: liveThread.threadId, numTurns });
      return { threadId: liveThread.threadId, numTurns, rollback };
    });
    await mutateDatabase((db) => {
      const workSession = db.workSessions.find((candidate) => candidate.id === params.id);
      if (workSession !== undefined) {
        workSession.codexLastTurnId = null;
        workSession.codexSubagents = [];
        workSession.codexCollabCalls = [];
        updateWorkSessionTimestamp(workSession);
      }
    });
    await emitEvent({
      workSessionId: params.id,
      eventName: "task.progress",
      aggregateType: "work_session",
      aggregateId: params.id,
      priority: "high",
      payload: {
        message: `Rolled back ${numTurns} native Codex thread turn(s). Files were not changed.`,
        threadId: seed.threadId,
        numTurns: String(numTurns),
      },
    });
    await emitEvent({
      workSessionId: params.id,
      eventName: "codex.thread.rollback",
      aggregateType: "work_session",
      aggregateId: params.id,
      priority: "normal",
      payload: {
        message: `Rolled back native Codex thread by ${numTurns} turn(s).`,
        threadId: seed.threadId,
        numTurns: String(numTurns),
      },
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Codex thread action error.";
    if (isCodexThreadUnavailableError(error)) {
      const params = await context.params;
      await clearNativeCodexThread(params.id);
      return NextResponse.json({ ok: false, error: staleNativeThreadMessage }, { status: 409 });
    }
    const status = message.includes("not found") ? 404 : message.includes("no native Codex thread") ? 409 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
