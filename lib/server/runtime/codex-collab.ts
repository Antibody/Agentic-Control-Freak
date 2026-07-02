import type {
  CodexCollabAgentState,
  CodexCollabCallRecord,
  CodexCollabCallStatus,
  CodexCollabTool,
  CodexNativeThreadTreeNode,
  CodexSubagentRecord,
  CodexSubagentStatus,
  JsonObject,
} from "@/lib/shared/types";
import { asRecord } from "@/lib/server/runtime/codex-app-server-protocol";

function nowIso(): string {
  return new Date().toISOString();
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  if (typeof value === "string") {
    return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  }
  return [];
}

export function normalizeCodexCollabTool(value: unknown): CodexCollabTool {
  switch (value) {
    case "spawnAgent":
    case "spawn_agent":
      return "spawnAgent";
    case "sendInput":
    case "send_input":
    case "sendMessage":
    case "send_message":
      return "sendInput";
    case "resumeAgent":
    case "resume_agent":
      return "resumeAgent";
    case "wait":
    case "waitAgent":
    case "wait_agent":
      return "wait";
    case "closeAgent":
    case "close_agent":
    case "interruptAgent":
    case "interrupt_agent":
      return "closeAgent";
    default:
      return "unknown";
  }
}

export function normalizeCodexCollabStatus(value: unknown): CodexCollabCallStatus {
  switch (value) {
    case "inProgress":
    case "in_progress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stale":
      return "stale";
    default:
      return "unknown";
  }
}

export function normalizeCodexAgentStatus(value: unknown): CodexSubagentStatus {
  switch (value) {
    case "pendingInit":
    case "pending_init":
      return "pendingInit";
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    case "errored":
      return "errored";
    case "shutdown":
      return "shutdown";
    case "notFound":
    case "not_found":
      return "notFound";
    default:
      return "unknown";
  }
}

function normalizeAgentStates(value: unknown): Record<string, CodexCollabAgentState> {
  const record = asRecord(value);
  if (record === null) return {};
  const states: Record<string, CodexCollabAgentState> = {};
  for (const [threadId, raw] of Object.entries(record)) {
    const state = asRecord(raw);
    if (state === null) continue;
    states[threadId] = {
      status: normalizeCodexAgentStatus(state.status),
      message: stringOrNull(state.message),
    };
  }
  return states;
}

function errorMessageFromItem(item: Record<string, unknown>): string | null {
  const direct = stringOrNull(item.error) ?? stringOrNull(item.errorMessage) ?? stringOrNull(item.failureReason);
  if (direct !== null) return direct;
  const error = asRecord(item.error);
  return stringOrNull(error?.message) ?? stringOrNull(error?.error) ?? null;
}

function failedSpawnReason(call: Pick<CodexCollabCallRecord, "tool" | "status" | "receiverThreadIds" | "failureReason">): string | null {
  const reason = failureReasonText(call);
  if (reason !== null) return reason;
  if (call.status !== "failed") return null;
  if (call.tool === "spawnAgent" && call.receiverThreadIds.length === 0) {
    return "Codex did not return a child thread. Common causes are the native subagent concurrency limit, an invalid requested model or reasoning effort, or spawn validation failure.";
  }
  return null;
}

function failureReasonFromItem(input: {
  item: Record<string, unknown>;
  tool: CodexCollabTool;
  status: CodexCollabCallStatus;
  receiverThreadIds: string[];
  agentsStates: Record<string, CodexCollabAgentState>;
}): string | null {
  const explicit = errorMessageFromItem(input.item);
  if (explicit !== null) return explicit;
  const stateMessage = Object.values(input.agentsStates)
    .map((state) => state.message)
    .find((message): message is string => message !== null && message.trim().length > 0);
  if (input.status === "failed") {
    return failedSpawnReason({
      tool: input.tool,
      status: input.status,
      receiverThreadIds: input.receiverThreadIds,
      failureReason: stateMessage ?? null,
    });
  }
  return null;
}

function failureReasonText(call: Pick<CodexCollabCallRecord, "failureReason">): string | null {
  return typeof call.failureReason === "string" && call.failureReason.trim().length > 0 ? call.failureReason.trim() : null;
}

