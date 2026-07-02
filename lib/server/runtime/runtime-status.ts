import { getConfig } from "@/lib/server/config";
import { readCodexRateLimits, type CodexRateLimitBucket, type CodexRateLimitWindow } from "@/lib/server/runtime/codex-app-server-client";
import { getCodexRuntimeOptions } from "@/lib/server/runtime/codex-model-catalog";
import { getClaudeRuntimeOptions } from "@/lib/server/runtime/claude-model-catalog";
import { readClaudeContext } from "@/lib/server/runtime/claude-context-client";
import { readClaudeUsage, type ClaudeUsageBucket } from "@/lib/server/runtime/claude-usage-client";
import { runClaudeCodeDoctor } from "@/lib/server/runtime/claude-code-doctor";
import { readAgyUsage } from "@/lib/server/runtime/agy-usage-client";
import { createOllamaClient } from "@/lib/server/runtime/ollama-client";
import { hasActiveProcessForWorkSession } from "@/lib/server/runtime/process-registry";
import type {
  AgentProvider,
  RuntimeContextStatus,
  RuntimeDiagnostic,
  RuntimeQuotaBucket,
  RuntimeQuotaStatus,
  RuntimeQuotaWindow,
  RuntimeStatus,
  RuntimeUsageSnapshot,
  WorkSessionRecord,
} from "@/lib/shared/types";


const CLAUDE_CONTEXT_WINDOWS: { match: RegExp; window: number }[] = [
  { match: /(?:^opus$|4[.-]?8|opus-4-8)/i, window: 1_000_000 },
  { match: /opus/i, window: 200_000 },
  { match: /sonnet/i, window: 200_000 },
  { match: /haiku/i, window: 200_000 },
];

