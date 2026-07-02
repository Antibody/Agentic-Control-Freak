import { getConfig, type AppConfig } from "@/lib/server/config";
import { validateCodexModelReasoning } from "@/lib/server/runtime/codex-model-catalog";
import type { CodexAppServerControlClient, CodexAppServerNotification } from "@/lib/server/runtime/codex-app-server-control";
import { standardServiceTier } from "@/lib/shared/runtime-overrides";
import type { WorkSessionRecord } from "@/lib/shared/types";

export interface ResolvedNativeCodexRuntime {
  sandboxMode: string;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  networkAccess: boolean | null;
}

export interface LiveCodexThreadResult {
  threadId: string;
  resumed: boolean;
  startedFresh: boolean;
  staleThreadId: string | null;
  runtime: ResolvedNativeCodexRuntime;
}

export interface CodexTurnCompletion {
  notification: CodexAppServerNotification;
  turn: Record<string, unknown>;
  status: string | null;
  errorMessage: string | null;
}

function normalizeCodexReasoningEffort(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0 || trimmed === "minimal") {
    return null;
  }
  return trimmed;
}

async function resolveNativeCodexRuntime(workSession: WorkSessionRecord, config: AppConfig): Promise<ResolvedNativeCodexRuntime> {
  const overrides = workSession.runtimeOverrides;
  const rawEffort = overrides?.reasoningEffort ?? config.codexReasoningEffort;
  const resolved = await validateCodexModelReasoning({
    model: overrides?.model ?? (config.codexModel.trim().length > 0 ? config.codexModel.trim() : null),
    reasoningEffort: normalizeCodexReasoningEffort(rawEffort),
    serviceTier: overrides?.serviceTier ?? null,
  });
  return {
    sandboxMode: overrides?.sandboxMode ?? config.codexSandboxMode,
    model: resolved.model,
    reasoningEffort: resolved.reasoningEffort,
    serviceTier: resolved.serviceTier,
    networkAccess: overrides?.networkAccess ?? null,
  };
}

