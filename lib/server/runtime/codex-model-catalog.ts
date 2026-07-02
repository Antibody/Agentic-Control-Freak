import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig, type AppConfig } from "@/lib/server/config";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolveCodexCliBin } from "@/lib/server/runtime/codex-cli-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";
import { withCodexAppServerControl } from "@/lib/server/runtime/codex-app-server-control";
import { standardServiceTier } from "@/lib/shared/runtime-overrides";
import type { CodexModelOption, CodexRuntimeOptions, ExecutorSandboxMode } from "@/lib/shared/types";

const memoryTtlMs = 10 * 60 * 1000;
let memoryCache: { expiresAt: number; options: CodexRuntimeOptions } | null = null;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function booleanValue(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function positiveIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function parseReasoningLevels(value: unknown): CodexModelOption["supportedReasoningLevels"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }
      const candidate = entry as Record<string, unknown>;
      const effort = stringValue(candidate.effort);
      if (effort === null) {
        return null;
      }
      return {
        effort,
        description: stringValue(candidate.description),
      };
    })
    .filter((entry): entry is CodexModelOption["supportedReasoningLevels"][number] => entry !== null);
}

function parseServiceTiers(value: unknown): CodexModelOption["serviceTiers"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }
      const candidate = entry as Record<string, unknown>;
      const id = stringValue(candidate.id);
      if (id === null) {
        return null;
      }
      return {
        id,
        name: stringValue(candidate.name) ?? id,
        description: stringValue(candidate.description),
      };
    })
    .filter((entry): entry is CodexModelOption["serviceTiers"][number] => entry !== null);
}

function parseNativeReasoningLevels(value: unknown): CodexModelOption["supportedReasoningLevels"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const candidate = entry as Record<string, unknown>;
      const effort = stringValue(candidate.reasoningEffort) ?? stringValue(candidate.effort);
      if (effort === null) return null;
      return { effort, description: stringValue(candidate.description) };
    })
    .filter((entry): entry is CodexModelOption["supportedReasoningLevels"][number] => entry !== null);
}

function parseNativeServiceTiers(value: unknown): CodexModelOption["serviceTiers"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const candidate = entry as Record<string, unknown>;
      const id = stringValue(candidate.id);
      if (id === null) return null;
      return { id, name: stringValue(candidate.name) ?? id, description: stringValue(candidate.description) };
    })
    .filter((entry): entry is CodexModelOption["serviceTiers"][number] => entry !== null);
}