function epochSecondsToIso(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

function windowLabel(durationMins: number | null, fallback: string): string {
  if (durationMins === null) {
    return fallback;
  }
  if (durationMins % (60 * 24) === 0) {
    const days = durationMins / (60 * 24);
    return days === 7 ? "weekly" : `${days}d`;
  }
  if (durationMins % 60 === 0) {
    return `${durationMins / 60}h`;
  }
  return `${durationMins}m`;
}

function toQuotaWindow(window: CodexRateLimitWindow | null, fallbackLabel: string): RuntimeQuotaWindow | null {
  if (window === null) {
    return null;
  }
  const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
  return {
    label: windowLabel(window.windowDurationMins, fallbackLabel),
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    resetsAt: epochSecondsToIso(window.resetsAt),
    windowMinutes: window.windowDurationMins,
  };
}

function toQuotaBucket(bucket: CodexRateLimitBucket): RuntimeQuotaBucket {
  const windows: RuntimeQuotaWindow[] = [];
  const primary = toQuotaWindow(bucket.primary, "primary");
  const secondary = toQuotaWindow(bucket.secondary, "secondary");
  if (primary !== null) windows.push(primary);
  if (secondary !== null) windows.push(secondary);
  return {
    id: bucket.limitId,
    label: bucket.limitName,
    planType: bucket.planType,
    windows,
    creditsBalance: bucket.creditsBalance,
  };
}

function usageForProvider(workSession: WorkSessionRecord | null, provider: AgentProvider): RuntimeUsageSnapshot | null {
  const usage = workSession?.runtimeUsage ?? null;
  return usage !== null && usage.provider === provider ? usage : null;
}

function effectiveModel(workSession: WorkSessionRecord | null, catalogDefault: string | null, modelOverride: string | null = null): string | null {
  if (modelOverride !== null && modelOverride.trim().length > 0) {
    return modelOverride.trim();
  }
  const override = workSession?.runtimeOverrides?.model;
  return override !== undefined && override !== null && override.trim().length > 0 ? override.trim() : catalogDefault;
}

function claudeModelMatches(requested: string | null, reported: string | null): boolean {
  if (requested === null || reported === null) {
    return true;
  }
  const normalizedRequested = requested.trim().toLowerCase();
  const normalizedReported = reported.trim().toLowerCase();
  if (normalizedRequested.length === 0 || normalizedReported.length === 0) {
    return true;
  }
  if (normalizedRequested === normalizedReported) {
    return true;
  }
  if (normalizedRequested === "opus" || normalizedRequested === "sonnet" || normalizedRequested === "haiku") {
    return normalizedReported.includes(normalizedRequested);
  }
  return false;
}

function contextFromUsage(usage: RuntimeUsageSnapshot | null, contextWindow: number | null, model: string | null, baseScope: RuntimeContextStatus["scope"]): RuntimeContextStatus {
  const usedTokens = usage?.promptTokens ?? null;
  const window = contextWindow ?? usage?.contextWindow ?? null;
  const remainingTokens = usedTokens !== null && window !== null ? Math.max(0, window - usedTokens) : null;
  return {
    usedTokens,
    contextWindow: window,
    remainingTokens,
    scope: usedTokens !== null ? baseScope : "catalog",
    model,
    note: usedTokens !== null
      ? "Used tokens are from the most recent run (latest prompt evaluation)."
      : window !== null
        ? "Context window from the model catalog; run the agent once to measure used tokens."
        : "Context window is unknown for this model.",
  };
}

function contextFromWindowOnly(contextWindow: number | null, model: string | null, note: string): RuntimeContextStatus {
  return {
    usedTokens: null,
    contextWindow,
    remainingTokens: null,
    scope: contextWindow !== null ? "estimate" : "unknown",
    model,
    note,
  };
}

function unsupportedStatus(provider: AgentProvider, model: string | null, note: string): RuntimeStatus {
  return {
    provider,
    model,
    quota: { scope: "none", buckets: [], costUsd: null, note },
    context: { usedTokens: null, contextWindow: null, remainingTokens: null, scope: "unknown", model, note },
    compaction: { supported: false, manualCompaction: false, canManualCompact: false, autoObserved: false, lastCompactionAt: null, trigger: null, note },
    diagnostics: [{ id: "provider", label: "Provider", status: "unavailable", detail: note }],
    source: "unsupported",
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

function runtimeDiagnostics(input: {
  provider: AgentProvider;
  model: string | null;
  source: RuntimeStatus["source"];
  quota: RuntimeQuotaStatus;
  context: RuntimeContextStatus;
  compactionSupported: boolean;
  activeRun?: boolean;
  error?: string | null;
}): RuntimeDiagnostic[] {
  return [
    {
      id: "provider",
      label: "Provider",
      status: input.error ? "degraded" : input.source === "unsupported" || input.source === "empty" ? "unknown" : "ok",
      detail: input.error ?? `${input.provider} telemetry source: ${input.source}.`,
    },
    {
      id: "model",
      label: "Model",
      status: input.model === null ? "unavailable" : "ok",
      detail: input.model === null ? "No effective model is configured for this provider." : `Effective model: ${input.model}.`,
    },
    {
      id: "context",
      label: "Context",
      status: input.context.contextWindow === null && input.context.usedTokens === null ? "unknown" : "ok",
      detail: input.context.note,
    },
    {
      id: "quota",
      label: "Quota",
      status: input.quota.scope === "none" ? "unknown" : input.quota.buckets.length > 0 || input.quota.costUsd !== null ? "ok" : "degraded",
      detail: input.quota.note,
    },
    {
      id: "tools",
      label: "Tooling",
      status: input.provider === "ollama" || input.provider === "codex-cli" || input.provider === "claude-code" || input.provider === "antigravity-cli" ? "ok" : "unknown",
      detail: input.provider === "ollama"
        ? `Workspace-confined orchestrator tools are available${input.activeRun ? " for the active loop" : " when a run starts"}.`
        : "Provider-owned tooling is mediated by the runtime adapter.",
    },
    {
      id: "compaction",
      label: "Compaction",
      status: input.compactionSupported ? "ok" : "unknown",
      detail: input.compactionSupported ? "Compaction telemetry is supported for this provider." : "Compaction telemetry is not exposed by this provider.",
    },
  ];
}

async function codexStatus(workSession: WorkSessionRecord | null, modelOverride: string | null = null): Promise<RuntimeStatus> {
  let model: string | null = null;
  let contextWindow: number | null = null;
  try {
    const catalog = await getCodexRuntimeOptions();
    model = effectiveModel(workSession, catalog.defaults.model, modelOverride);
    const option = model === null ? null : catalog.models.find((candidate) => candidate.slug === model) ?? null;
    contextWindow = option?.contextWindow ?? null;
  } catch {
    model = effectiveModel(workSession, null, modelOverride);
  }

  const snapshot = await readCodexRateLimits().catch(() => null);
  const usage = usageForProvider(workSession, "codex-cli");

  let quota: RuntimeQuotaStatus;
  if (snapshot !== null && snapshot.buckets.length > 0) {
    quota = {
      scope: "bucket",
      buckets: snapshot.buckets.map(toQuotaBucket),
      costUsd: null,
      note: "Codex quota is metered per account limit bucket (limit_id), not per model.",
    };
  } else {
    quota = {
      scope: "account",
      buckets: [],
      costUsd: null,
      note: snapshot === null
        ? "Codex rate limits are unavailable (app-server not reachable or not signed in)."
        : "Codex reported no rate-limit buckets.",
    };
  }

  const appServer = getConfig().codexAppServerExec;
  return {
    provider: "codex-cli",
    model,
    quota,
    context: contextFromUsage(usage, contextWindow, model, "last-run"),
    compaction: {
      supported: true,
      manualCompaction: false,
      canManualCompact: false,
      autoObserved: usage?.compactionTrigger != null,
      lastCompactionAt: usage?.compactionAt ?? null,
      trigger: usage?.compactionTrigger ?? null,
      note: appServer
        ? "Codex auto-compacts during runs as the context fills (seamless and persisted). Manual compaction isn't applicable — Codex only compacts turn-time, so an idle thread has nothing to compact."
        : "Auto-compaction is detected from the run output. Use CODEX_TRANSPORT_MODE=auto or app-server-only for live compaction detection.",
    },
    source: snapshot !== null ? "live" : usage !== null ? "cache" : "empty",
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

async function ollamaStatus(workSession: WorkSessionRecord | null, modelOverride: string | null = null): Promise<RuntimeStatus> {
  const config = getConfig();
  const override = workSession?.runtimeOverrides?.model;
  const model = modelOverride !== null && modelOverride.trim().length > 0
    ? modelOverride.trim()
    : override !== undefined && override !== null && override.trim().length > 0
    ? override.trim()
    : config.ollamaModel.trim().length > 0 ? config.ollamaModel.trim() : null;
  const numCtxOverride = workSession?.runtimeOverrides?.numCtx ?? config.ollamaNumCtx;

  let liveWindow: number | null = null;
  if (model !== null) {
    liveWindow = await createOllamaClient().showModelContextLength(model).catch(() => null);
  }
  const usage = usageForProvider(workSession, "ollama");
  const contextWindow = numCtxOverride ?? liveWindow ?? usage?.contextWindow ?? null;
  const runActive = workSession !== null && hasActiveProcessForWorkSession(workSession.id);

  return {
    provider: "ollama",
    model,
    quota: { scope: "none", buckets: [], costUsd: null, note: "Ollama runs locally; there is no remote usage quota." },
    context: contextFromUsage(usage, contextWindow, model, "last-run"),
    compaction: {
      supported: true,
      manualCompaction: true,
      canManualCompact: runActive,
      autoObserved: usage?.compactionTrigger != null,
      lastCompactionAt: usage?.compactionAt ?? null,
      trigger: usage?.compactionTrigger ?? null,
      note: runActive
        ? "The orchestrator-owned loop auto-compacts older messages near the context limit; Compact now folds them immediately."
        : "Compaction applies to a running Ollama loop (auto near the limit, or Compact now). Nothing to compact between tasks.",
    },
    source: liveWindow !== null ? "live" : usage !== null ? "cache" : "empty",
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

async function claudeStatus(workSession: WorkSessionRecord | null, modelOverride: string | null = null, reasoningEffortOverride: string | null = null): Promise<RuntimeStatus> {
  const config = getConfig();
  let model: string | null = null;
  try {
    const catalog = await getClaudeRuntimeOptions();
    model = effectiveModel(workSession, catalog.defaults.model, modelOverride);
  } catch {
    model = effectiveModel(workSession, null, modelOverride);
  }
  const rawUsage = usageForProvider(workSession, "claude-code");
  const usage = claudeModelMatches(model, rawUsage?.model ?? null) ? rawUsage : null;
  const estimatedWindow = model === null
    ? null
    : CLAUDE_CONTEXT_WINDOWS.find((entry) => entry.match.test(model as string))?.window ?? null;
  const persistent = config.claudePersistentSessions;
  const hasSession = workSession?.claudeSessionId != null;
  const claudeRunActive = workSession !== null && hasActiveProcessForWorkSession(workSession.id);
  const probedContext = persistent && hasSession && !claudeRunActive
    ? await readClaudeContext({
        cwd: workSession.activeWorktreePath,
        sessionId: workSession.claudeSessionId as string,
        permissionMode: config.claudePermissionMode,
        tools: config.claudeTools,
        disallowedTools: config.claudeDisallowedTools,
        bare: config.claudeBare,
        model,
        effort: reasoningEffortOverride ?? workSession.runtimeOverrides?.reasoningEffort ?? (config.claudeEffort.trim().length > 0 ? config.claudeEffort.trim() : null),
      }).catch(() => null)
    : null;
  const liveContext = claudeModelMatches(model, probedContext?.model ?? null) ? probedContext : null;
  const context = liveContext !== null
    ? {
        usedTokens: liveContext.usedTokens,
        contextWindow: liveContext.contextWindow,
        remainingTokens: liveContext.remainingTokens,
        scope: "live-thread" as const,
        model: liveContext.model ?? model,
        note: "Live Claude Code context from the persisted session's /context output.",
        details: liveContext.details,
      }
    : contextFromWindowOnly(
        estimatedWindow,
        model,
        persistent
          ? hasSession
            ? claudeRunActive
              ? "Claude context is not probed while the agent is running; showing the model-family window only."
              : "Claude /context was unavailable; showing the model-family window only."
            : "Claude /context is available after the first persisted session run; showing the model-family window only."
          : "Enable CLAUDE_PERSISTENT_SESSIONS to query Claude Code /context; showing the model-family window only.",
      );

  const usageSnapshot = await readClaudeUsage().catch(() => null);
  let quota: RuntimeQuotaStatus;
  if (usageSnapshot !== null) {
    const toBucket = (bucket: ClaudeUsageBucket, id: string): RuntimeQuotaBucket => ({
      id,
      label: bucket.label,
      planType: null,
      windows: bucket.windows.map((window) => ({
        label: window.label,
        usedPercent: window.utilization,
        remainingPercent: Math.max(0, 100 - window.utilization),
        resetsAt: window.resetsAt,
        windowMinutes: window.windowMinutes,
      })),
      creditsBalance: null,
    });
    const buckets: RuntimeQuotaBucket[] = [];
    if (usageSnapshot.subscription.windows.length > 0) {
      buckets.push(toBucket(usageSnapshot.subscription, "subscription"));
    }
    usageSnapshot.perModel.forEach((bucket, index) => buckets.push(toBucket(bucket, `model-${index}`)));
    const extra = usageSnapshot.extraUsage;
    if (extra !== null && extra.enabled && extra.monthlyLimit !== null) {
      const remaining = extra.usedCredits !== null ? Math.max(0, extra.monthlyLimit - extra.usedCredits) : extra.monthlyLimit;
      buckets.push({
        id: "extra-usage",
        label: "Extra usage",
        planType: null,
        windows: [],
        creditsBalance: `${remaining}${extra.currency !== null ? ` ${extra.currency}` : ""}`,
      });
    }
    quota = {
      scope: "account",
      buckets,
      costUsd: usage?.costUsd ?? null,
      note: "Claude subscription utilization from the Anthropic OAuth usage endpoint (same as /usage).",
    };
  } else {
    quota = {
      scope: "cost",
      buckets: [],
      costUsd: usage?.costUsd ?? null,
      note: "Claude usage is unavailable (not signed in via Claude Code, or token expired — open Claude Code once).",
    };
  }

  const doctor = await runClaudeCodeDoctor().catch(() => null);
  const apiKeyAuth = config.claudeBare || (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0;
  const auth: { status: RuntimeDiagnostic["status"]; detail: string } =
    doctor === null || !doctor.available
      ? { status: "unavailable", detail: "Claude Code CLI is not available, so auth status cannot be checked." }
      : doctor.authenticated === true
        ? { status: "ok", detail: "Signed in to Claude Code." }
        : doctor.authenticated === false
          ? apiKeyAuth
            ? { status: "ok", detail: "Not signed in via Claude Code login, but ANTHROPIC_API_KEY / bare mode provides auth." }
            : { status: "degraded", detail: "Claude Code is installed but not signed in. Run `claude auth login` or set ANTHROPIC_API_KEY." }
          : { status: "unknown", detail: "Claude Code auth status could not be determined." };
  const claudeModelEffective = context.model ?? model;
  const claudeSource: RuntimeStatus["source"] = liveContext !== null || usageSnapshot !== null ? "live" : usage !== null ? "cache" : "empty";

  const baseDiagnostics = runtimeDiagnostics({
    provider: "claude-code",
    model: claudeModelEffective,
    source: claudeSource,
    quota,
    context,
    compactionSupported: true,
    activeRun: claudeRunActive,
    error: null,
  });
  const diagnostics: RuntimeDiagnostic[] = [
    baseDiagnostics[0],
    { id: "auth", label: "Auth", status: auth.status, detail: auth.detail },
    ...baseDiagnostics.slice(1),
  ];

  return {
    provider: "claude-code",
    model: claudeModelEffective,
    quota,
    context,
    diagnostics,
    compaction: {
      supported: true,
      manualCompaction: true,
      canManualCompact: persistent && hasSession && !claudeRunActive,
      autoObserved: usage?.compactionTrigger != null,
      lastCompactionAt: usage?.compactionAt ?? null,
      trigger: usage?.compactionTrigger ?? null,
      note: persistent
        ? hasSession
          ? claudeRunActive
            ? "Auto-compaction is detected from stream-json; Compact now is available between runs so the app does not resume the same Claude session concurrently."
            : "Auto-compaction is detected from stream-json; Compact now sends a /compact turn to the idle persisted session."
          : "Auto-compaction is detected from stream-json; a session is created on the first run, then Compact now becomes available."
        : "Auto-compaction is detected from stream-json. Manual /compact needs persistent sessions (CLAUDE_PERSISTENT_SESSIONS).",
    },
    source: claudeSource,
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

async function agyStatus(workSession: WorkSessionRecord | null, modelOverride: string | null = null): Promise<RuntimeStatus> {
  const model = effectiveModel(workSession, null, modelOverride);
  const unsupportedNote = "AGY quota is behind Google's internal Cloud Code PA API; it is unavailable (sign in via AGY, or the on-disk token has expired).";
  const usage = await readAgyUsage().catch(() => null);

  if (usage === null || (usage.buckets.length === 0 && usage.tier === null)) {
    return {
      provider: "antigravity-cli",
      model,
      quota: { scope: "none", buckets: [], costUsd: null, note: unsupportedNote },
      context: { usedTokens: null, contextWindow: null, remainingTokens: null, scope: "unknown", model, note: "AGY does not expose context telemetry." },
      compaction: { supported: false, manualCompaction: false, canManualCompact: false, autoObserved: false, lastCompactionAt: null, trigger: null, note: "AGY does not expose compaction telemetry." },
      source: "unsupported",
      fetchedAt: new Date().toISOString(),
      error: null,
    };
  }

  const buckets: RuntimeQuotaBucket[] = usage.buckets.map((bucket, index) => ({
    id: `agy-${index}`,
    label: bucket.label,
    planType: usage.tier,
    windows: bucket.windows.map((window) => ({
      label: window.label,
      usedPercent: window.usedPercent,
      remainingPercent: Math.max(0, 100 - window.usedPercent),
      resetsAt: window.resetsAt,
      windowMinutes: null,
    })),
    creditsBalance: bucket.creditsBalance,
  }));

  return {
    provider: "antigravity-cli",
    model,
    quota: {
      scope: "account",
      buckets,
      costUsd: null,
      note: usage.tier !== null ? `AGY plan: ${usage.tier}. Quota via Google Cloud Code PA (undocumented).` : "AGY quota via Google Cloud Code PA (undocumented).",
    },
    context: { usedTokens: null, contextWindow: null, remainingTokens: null, scope: "unknown", model, note: "AGY does not expose context telemetry." },
    compaction: { supported: false, manualCompaction: false, canManualCompact: false, autoObserved: false, lastCompactionAt: null, trigger: null, note: "AGY does not expose compaction telemetry." },
    source: "live",
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

export async function getRuntimeStatus(input: {
  provider: AgentProvider;
  workSession: WorkSessionRecord | null;
  modelOverride?: string | null;
  reasoningEffortOverride?: string | null;
}): Promise<RuntimeStatus> {
  let status: RuntimeStatus;
  switch (input.provider) {
    case "codex-cli":
      status = await codexStatus(input.workSession, input.modelOverride ?? null);
      break;
    case "ollama":
      status = await ollamaStatus(input.workSession, input.modelOverride ?? null);
      break;
    case "claude-code":
      status = await claudeStatus(input.workSession, input.modelOverride ?? null, input.reasoningEffortOverride ?? null);
      break;
    case "antigravity-cli":
      status = await agyStatus(input.workSession, input.modelOverride ?? null);
      break;
    default:
      status = unsupportedStatus(input.provider, null, "This provider does not expose runtime telemetry.");
      break;
  }
  status.diagnostics ??= runtimeDiagnostics({
    provider: status.provider,
    model: status.model,
    source: status.source,
    quota: status.quota,
    context: status.context,
    compactionSupported: status.compaction.supported,
    activeRun: input.workSession !== null && hasActiveProcessForWorkSession(input.workSession.id),
    error: status.error,
  });
  return status;
}
