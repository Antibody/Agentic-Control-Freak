import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { claudeSettingsPath, readProviderSettings, stringSetting } from "@/lib/server/runtime/provider-settings";
import { standardServiceTier } from "@/lib/shared/runtime-overrides";
import type { CodexModelOption, CodexRuntimeOptions, ExecutorSandboxMode } from "@/lib/shared/types";

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"];
const effortCapableAliases = new Set(["sonnet", "opus"]);
const memoryTtlMs = 10 * 60 * 1000;
const maxProjectLogFiles = 80;
const maxProjectLogBytes = 8_000_000;
let memoryCache: { expiresAt: number; options: CodexRuntimeOptions } | null = null;

interface ClaudeDiscovery {
  observedModels: Set<string>;
  settingsModel: string | null;
  settingsEffort: string | null;
  settingsError: string | null;
  settingsExists: boolean;
  error: string | null;
}

function claudeHomeDir(): string {
  return path.join(os.homedir(), ".claude");
}

function cachePath(): string {
  return path.join(path.dirname(getConfig().dbFile), "claude-model-catalog.json");
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizeModelSlug(value: string | null | undefined): string | null {
  const slug = value?.trim();
  if (slug === undefined || slug.length === 0 || slug.length > 160) return null;
  if (/\s/.test(slug)) return null;
  return slug;
}

function normalizeObservedClaudeModel(value: string | null | undefined): string | null {
  const slug = normalizeModelSlug(value);
  if (slug === null) return null;
  const normalized = slug.toLowerCase();
  if (normalized === "haiku" || normalized === "sonnet" || normalized === "opus") return normalized;
  if (!/^claude-[a-z0-9][a-z0-9._-]*$/i.test(slug)) return null;
  if (!/(haiku|sonnet|opus)/i.test(slug)) return null;
  return slug;
}

function displayNameForModel(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (normalized === "haiku") return "Haiku";
  if (normalized === "sonnet") return "Sonnet";
  if (normalized === "opus") return "Opus";

  const family = normalized.match(/^claude-(haiku|sonnet|opus)-(\d)(?:[-.](\d))?/);
  if (family !== null) {
    const modelFamily = `${family[1][0].toUpperCase()}${family[1].slice(1)}`;
    return family[3] === undefined ? `${modelFamily} ${family[2]}` : `${modelFamily} ${family[2]}.${family[3]}`;
  }
  return slug;
}

function supportsClaudeEffort(model: string | null): boolean {
  if (model === null) return true;
  const normalized = model.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (effortCapableAliases.has(normalized)) return true;
  if (normalized.includes("haiku")) return false;
  return normalized.includes("sonnet") || normalized.includes("opus");
}

function supportsClaudeFast(model: string | null): boolean {
  if (model === null) return true;
  const normalized = model.trim().toLowerCase();
  if (normalized.length === 0) return true;
  if (normalized === "opus") return true;
  return normalized.includes("opus");
}

function claudeModelOption(input: { slug: string; description: string; priority: number }): CodexModelOption {
  const supportsEffort = supportsClaudeEffort(input.slug);
  const supportsFast = supportsClaudeFast(input.slug);
  return {
    slug: input.slug,
    displayName: displayNameForModel(input.slug),
    description: input.description,
    defaultReasoningLevel: null,
    supportedReasoningLevels: supportsEffort ? claudeEfforts.map((effort) => ({ effort, description: null })) : [],
    supportedInApi: true,
    visibility: "list",
    priority: input.priority,
    contextWindow: null,
    serviceTiers: supportsFast
      ? [{ id: "fast", name: "Fast", description: "Claude Fast mode for Opus; higher speed at higher usage rate." }]
      : [],
    defaultServiceTier: null,
  };
}

function upsertModel(models: Map<string, CodexModelOption>, input: { slug: string | null; description: string; priority: number }): void {
  const slug = normalizeModelSlug(input.slug);
  if (slug === null) return;
  const existing = models.get(slug);
  if (existing !== undefined && existing.priority >= input.priority) return;
  models.set(slug, claudeModelOption({ slug, description: input.description, priority: input.priority }));
}

function builtInClaudeModels(): Map<string, CodexModelOption> {
  const models = new Map<string, CodexModelOption>();
  upsertModel(models, { slug: "haiku", description: "Claude Code model alias; effort is not supported for Haiku.", priority: 35 });
  upsertModel(models, { slug: "sonnet", description: "Claude Code model alias.", priority: 30 });
  upsertModel(models, { slug: "opus", description: "Claude Code model alias.", priority: 20 });
  return models;
}

function addObservedModel(models: Set<string>, value: string | null | undefined): void {
  const slug = normalizeObservedClaudeModel(value);
  if (slug !== null) {
    models.add(slug);
  }
}

function collectModelKeys(value: unknown, models: Set<string>): void {
  const record = objectRecord(value);
  if (record === null) return;
  for (const key of Object.keys(record)) {
    addObservedModel(models, key);
  }
}

async function readStatsCacheModels(models: Set<string>): Promise<void> {
  const raw = await readFile(path.join(claudeHomeDir(), "stats-cache.json"), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const root = objectRecord(parsed);
  if (root === null) return;

  collectModelKeys(root.modelUsage, models);

  if (Array.isArray(root.dailyModelTokens)) {
    for (const entry of root.dailyModelTokens) {
      const record = objectRecord(entry);
      if (record !== null) {
        collectModelKeys(record.tokensByModel, models);
      }
    }
  }
}

function extractAssistantModelFromJsonlLine(line: string): string | null {
  const parsed = JSON.parse(line) as unknown;
  const root = objectRecord(parsed);
  const message = objectRecord(root?.message);
  if (message === null) return null;
  const role = stringValue(message.role);
  if (role !== null && role !== "assistant") return null;
  return normalizeObservedClaudeModel(stringValue(message.model));
}

async function readProjectLogModels(models: Set<string>): Promise<void> {
  const root = path.join(claudeHomeDir(), "projects");
  const files: { pathname: string; mtimeMs: number; size: number }[] = [];
  const pendingDirs = [root];

  while (pendingDirs.length > 0 && files.length < maxProjectLogFiles * 4) {
    const current = pendingDirs.shift();
    if (current === undefined) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pathname = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(pathname);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const info = await stat(pathname);
        if (info.size > 0 && info.size <= maxProjectLogBytes) {
          files.push({ pathname, mtimeMs: info.mtimeMs, size: info.size });
        }
      } catch {
      }
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(0, maxProjectLogFiles)) {
    let raw: string;
    try {
      raw = await readFile(file.pathname, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      try {
        addObservedModel(models, extractAssistantModelFromJsonlLine(line));
      } catch {
      }
    }
  }
}

async function discoverClaudeModels(): Promise<ClaudeDiscovery> {
  const settings = await readProviderSettings(claudeSettingsPath());
  const observedModels = new Set<string>();
  let discoveryError: string | null = null;

  try {
    await readStatsCacheModels(observedModels);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ENOENT") {
      discoveryError = error instanceof Error ? error.message : "Unable to read Claude stats cache.";
    }
  }

  try {
    await readProjectLogModels(observedModels);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to read Claude project logs.";
    discoveryError = discoveryError === null ? message : `${discoveryError}; ${message}`;
  }

  return {
    observedModels,
    settingsModel: stringSetting(settings, "model"),
    settingsEffort: stringSetting(settings, "effortLevel"),
    settingsError: settings.error,
    settingsExists: settings.exists,
    error: discoveryError,
  };
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

function sortModels(models: Map<string, CodexModelOption>): CodexModelOption[] {
  return Array.from(models.values()).sort((a, b) => b.priority - a.priority || a.displayName.localeCompare(b.displayName));
}

function configuredDefaultModel(configuredModel: string, settingsModel: string | null): string | null {
  return configuredModel.length > 0 ? configuredModel : settingsModel;
}

function configuredDefaultEffort(configuredEffort: string, settingsEffort: string | null): string | null {
  return configuredEffort.length > 0 ? configuredEffort : settingsEffort;
}

function optionsFromDiscovery(discovery: ClaudeDiscovery): CodexRuntimeOptions {
  const config = getConfig();
  const configuredModel = config.claudeModel.trim();
  const configuredEffort = config.claudeEffort.trim();
  const defaultModel = configuredDefaultModel(configuredModel, discovery.settingsModel);
  const defaultEffort = configuredDefaultEffort(configuredEffort, discovery.settingsEffort);
  const models = builtInClaudeModels();

  upsertModel(models, { slug: discovery.settingsModel, description: "Current Claude Code settings model.", priority: 70 });
  upsertModel(models, { slug: configuredModel, description: "Configured CLAUDE_MODEL value.", priority: 65 });

  let priority = 60;
  for (const slug of Array.from(discovery.observedModels).sort((a, b) => displayNameForModel(a).localeCompare(displayNameForModel(b)))) {
    upsertModel(models, { slug, description: "Observed in local Claude Code runtime usage.", priority });
    priority -= 1;
  }

  const source: CodexRuntimeOptions["source"] = discovery.observedModels.size > 0
    ? "observed"
    : discovery.settingsExists || configuredModel.length > 0
      ? "cache"
      : "bundled";

  return {
    models: sortModels(models),
    defaults: {
      model: defaultModel,
      reasoningEffort: supportsClaudeEffort(defaultModel) ? defaultEffort : null,
      serviceTier: null,
      sandboxMode: "workspace-write" as ExecutorSandboxMode,
      networkAccess: null,
      timeoutMs: config.claudeTimeoutMs,
    },
    source,
    fetchedAt: new Date().toISOString(),
    error: discovery.settingsError ?? discovery.error,
  };
}

function withCurrentDefaults(options: CodexRuntimeOptions): CodexRuntimeOptions {
  const config = getConfig();
  const configuredModel = config.claudeModel.trim();
  const configuredEffort = config.claudeEffort.trim();
  const defaultModel = configuredModel.length > 0 ? configuredModel : options.defaults.model;
  const defaultEffort = configuredEffort.length > 0 ? configuredEffort : options.defaults.reasoningEffort;
  return {
    ...options,
    defaults: {
      ...options.defaults,
      model: defaultModel,
      reasoningEffort: supportsClaudeEffort(defaultModel) ? defaultEffort : null,
      serviceTier: options.defaults.serviceTier ?? null,
      timeoutMs: config.claudeTimeoutMs,
    },
  };
}

export async function getClaudeRuntimeOptions(input: { forceRefresh?: boolean } = {}): Promise<CodexRuntimeOptions> {
  const now = Date.now();
  if (!input.forceRefresh && memoryCache !== null && memoryCache.expiresAt > now) {
    return withCurrentDefaults(memoryCache.options);
  }

  try {
    const options = optionsFromDiscovery(await discoverClaudeModels());
    memoryCache = { expiresAt: now + memoryTtlMs, options };
    await writePersistedCatalog(options);
    return options;
  } catch (error) {
    const cached = await readPersistedCatalog();
    if (cached !== null) {
      const options = {
        ...withCurrentDefaults(cached),
        error: error instanceof Error ? error.message : "Unable to refresh Claude Code model catalog.",
      };
      memoryCache = { expiresAt: now + memoryTtlMs, options };
      return options;
    }

    const config = getConfig();
    return {
      models: sortModels(builtInClaudeModels()),
      defaults: {
        model: config.claudeModel.trim().length > 0 ? config.claudeModel.trim() : null,
        reasoningEffort: config.claudeEffort.trim().length > 0 ? config.claudeEffort.trim() : null,
        serviceTier: null,
        sandboxMode: "workspace-write" as ExecutorSandboxMode,
        networkAccess: null,
        timeoutMs: config.claudeTimeoutMs,
      },
      source: "bundled",
      fetchedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Unable to read Claude Code model catalog.",
    };
  }
}

export async function validateClaudeModelEffort(input: {
  model: string | null;
  reasoningEffort: string | null;
  serviceTier?: string | null;
}): Promise<{ model: string | null; reasoningEffort: string | null; serviceTier: string | null; reason: string | null }> {
  const options = await getClaudeRuntimeOptions();
  const model = input.model?.trim() ? input.model.trim() : null;
  const effectiveModel = model ?? options.defaults.model;
  const reasoningEffort = input.reasoningEffort?.trim() ? input.reasoningEffort.trim() : null;
  const requestedServiceTier = input.serviceTier?.trim() ? input.serviceTier.trim() : null;
  const allowedEfforts = new Set(claudeEfforts);
  const effortSupported = supportsClaudeEffort(effectiveModel);
  const normalizedEffort = reasoningEffort === null || !effortSupported || allowedEfforts.has(reasoningEffort)
    ? effortSupported ? reasoningEffort : null
    : null;
  const effortReason = reasoningEffort !== null && normalizedEffort === null
    ? effortSupported
      ? `Claude effort '${reasoningEffort}' is not supported; using the configured default.`
      : `Claude model '${effectiveModel ?? "default"}' does not support effort selection; clearing effort.`
    : null;
  const normalizedServiceTier = requestedServiceTier === null || requestedServiceTier === standardServiceTier || (requestedServiceTier === "fast" && supportsClaudeFast(effectiveModel))
    ? requestedServiceTier
    : null;
  const tierReason = requestedServiceTier !== null && normalizedServiceTier === null
    ? `Claude service tier '${requestedServiceTier}' is not supported for '${effectiveModel ?? "default"}'; using the configured default.`
    : null;
  const reason = effortReason ?? tierReason;

  if (model === null) {
    return { model: null, reasoningEffort: normalizedEffort, serviceTier: normalizedServiceTier, reason };
  }

  if (options.models.some((candidate) => candidate.slug === model)) {
    return { model, reasoningEffort: normalizedEffort, serviceTier: normalizedServiceTier, reason };
  }

  return {
    model,
    reasoningEffort: normalizedEffort,
    serviceTier: normalizedServiceTier,
    reason,
  };
}