function parseTopLevelTomlString(raw: string, key: string): string | null {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`, "m");
  const match = raw.match(pattern);
  return match?.[1]?.trim() || null;
}

async function readCodexConfigDefaults(): Promise<{ model: string | null; reasoningEffort: string | null; serviceTier: string | null }> {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  try {
    const raw = await readFile(path.join(codexHome, "config.toml"), "utf8");
    return {
      model: parseTopLevelTomlString(raw, "model"),
      reasoningEffort: parseTopLevelTomlString(raw, "model_reasoning_effort"),
      serviceTier: parseTopLevelTomlString(raw, "service_tier"),
    };
  } catch {
    return { model: null, reasoningEffort: null, serviceTier: null };
  }
}

async function resolveRuntimeDefaults(config: AppConfig): Promise<CodexRuntimeOptions["defaults"]> {
  const cliDefaults = await readCodexConfigDefaults();
  const configModel = config.codexModel.trim();
  const configEffort = config.codexReasoningEffort.trim();
  return {
    model: configModel.length > 0 ? configModel : cliDefaults.model,
    reasoningEffort: configEffort.length > 0 ? configEffort : cliDefaults.reasoningEffort,
    serviceTier: cliDefaults.serviceTier,
    sandboxMode: config.codexSandboxMode as ExecutorSandboxMode,
    networkAccess: null,
    timeoutMs: config.codexTimeoutMs,
    codexTransportMode: config.codexTransportMode,
  };
}

function parseCatalog(raw: string, source: CodexRuntimeOptions["source"]): CodexRuntimeOptions {
  const config = getConfig();
  const parsed = JSON.parse(raw) as unknown;
  const models = typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { models?: unknown }).models)
    ? (parsed as { models: unknown[] }).models
    : [];
  const compactModels = models
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }
      const candidate = entry as Record<string, unknown>;
      const slug = stringValue(candidate.slug);
      if (slug === null) {
        return null;
      }
      const displayName = stringValue(candidate.display_name) ?? slug;
      const supportedReasoningLevels = parseReasoningLevels(candidate.supported_reasoning_levels);
      const serviceTiers = parseServiceTiers(candidate.service_tiers);
      const contextWindow = positiveIntOrNull(candidate.context_window) ?? positiveIntOrNull(candidate.max_context_window);
      return {
        slug,
        displayName,
        description: stringValue(candidate.description),
        defaultReasoningLevel: stringValue(candidate.default_reasoning_level),
        supportedReasoningLevels,
        supportedInApi: booleanValue(candidate.supported_in_api),
        visibility: stringValue(candidate.visibility) ?? "list",
        priority: numberValue(candidate.priority),
        contextWindow,
        serviceTiers,
        defaultServiceTier: stringValue(candidate.default_service_tier),
      };
    })
    .filter((entry): entry is CodexModelOption => entry !== null)
    .filter((model) => model.visibility !== "hide")
    .sort((a, b) => b.priority - a.priority || a.displayName.localeCompare(b.displayName));

  return {
    models: compactModels,
    defaults: {
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      sandboxMode: config.codexSandboxMode as ExecutorSandboxMode,
      networkAccess: null,
      timeoutMs: config.codexTimeoutMs,
      codexTransportMode: config.codexTransportMode,
    },
    source,
    fetchedAt: new Date().toISOString(),
    error: null,
  };
}

function cachePath(): string {
  return path.join(path.dirname(getConfig().dbFile), "codex-model-catalog.json");
}

async function readPersistedCatalog(): Promise<CodexRuntimeOptions | null> {
  try {
    const raw = await readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as CodexRuntimeOptions;
    if (!Array.isArray(parsed.models)) {
      return null;
    }
    return { ...parsed, source: "cache" };
  } catch {
    return null;
  }
}

async function writePersistedCatalog(options: CodexRuntimeOptions): Promise<void> {
  const pathname = cachePath();
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, `${JSON.stringify(options, null, 2)}\n`, "utf8");
}

async function runCatalogCommand(extraArgs: string[] = []): Promise<CodexRuntimeOptions> {
  const executable = await resolveCodexCliBin();
  const result = await runProcess({
    command: executable.command,
    args: ["debug", "models", ...extraArgs],
    cwd: process.cwd(),
    timeoutMs: 30_000,
    env: createSanitizedProcessEnv({ CI: "true" }),
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(result.stderr || result.stdout || "Codex model catalog command failed.");
  }
  return parseCatalog(result.stdout, extraArgs.includes("--bundled") ? "bundled" : "live");
}

function parseNativeModels(response: Record<string, unknown>, defaults: CodexRuntimeOptions["defaults"]): CodexRuntimeOptions | null {
  const data = Array.isArray(response.data) ? response.data : [];
  if (data.length === 0) {
    return null;
  }
  const models = data
    .map((entry): CodexModelOption | null => {
      if (typeof entry !== "object" || entry === null) return null;
      const candidate = entry as Record<string, unknown>;
      const slug = stringValue(candidate.model) ?? stringValue(candidate.id);
      if (slug === null) return null;
      const hidden = candidate.hidden === true;
      if (hidden) return null;
      const supportedReasoningLevels = parseNativeReasoningLevels(candidate.supportedReasoningEfforts);
      return {
        slug,
        displayName: stringValue(candidate.displayName) ?? slug,
        description: stringValue(candidate.description),
        defaultReasoningLevel: stringValue(candidate.defaultReasoningEffort),
        supportedReasoningLevels,
        supportedInApi: true,
        visibility: "list",
        priority: candidate.isDefault === true ? 10_000 : 0,
        contextWindow: null,
        serviceTiers: parseNativeServiceTiers(candidate.serviceTiers),
        defaultServiceTier: stringValue(candidate.defaultServiceTier),
      };
    })
    .filter((entry): entry is CodexModelOption => entry !== null)
    .sort((a, b) => b.priority - a.priority || a.displayName.localeCompare(b.displayName));
  if (models.length === 0) {
    return null;
  }
  return {
    models,
    defaults: {
      ...defaults,
      model: models.find((candidate) => candidate.priority > 0)?.slug ?? defaults.model,
    },
    source: "native",
    fetchedAt: new Date().toISOString(),
    error: null,
    native: {
      source: "app-server",
      models: true,
      permissionProfiles: false,
      collaborationModes: false,
      configRequirements: false,
      error: null,
    },
  };
}

async function readNativeCodexRuntimeOptions(defaults: CodexRuntimeOptions["defaults"]): Promise<CodexRuntimeOptions | null> {
  return withCodexAppServerControl(process.cwd(), async (client) => {
    const modelList = await client.request("model/list", {});
    const native = parseNativeModels(modelList, defaults);
    if (native === null) {
      return null;
    }
    const featureResults = await Promise.allSettled([
      client.request("permissionProfile/list", {}),
      client.request("collaborationMode/list", {}),
      client.request("configRequirements/read", undefined),
    ]);
    return {
      ...native,
      native: {
        source: "app-server",
        models: true,
        permissionProfiles: featureResults[0].status === "fulfilled",
        collaborationModes: featureResults[1].status === "fulfilled",
        configRequirements: featureResults[2].status === "fulfilled",
        error: null,
      },
    };
  });
}

export async function getCodexRuntimeOptions(input: { forceRefresh?: boolean } = {}): Promise<CodexRuntimeOptions> {
  const config = getConfig();
  const defaults = await resolveRuntimeDefaults(config);
  const now = Date.now();
  if (!input.forceRefresh && memoryCache !== null && memoryCache.expiresAt > now) {
    return { ...memoryCache.options, defaults };
  }

  try {
    const live = { ...await runCatalogCommand(), defaults };
    try {
      const native = await readNativeCodexRuntimeOptions(defaults);
      if (native !== null) {
        const merged = {
          ...native,
          source: "native+live" as const,
          error: live.error,
          models: native.models.length > 0 ? native.models : live.models,
        };
        memoryCache = { expiresAt: now + memoryTtlMs, options: merged };
        await writePersistedCatalog(merged);
        return merged;
      }
    } catch {
    }
    memoryCache = { expiresAt: now + memoryTtlMs, options: live };
    await writePersistedCatalog(live);
    return live;
  } catch (liveError) {
    try {
      const native = await readNativeCodexRuntimeOptions(defaults);
      if (native !== null) {
        memoryCache = { expiresAt: now + memoryTtlMs, options: native };
        await writePersistedCatalog(native);
        return native;
      }
    } catch {
    }
    const cached = await readPersistedCatalog();
    if (cached !== null) {
      const options = {
        ...cached,
        defaults,
        error: liveError instanceof Error ? liveError.message : "Unable to refresh Codex model catalog.",
      };
      memoryCache = { expiresAt: now + memoryTtlMs, options };
      return options;
    }

    try {
      const bundled = { ...await runCatalogCommand(["--bundled"]), defaults };
      const options = {
        ...bundled,
        error: liveError instanceof Error ? liveError.message : "Unable to refresh Codex model catalog.",
      };
      memoryCache = { expiresAt: now + memoryTtlMs, options };
      return options;
    } catch (bundledError) {
      const error = bundledError instanceof Error ? bundledError.message : liveError instanceof Error ? liveError.message : "Unable to read Codex model catalog.";
      return { models: [], defaults, source: "empty", fetchedAt: null, error };
    }
  }
}

export async function validateCodexModelReasoning(input: {
  model: string | null;
  reasoningEffort: string | null;
  serviceTier?: string | null;
}): Promise<{ model: string | null; reasoningEffort: string | null; serviceTier: string | null; reason: string | null }> {
  const options = await getCodexRuntimeOptions();
  const model = input.model?.trim() ? input.model.trim() : null;
  const reasoningEffort = input.reasoningEffort?.trim() ? input.reasoningEffort.trim() : null;
  const requestedServiceTier = input.serviceTier?.trim() ? input.serviceTier.trim() : null;
  if (options.models.length === 0) {
    return {
      model,
      reasoningEffort,
      serviceTier: requestedServiceTier,
      reason: null,
    };
  }

  if (model === null) {
    let reason: string | null = null;
    let serviceTier = requestedServiceTier;
    const availableEfforts = new Set(options.models.flatMap((candidate) => candidate.supportedReasoningLevels.map((level) => level.effort)));
    const normalizedEffort = reasoningEffort === null || availableEfforts.has(reasoningEffort) ? reasoningEffort : null;
    if (reasoningEffort !== null && normalizedEffort === null) {
      reason = `Reasoning effort '${reasoningEffort}' is not available in the current Codex CLI catalog; using the configured default.`;
    }
    if (serviceTier !== null && serviceTier !== standardServiceTier) {
      const availableTiers = new Set(options.models.flatMap((candidate) => (candidate.serviceTiers ?? []).map((tier) => tier.id)));
      if (!availableTiers.has(serviceTier)) {
        serviceTier = null;
        reason = reason ?? `Service tier '${requestedServiceTier}' is not available in the current Codex CLI catalog; using the configured default.`;
      }
    }
    return { model: null, reasoningEffort: normalizedEffort, serviceTier, reason };
  }

  const selected = options.models.find((candidate) => candidate.slug === model);
  if (selected === undefined) {
    return {
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      reason: `Selected Codex model '${model}' is not available in the current CLI catalog; using the configured default.`,
    };
  }

  let reason: string | null = null;
  let normalizedEffort = reasoningEffort;
  const allowed = new Set(selected.supportedReasoningLevels.map((level) => level.effort));
  if (reasoningEffort !== null && !allowed.has(reasoningEffort)) {
    normalizedEffort = null;
    reason = `Reasoning effort '${reasoningEffort}' is not available for ${selected.displayName}; using the model default.`;
  }

  let serviceTier = requestedServiceTier;
  if (serviceTier !== null && serviceTier !== standardServiceTier) {
    const allowedTiers = new Set((selected.serviceTiers ?? []).map((tier) => tier.id));
    if (!allowedTiers.has(serviceTier)) {
      serviceTier = null;
      reason = reason ?? `Service tier '${requestedServiceTier}' is not available for ${selected.displayName}; using the configured default.`;
    }
  }

  return { model, reasoningEffort: normalizedEffort, serviceTier, reason };
}
