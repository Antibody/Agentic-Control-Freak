import { getConfig } from "@/lib/server/config";
import { getDatabaseSnapshot, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { updateWorkSessionProcessSettings } from "@/lib/server/runtime/process-registry";
import { runtimeProviderFor, runtimeProviderIds } from "@/lib/server/runtime-providers/registry";
import { isRuntimeOverridesEmpty, normalizeRuntimeOverrides } from "@/lib/shared/runtime-overrides";
import type { AgentProvider, CodexRuntimeOptions, RuntimeOverrides, WorkSessionRecord } from "@/lib/shared/types";

export const selectableProviders: AgentProvider[] = runtimeProviderIds();

export interface RuntimeUpdateResult {
  workSession: WorkSessionRecord;
  provider: AgentProvider;
  runtimeOverrides: RuntimeOverrides | null;
  validationNote: string | null;
}

function mergeRuntimeOverrides(existing: RuntimeOverrides | null, patch: Partial<RuntimeOverrides>): RuntimeOverrides {
  return normalizeRuntimeOverrides({
    ...(existing ?? {}),
    ...patch,
  });
}

export function effectiveProviderForSession(workSession: WorkSessionRecord | null | undefined): AgentProvider {
  return workSession?.agentProvider ?? getConfig().agentProvider;
}

export async function getRuntimeOptionsForProvider(
  provider: AgentProvider,
  input: { forceRefresh?: boolean } = {},
): Promise<CodexRuntimeOptions> {
  return runtimeProviderFor(provider).getOptions(input);
}

export async function setWorkSessionProvider(workSessionId: string, provider: AgentProvider): Promise<WorkSessionRecord> {
  const workSession = await mutateDatabase((db) => {
    const session = db.workSessions.find((candidate) => candidate.id === workSessionId);
    if (session === undefined) {
      throw new Error("Work session was not found.");
    }
    const previousProvider = session.agentProvider ?? getConfig().agentProvider;
    const clearsClaudeRuntime = provider === "claude-code" && (
      previousProvider !== provider ||
      session.runtimeOverrides?.model != null ||
      session.runtimeOverrides?.reasoningEffort != null ||
      session.runtimeOverrides?.serviceTier != null
    );
    session.agentProvider = provider;
    if (session.runtimeOverrides !== null) {
      session.runtimeOverrides.model = null;
      session.runtimeOverrides.reasoningEffort = null;
      session.runtimeOverrides.serviceTier = null;
      if (provider === "ollama") {
        session.runtimeOverrides.sandboxMode = null;
        session.runtimeOverrides.networkAccess = null;
        session.runtimeOverrides.codexTransportMode = null;
      } else if (provider === "claude-code" || provider === "antigravity-cli") {
        session.runtimeOverrides.sandboxMode = null;
        session.runtimeOverrides.networkAccess = null;
        session.runtimeOverrides.codexTransportMode = null;
        session.runtimeOverrides.temperature = null;
        session.runtimeOverrides.numCtx = null;
      } else {
        session.runtimeOverrides.temperature = null;
        session.runtimeOverrides.numCtx = null;
      }
      if (isRuntimeOverridesEmpty(session.runtimeOverrides)) {
        session.runtimeOverrides = null;
      }
    }
    if (clearsClaudeRuntime || (previousProvider === "claude-code" && provider !== "claude-code")) {
      session.claudeSessionId = null;
      if (session.runtimeUsage?.provider === "claude-code") {
        session.runtimeUsage = null;
      }
    }
    updateWorkSessionTimestamp(session);
    return { ...session };
  });

  await emitEvent({
    workSessionId,
    eventName: "task.progress",
    aggregateType: "work_session",
    aggregateId: workSessionId,
    payload: { message: `Coding provider set to ${provider}.` },
  });

  return workSession;
}

export async function setWorkSessionRuntime(workSessionId: string, runtime: unknown): Promise<RuntimeUpdateResult> {
  const normalized = normalizeRuntimeOverrides(runtime);
  const result = await saveValidatedRuntime(workSessionId, normalized);
  await applyLiveCodexSettingsUpdate(result).catch(() => undefined);
  return result;
}

export async function patchWorkSessionRuntime(
  workSessionId: string,
  patch: Partial<RuntimeOverrides>,
): Promise<RuntimeUpdateResult> {
  const snapshot = await getDatabaseSnapshot();
  const existing = snapshot.workSessions.find((session) => session.id === workSessionId);
  if (existing === undefined) {
    throw new Error("Work session was not found.");
  }
  return saveValidatedRuntime(workSessionId, mergeRuntimeOverrides(existing.runtimeOverrides, patch));
}

export async function resetWorkSessionRuntime(workSessionId: string): Promise<RuntimeUpdateResult> {
  return saveValidatedRuntime(workSessionId, normalizeRuntimeOverrides({}));
}

async function saveValidatedRuntime(workSessionId: string, normalized: RuntimeOverrides): Promise<RuntimeUpdateResult> {
  const snapshot = await getDatabaseSnapshot();
  const existing = snapshot.workSessions.find((session) => session.id === workSessionId);
  if (existing === undefined) {
    throw new Error("Work session was not found.");
  }
  const provider = effectiveProviderForSession(existing);
  let validationNote: string | null = null;

  const validated = await runtimeProviderFor(provider).validateOverrides(normalized);
  normalized = validated.runtimeOverrides;
  validationNote = validated.validationNote;

  const value = isRuntimeOverridesEmpty(normalized) ? null : normalized;
  const workSession = await mutateDatabase((db) => {
    const session = db.workSessions.find((candidate) => candidate.id === workSessionId);
    if (session === undefined) {
      throw new Error("Work session was not found.");
    }
    const previousModel = session.runtimeOverrides?.model ?? null;
    const previousEffort = session.runtimeOverrides?.reasoningEffort ?? null;
    const nextModel = value?.model ?? null;
    const nextEffort = value?.reasoningEffort ?? null;
    const claudeRuntimeChanged = provider === "claude-code" && (previousModel !== nextModel || previousEffort !== nextEffort);
    session.runtimeOverrides = value;
    if (claudeRuntimeChanged) {
      session.claudeSessionId = null;
      if (session.runtimeUsage?.provider === "claude-code") {
        session.runtimeUsage = null;
      }
    }
    updateWorkSessionTimestamp(session);
    return { ...session };
  });

  return {
    workSession,
    provider,
    runtimeOverrides: workSession.runtimeOverrides,
    validationNote,
  };
}

function codexThreadSettingsFromOverrides(overrides: RuntimeOverrides | null): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (overrides?.model !== undefined && overrides?.model !== null) {
    settings.model = overrides.model;
  }
  if (overrides?.reasoningEffort !== undefined && overrides?.reasoningEffort !== null) {
    settings.effort = overrides.reasoningEffort;
  }
  if (overrides?.serviceTier !== undefined && overrides?.serviceTier !== null) {
    settings.serviceTier = overrides.serviceTier === "__standard__" ? null : overrides.serviceTier;
  }
  if (overrides?.sandboxMode !== undefined && overrides?.sandboxMode !== null) {
    settings.sandboxPolicy = overrides.sandboxMode;
  }
  return settings;
}

async function applyLiveCodexSettingsUpdate(result: RuntimeUpdateResult): Promise<void> {
  if (result.provider !== "codex-cli") {
    return;
  }
  const settings = codexThreadSettingsFromOverrides(result.runtimeOverrides);
  if (Object.keys(settings).length === 0) {
    return;
  }
  const live = await updateWorkSessionProcessSettings(result.workSession.id, settings);
  await emitEvent({
    workSessionId: result.workSession.id,
    eventName: "task.progress",
    aggregateType: "work_session",
    aggregateId: result.workSession.id,
    payload: {
      message: live.ok
        ? "Applied runtime settings to the live Codex thread."
        : "Saved runtime settings; no live Codex thread accepted a settings update, so they will apply on the next run.",
      liveSettingsApplied: String(live.ok),
      liveSettingsMessage: live.message,
    },
    priority: live.ok ? "normal" : "low",
  });
}