export function parseCodexCollabToolCall(input: {
  item: Record<string, unknown>;
  workSessionId: string;
  agentRunId?: string | null;
  rootThreadId?: string | null;
  turnId?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}): CodexCollabCallRecord | null {
  if (input.item.type !== "collabAgentToolCall") return null;
  const id = stringOrNull(input.item.id);
  if (id === null) return null;
  const tool = normalizeCodexCollabTool(input.item.tool);
  const status = normalizeCodexCollabStatus(input.item.status);
  const receiverThreadIds = stringArray(input.item.receiverThreadIds);
  const agentsStates = normalizeAgentStates(input.item.agentsStates);
  return {
    id,
    workSessionId: input.workSessionId,
    agentRunId: input.agentRunId ?? null,
    rootThreadId: input.rootThreadId ?? null,
    turnId: input.turnId ?? null,
    tool,
    status,
    senderThreadId: stringOrNull(input.item.senderThreadId),
    receiverThreadIds,
    prompt: stringOrNull(input.item.prompt),
    model: stringOrNull(input.item.model),
    reasoningEffort: typeof input.item.reasoningEffort === "string" ? input.item.reasoningEffort : input.item.reasoningEffort === null ? null : stringOrNull(JSON.stringify(input.item.reasoningEffort)),
    agentsStates,
    failureReason: failureReasonFromItem({ item: input.item, tool, status, receiverThreadIds, agentsStates }),
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    raw: jsonObject(input.item),
  };
}

export function markCodexCollabCallStale(call: CodexCollabCallRecord, completedAt: string, reason: string): CodexCollabCallRecord {
  if (call.status !== "inProgress") return call;
  return {
    ...call,
    status: "stale",
    failureReason: call.failureReason ?? reason,
    completedAt: call.completedAt ?? completedAt,
    raw: {
      ...call.raw,
      staleReason: reason,
    },
  };
}

export function collabCallSummary(call: CodexCollabCallRecord, subagents: CodexSubagentRecord[] = []): string {
  const names = new Map(subagents.map((agent) => [agent.threadId, agent.agentNickname ?? agent.agentRole ?? agent.threadId.slice(0, 8)]));
  const targets = call.receiverThreadIds.map((id) => names.get(id) ?? id.slice(0, 8)).join(", ");
  const targetText = targets.length > 0 ? ` ${targets}` : "";
  const failureReason = failureReasonText(call);
  const failureText = failureReason === null ? "" : ` ${failureReason}`;
  const stateMessages = Object.values(call.agentsStates).map((state) => state.message).filter((message): message is string => message !== null && message.trim().length > 0);
  switch (call.tool) {
    case "spawnAgent":
      if (call.status === "completed") return `Spawned Codex subagent${targetText}.`;
      if (call.status === "failed") return `Failed to spawn Codex subagent.${failureText}`;
      if (call.status === "stale") return `Codex subagent spawn did not finish before the turn ended.${failureText}`;
      return `Spawning Codex subagent${targetText}.`;
    case "sendInput":
      if (call.status === "failed") return `Failed to message Codex subagent${targetText}.`;
      if (call.status === "stale") return `Codex subagent message did not finish before the turn ended.`;
      return `Sent message to Codex subagent${targetText}.`;
    case "resumeAgent":
      if (call.status === "failed") return `Failed to resume Codex subagent${targetText}.`;
      if (call.status === "stale") return `Codex subagent resume did not finish before the turn ended.`;
      return `Resumed Codex subagent${targetText}.`;
    case "wait":
      if (call.status === "stale") return "Waiting for Codex subagents did not finish before the turn ended.";
      return call.status === "completed" ? "Finished waiting for Codex subagents." : "Waiting for Codex subagents.";
    case "closeAgent":
      if (call.status === "failed") return `Failed to close Codex subagent${targetText}.`;
      if (call.status === "stale") return `Codex subagent close did not finish before the turn ended.`;
      return `Closed Codex subagent${targetText}.`;
    default:
      return stateMessages[0] ?? "Codex subagent activity updated.";
  }
}

function statusFromCall(call: CodexCollabCallRecord, threadId: string): CodexSubagentStatus {
  return call.agentsStates[threadId]?.status ?? (call.status === "completed" ? "running" : "unknown");
}

function messageFromCall(call: CodexCollabCallRecord, threadId: string): string | null {
  return call.agentsStates[threadId]?.message ?? null;
}