function serviceTierParam(serviceTier: string | null): string | null | undefined {
  if (serviceTier === null) return undefined;
  if (serviceTier === standardServiceTier) return null;
  return serviceTier;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function threadIdFromResponse(value: Record<string, unknown>, fallback: string | null): string | null {
  const thread = asRecord(value.thread);
  return typeof thread?.id === "string" ? thread.id : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function codexRuntimeWorkspaceRoots(workSession: WorkSessionRecord): string[] {
  return [workSession.activeWorktreePath];
}

export function codexSandboxPolicyForMode(
  sandboxMode: string,
  networkAccess: boolean | null,
): Record<string, unknown> {
  if (sandboxMode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (sandboxMode === "read-only") {
    return { type: "readOnly", networkAccess: networkAccess ?? false };
  }
  return {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: networkAccess ?? false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function isCodexThreadUnavailableError(error: unknown): boolean {
  const normalized = errorMessage(error).toLowerCase();
  return (
    normalized.includes("thread not found:") ||
    normalized.includes("no rollout found for thread id") ||
    normalized.includes("thread not loaded:") ||
    normalized.includes("is not materialized yet")
  );
}

async function baseThreadParams(
  workSession: WorkSessionRecord,
  config: AppConfig,
): Promise<{ params: Record<string, unknown>; runtime: ResolvedNativeCodexRuntime }> {
  const runtime = await resolveNativeCodexRuntime(workSession, config);
  const threadConfig: Record<string, unknown> = {
    web_search: "disabled",
    "features.image_generation": false,
    "features.apps": false,
    "features.browser_use": false,
    "features.plugins": false,
  };
  if (runtime.networkAccess !== null) {
    threadConfig["sandbox_workspace_write.network_access"] = runtime.networkAccess;
  }
  const effectiveServiceTier = serviceTierParam(runtime.serviceTier);
  if (effectiveServiceTier === null) {
    threadConfig.service_tier = null;
  } else if (typeof effectiveServiceTier === "string") {
    threadConfig.service_tier = effectiveServiceTier;
    threadConfig["features.fast_mode"] = true;
  }

  const params: Record<string, unknown> = {
    cwd: workSession.activeWorktreePath,
    runtimeWorkspaceRoots: codexRuntimeWorkspaceRoots(workSession),
    approvalPolicy: config.codexApprovalPolicy,
    sandbox: runtime.sandboxMode,
    config: threadConfig,
  };
  if (runtime.model !== null) params.model = runtime.model;
  if (effectiveServiceTier !== undefined) params.serviceTier = effectiveServiceTier;

  return { params, runtime };
}

export async function updateCodexThreadSettings(
  client: CodexAppServerControlClient,
  threadId: string,
  settings: Record<string, unknown>,
  input: { timeoutMs?: number; description?: string; waitForApplied?: boolean } = {},
): Promise<void> {
  await client.request("thread/settings/update", { threadId, ...settings });
  if (input.waitForApplied === false) return;
  await client.waitForNotification((candidate) => {
    return candidate.method === "thread/settings/updated" && candidate.params.threadId === threadId;
  }, input.timeoutMs ?? 3000, input.description ?? "Codex thread settings update").catch(() => undefined);
}

async function applyReviewSettings(
  client: CodexAppServerControlClient,
  threadId: string,
  runtime: ResolvedNativeCodexRuntime,
): Promise<void> {
  if (runtime.reasoningEffort === null) return;
  await updateCodexThreadSettings(client, threadId, {
    effort: runtime.reasoningEffort,
  });
}

export async function ensureLiveCodexThread(
  client: CodexAppServerControlClient,
  workSession: WorkSessionRecord,
  input: { startIfMissing: boolean; operation: string; config?: AppConfig },
): Promise<LiveCodexThreadResult> {
  const config = input.config ?? getConfig();
  const operation = input.operation.trim().length > 0 ? input.operation.trim() : "Native Codex operation";
  const { params, runtime } = await baseThreadParams(workSession, config);
  const existingThreadId = workSession.codexThreadId;
  let staleThreadId: string | null = null;

  if (existingThreadId !== null) {
    try {
      const resumed = await client.request("thread/resume", {
        ...params,
        threadId: existingThreadId,
        excludeTurns: true,
      });
      const threadId = threadIdFromResponse(resumed, existingThreadId);
      if (threadId === null) {
        throw new Error("Codex thread/resume returned no thread id.");
      }
      await applyReviewSettings(client, threadId, runtime);
      return { threadId, resumed: true, startedFresh: false, staleThreadId: null, runtime };
    } catch (error) {
      if (!input.startIfMissing || !isCodexThreadUnavailableError(error)) {
        throw error;
      }
      staleThreadId = existingThreadId;
    }
  }

  if (!input.startIfMissing) {
    throw new Error(`${operation} requires a live native Codex thread, but this work session has none.`);
  }

  const started = await client.request("thread/start", params);
  const threadId = threadIdFromResponse(started, null);
  if (threadId === null) {
    throw new Error("Codex thread/start returned no thread id.");
  }
  await applyReviewSettings(client, threadId, runtime);
  return { threadId, resumed: false, startedFresh: true, staleThreadId, runtime };
}

export async function waitForCodexTurnCompletion(
  client: CodexAppServerControlClient,
  input: { threadId: string; turnId: string; timeoutMs: number; description?: string },
): Promise<CodexTurnCompletion> {
  const notification = await client.waitForNotification((candidate) => {
    if (candidate.method !== "turn/completed") return false;
    if (candidate.params.threadId !== input.threadId) return false;
    const turn = asRecord(candidate.params.turn);
    return turn?.id === input.turnId;
  }, input.timeoutMs, input.description ?? `Codex turn ${input.turnId} completion`);

  const turn = asRecord(notification.params.turn) ?? {};
  const status = typeof turn.status === "string" ? turn.status : null;
  const error = asRecord(turn.error);
  const errorMessageValue = error?.message;
  return {
    notification,
    turn,
    status,
    errorMessage: typeof errorMessageValue === "string" ? errorMessageValue : null,
  };
}
