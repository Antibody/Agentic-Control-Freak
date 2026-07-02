import type { CodexTransportMode, ExecutorSandboxMode, ReasoningEffort, RuntimeOverrides, RuntimeServiceTier } from "@/lib/shared/types";

export const fallbackReasoningEfforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
export const executorSandboxModes: ExecutorSandboxMode[] = ["workspace-write", "danger-full-access"];
export const codexTransportModes: CodexTransportMode[] = ["auto", "app-server-only", "exec-only"];
export const standardServiceTier: RuntimeServiceTier = "__standard__";

export function emptyRuntimeOverrides(): RuntimeOverrides {
  return { model: null, reasoningEffort: null, serviceTier: null, sandboxMode: null, networkAccess: null, codexTransportMode: null, timeoutMs: null, temperature: null, numCtx: null, ultracode: null };
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function asPositiveInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function asUnitInterval(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim().length > 0 ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.min(parsed, 2);
}

export function normalizeRuntimeOverrides(input: unknown): RuntimeOverrides {
  const overrides = emptyRuntimeOverrides();
  if (typeof input !== "object" || input === null) {
    return overrides;
  }
  const candidate = input as Record<string, unknown>;

  if (typeof candidate.model === "string" && candidate.model.trim().length > 0) {
    overrides.model = candidate.model.trim().slice(0, 120);
  }
  if (typeof candidate.reasoningEffort === "string") {
    const effort = candidate.reasoningEffort.trim();
    overrides.reasoningEffort = effort.length > 0 && effort !== "minimal" ? effort.slice(0, 40) : null;
  }
  if (typeof candidate.serviceTier === "string") {
    const tier = candidate.serviceTier.trim();
    overrides.serviceTier = tier.length > 0 ? tier.slice(0, 80) : null;
  }
  overrides.sandboxMode = asEnum<ExecutorSandboxMode>(candidate.sandboxMode, executorSandboxModes);
  if (typeof candidate.networkAccess === "boolean") {
    overrides.networkAccess = candidate.networkAccess;
  }
  overrides.codexTransportMode = asEnum<CodexTransportMode>(candidate.codexTransportMode, codexTransportModes);
  overrides.timeoutMs = asPositiveInt(candidate.timeoutMs);
  overrides.temperature = asUnitInterval(candidate.temperature);
  overrides.numCtx = asPositiveInt(candidate.numCtx);
  if (typeof candidate.ultracode === "boolean") {
    overrides.ultracode = candidate.ultracode;
  }

  return overrides;
}

export function isRuntimeOverridesEmpty(overrides: RuntimeOverrides): boolean {
  return (
    overrides.model === null &&
    overrides.reasoningEffort === null &&
    overrides.serviceTier === null &&
    overrides.sandboxMode === null &&
    overrides.networkAccess === null &&
    overrides.codexTransportMode === null &&
    overrides.timeoutMs === null &&
    overrides.temperature === null &&
    overrides.numCtx === null &&
    overrides.ultracode === null
  );
}