export function subagentRecordsFromCollabCall(call: CodexCollabCallRecord, existing: CodexSubagentRecord[] = []): CodexSubagentRecord[] {
  const current = new Map(existing.map((agent) => [agent.threadId, { ...agent }]));
  const timestamp = call.completedAt ?? call.startedAt ?? nowIso();
  for (const threadId of call.receiverThreadIds) {
    const previous = current.get(threadId);
    const status = statusFromCall(call, threadId);
    const message = messageFromCall(call, threadId);
    current.set(threadId, {
      threadId,
      parentThreadId: previous?.parentThreadId ?? call.senderThreadId,
      rootThreadId: previous?.rootThreadId ?? call.rootThreadId,
      agentNickname: previous?.agentNickname ?? null,
      agentRole: previous?.agentRole ?? null,
      status: status === "unknown" ? previous?.status ?? "unknown" : status,
      lastMessage: message ?? previous?.lastMessage ?? null,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
  }
  return [...current.values()];
}

export function parentThreadIdFromThread(thread: Record<string, unknown>): string | null {
  const direct = stringOrNull(thread.parentThreadId);
  if (direct !== null) return direct;
  const source = asRecord(thread.source);
  const subAgent = asRecord(source?.subAgent);
  const threadSpawn = asRecord(subAgent?.thread_spawn) ?? asRecord(subAgent?.threadSpawn);
  return stringOrNull(threadSpawn?.parent_thread_id) ?? stringOrNull(threadSpawn?.parentThreadId);
}

export function subagentRecordFromThread(thread: Record<string, unknown>, rootThreadId: string | null): CodexSubagentRecord | null {
  const threadId = stringOrNull(thread.id);
  if (threadId === null) return null;
  const parentThreadId = parentThreadIdFromThread(thread);
  if (parentThreadId === null) return null;
  const now = nowIso();
  const statusRecord = asRecord(thread.status);
  return {
    threadId,
    parentThreadId,
    rootThreadId,
    agentNickname: stringOrNull(thread.agentNickname),
    agentRole: stringOrNull(thread.agentRole),
    status: normalizeCodexAgentStatus(statusRecord?.type ?? thread.status),
    lastMessage: null,
    createdAt: typeof thread.createdAt === "number" ? new Date(thread.createdAt * 1000).toISOString() : now,
    updatedAt: typeof thread.updatedAt === "number" ? new Date(thread.updatedAt * 1000).toISOString() : now,
  };
}

export function extractCollabCallsFromThread(input: {
  thread: Record<string, unknown> | null;
  turns: unknown;
  workSessionId: string;
  agentRunId?: string | null;
  rootThreadId?: string | null;
}): CodexCollabCallRecord[] {
  const rootThreadId = input.rootThreadId ?? stringOrNull(input.thread?.id) ?? null;
  const turns = Array.isArray(input.turns) ? input.turns : Array.isArray(input.thread?.turns) ? input.thread.turns : [];
  const calls: CodexCollabCallRecord[] = [];
  for (const rawTurn of turns) {
    const turn = asRecord(rawTurn);
    if (turn === null) continue;
    const turnId = stringOrNull(turn.id);
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const rawItem of items) {
      const item = asRecord(rawItem);
      if (item === null) continue;
      const call = parseCodexCollabToolCall({
        item,
        workSessionId: input.workSessionId,
        agentRunId: input.agentRunId ?? null,
        rootThreadId,
        turnId,
        completedAt: typeof turn.completedAt === "number" ? new Date(turn.completedAt * 1000).toISOString() : null,
      });
      if (call !== null) calls.push(call);
    }
  }
  return calls;
}

export function mergeSubagentRecords(records: CodexSubagentRecord[]): CodexSubagentRecord[] {
  const merged = new Map<string, CodexSubagentRecord>();
  for (const record of records) {
    const previous = merged.get(record.threadId);
    merged.set(record.threadId, {
      ...record,
      parentThreadId: record.parentThreadId ?? previous?.parentThreadId ?? null,
      rootThreadId: record.rootThreadId ?? previous?.rootThreadId ?? null,
      agentNickname: record.agentNickname ?? previous?.agentNickname ?? null,
      agentRole: record.agentRole ?? previous?.agentRole ?? null,
      status: record.status === "unknown" ? previous?.status ?? "unknown" : record.status,
      lastMessage: record.lastMessage ?? previous?.lastMessage ?? null,
      createdAt: previous?.createdAt ?? record.createdAt,
      updatedAt: record.updatedAt > (previous?.updatedAt ?? "") ? record.updatedAt : previous?.updatedAt ?? record.updatedAt,
    });
  }
  return [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.threadId.localeCompare(b.threadId));
}

export function buildCodexSubagentTree(rootThreadId: string, records: CodexSubagentRecord[]): CodexNativeThreadTreeNode {
  const nodes = new Map<string, CodexNativeThreadTreeNode>();
  const root: CodexNativeThreadTreeNode = {
    threadId: rootThreadId,
    parentThreadId: null,
    agentNickname: "Root",
    agentRole: "root",
    status: "running",
    lastMessage: null,
    children: [],
  };
  nodes.set(rootThreadId, root);
  for (const record of records) {
    nodes.set(record.threadId, {
      threadId: record.threadId,
      parentThreadId: record.parentThreadId,
      agentNickname: record.agentNickname,
      agentRole: record.agentRole,
      status: record.status,
      lastMessage: record.lastMessage,
      children: [],
    });
  }
  for (const node of nodes.values()) {
    if (node.threadId === rootThreadId) continue;
    const parent = node.parentThreadId !== null ? nodes.get(node.parentThreadId) : undefined;
    (parent ?? root).children.push(node);
  }
  const sortChildren = (node: CodexNativeThreadTreeNode): void => {
    node.children.sort((a, b) => (a.agentNickname ?? a.agentRole ?? a.threadId).localeCompare(b.agentNickname ?? b.agentRole ?? b.threadId));
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  return root;
}
