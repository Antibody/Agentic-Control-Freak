import { logProcess } from "@/lib/server/logging";
import type { Identifier } from "@/lib/shared/types";

interface ActiveProcess {
  agentRunId: Identifier;
  workSessionId: Identifier;
  startedAt: number;
  abort: (reason?: string) => void;
  requestCompaction?: (reason?: string) => void;
  steer?: (input: LiveSteerInput) => Promise<LiveControlResult>;
  updateSettings?: (settings: Record<string, unknown>) => Promise<LiveControlResult>;
  resolveApproval?: (input: LiveApprovalResolution) => Promise<LiveControlResult>;
  getNativeThreadState?: () => NativeThreadState | null;
}

const active = new Map<Identifier, ActiveProcess>();

export interface LiveControlResult {
  ok: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface LiveSteerInput {
  steeringId: Identifier;
  content: string;
  clientUserMessageId?: Identifier;
}

export interface LiveApprovalResolution {
  approvalId: Identifier;
  status: "approved" | "rejected";
  note?: string;
}

export interface NativeThreadState {
  agentRunId: Identifier;
  workSessionId: Identifier;
  threadId: string | null;
  turnId: string | null;
  status: "starting" | "running" | "waiting_approval" | "completed" | "failed" | "interrupted";
}

export function registerProcess(entry: Omit<ActiveProcess, "startedAt">): void {
  active.set(entry.agentRunId, { ...entry, startedAt: Date.now() });
  logProcess("info", "process_registry.registered", {
    workSessionId: entry.workSessionId,
    agentRunId: entry.agentRunId,
    activeCount: active.size,
  });
}

export function unregisterProcess(agentRunId: Identifier): void {
  const entry = active.get(agentRunId);
  active.delete(agentRunId);
  logProcess("info", "process_registry.unregistered", {
    workSessionId: entry?.workSessionId ?? "",
    agentRunId,
    activeCount: active.size,
  });
}

export interface ActiveProcessSummary {
  agentRunId: Identifier;
  workSessionId: Identifier;
  startedAt: number;
  ageMs: number;
  nativeThreadState?: NativeThreadState | null;
}

export function activeProcessesForWorkSession(workSessionId: Identifier): ActiveProcessSummary[] {
  const now = Date.now();
  return [...active.values()]
    .filter((entry) => entry.workSessionId === workSessionId)
    .map((entry) => ({
      agentRunId: entry.agentRunId,
      workSessionId: entry.workSessionId,
      startedAt: entry.startedAt,
      ageMs: now - entry.startedAt,
      nativeThreadState: entry.getNativeThreadState?.() ?? null,
    }));
}

export function hasActiveProcessForWorkSession(workSessionId: Identifier): boolean {
  return activeProcessesForWorkSession(workSessionId).length > 0;
}

export function requestWorkSessionCompaction(workSessionId: Identifier, reason?: string): number {
  const matches = activeProcessesForWorkSession(workSessionId);
  logProcess("info", "process_registry.compaction.requested", {
    workSessionId,
    reason: reason ?? "",
    matchingCount: matches.length,
    matchingAgentRunIds: matches.map((entry) => entry.agentRunId).join(","),
    activeCount: active.size,
  });
  let requested = 0;
  for (const entry of active.values()) {
    if (entry.workSessionId === workSessionId && entry.requestCompaction !== undefined) {
      try {
        entry.requestCompaction(reason);
        requested += 1;
      } catch {
      }
    }
  }
  logProcess("info", "process_registry.compaction.completed", {
    workSessionId,
    reason: reason ?? "",
    requested,
    activeCount: active.size,
  });
  return requested;
}

async function callFirstLiveHook(
  workSessionId: Identifier,
  hookName: "steer" | "updateSettings" | "resolveApproval",
  call: (entry: ActiveProcess) => Promise<LiveControlResult>,
): Promise<LiveControlResult> {
  for (const entry of active.values()) {
    if (entry.workSessionId !== workSessionId || entry[hookName] === undefined) {
      continue;
    }
    try {
      return await call(entry);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "Live control request failed." };
    }
  }
  return { ok: false, message: "No live agent process supports this control request." };
}

export async function steerWorkSessionProcess(workSessionId: Identifier, input: LiveSteerInput): Promise<LiveControlResult> {
  logProcess("info", "process_registry.steer.requested", {
    workSessionId,
    steeringId: input.steeringId,
    activeCount: active.size,
  });
  const result = await callFirstLiveHook(workSessionId, "steer", (entry) => entry.steer!(input));
  logProcess(result.ok ? "info" : "warn", "process_registry.steer.completed", {
    workSessionId,
    steeringId: input.steeringId,
    ok: result.ok,
    message: result.message,
  });
  return result;
}

export async function updateWorkSessionProcessSettings(workSessionId: Identifier, settings: Record<string, unknown>): Promise<LiveControlResult> {
  logProcess("info", "process_registry.settings_update.requested", {
    workSessionId,
    activeCount: active.size,
  });
  const result = await callFirstLiveHook(workSessionId, "updateSettings", (entry) => entry.updateSettings!(settings));
  logProcess(result.ok ? "info" : "warn", "process_registry.settings_update.completed", {
    workSessionId,
    ok: result.ok,
    message: result.message,
  });
  return result;
}

export async function resolveWorkSessionProcessApproval(workSessionId: Identifier, input: LiveApprovalResolution): Promise<LiveControlResult> {
  logProcess("info", "process_registry.approval_resolution.requested", {
    workSessionId,
    approvalId: input.approvalId,
    status: input.status,
    activeCount: active.size,
  });
  const result = await callFirstLiveHook(workSessionId, "resolveApproval", (entry) => entry.resolveApproval!(input));
  logProcess(result.ok ? "info" : "warn", "process_registry.approval_resolution.completed", {
    workSessionId,
    approvalId: input.approvalId,
    ok: result.ok,
    message: result.message,
  });
  return result;
}

export function abortWorkSessionProcesses(workSessionId: Identifier, reason?: string): number {
  const matches = activeProcessesForWorkSession(workSessionId);
  logProcess("info", "process_registry.abort.requested", {
    workSessionId,
    reason: reason ?? "",
    matchingCount: matches.length,
    matchingAgentRunIds: matches.map((entry) => entry.agentRunId).join(","),
    activeCount: active.size,
  });
  let aborted = 0;
  for (const [agentRunId, entry] of active) {
    if (entry.workSessionId === workSessionId) {
      try {
        entry.abort(reason);
      } catch {
      }
      active.delete(agentRunId);
      aborted += 1;
    }
  }
  logProcess("info", "process_registry.abort.completed", {
    workSessionId,
    reason: reason ?? "",
    aborted,
    activeCount: active.size,
  });
  return aborted;
}
