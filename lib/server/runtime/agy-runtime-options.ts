import { getConfig } from "@/lib/server/config";
import { resolveAgyCliBin } from "@/lib/server/runtime/agy-cli-resolver";
import { agySettingsPath, readProviderSettings, stringSetting, writeProviderSettings } from "@/lib/server/runtime/provider-settings";
import type { CodexModelOption, CodexRuntimeOptions, ExecutorSandboxMode } from "@/lib/shared/types";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

interface AgyModelDiscovery {
  models: Set<string>;
  source: "observed" | "cache" | "bundled";
  error: string | null;
}

let cachedDiscovery: { expiresAt: number; result: AgyModelDiscovery } | null = null;

function agyModelOption(input: { slug: string; description: string; priority: number }): CodexModelOption {
  return {
    slug: input.slug,
    displayName: input.slug,
    description: input.description,
    defaultReasoningLevel: null,
    supportedReasoningLevels: [],
    supportedInApi: true,
    visibility: "list",
    priority: input.priority,
    contextWindow: null,
    serviceTiers: [],
    defaultServiceTier: null,
  };
}

function upsertModel(models: Map<string, CodexModelOption>, input: { slug: string | null; description: string; priority: number }): void {
  const slug = input.slug?.trim();
  if (slug === undefined || slug.length === 0) return;
  const existing = models.get(slug);
  if (existing !== undefined && existing.priority >= input.priority) return;
  models.set(slug, agyModelOption({ slug, description: input.description, priority: input.priority }));
}

function agyAppDataDir(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

function addModelLabel(models: Set<string>, value: string | null | undefined): void {
  const label = value?.replace(/\s+/g, " ").trim();
  if (label === undefined || label.length === 0 || label.length > 80) return;
  if (!/(Gemini|Claude|Sonnet|Opus|Haiku)/i.test(label)) return;
  models.add(label.replace(/\.$/, ""));
}

function extractAgyModelLabels(text: string, models: Set<string>): void {
  for (const match of text.matchAll(/label="([^"]+)"/g)) {
    addModelLabel(models, match[1]);
  }
  for (const match of text.matchAll(/Model Selection` from [^<\n]+? to ([^<\n]+?)\. No need/g)) {
    addModelLabel(models, match[1]);
  }
}

function extractAgyDefaultModelKeys(text: string, models: Set<string>): void {
  const normalized = text.toLowerCase();
  for (const match of normalized.matchAll(/claude-(sonnet|opus|haiku)-(\d)-(\d)@default/g)) {
    addModelLabel(models, `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}.${match[3]}`);
  }
}

async function readInstalledClientModelKeys(models: Set<string>): Promise<void> {
  const executable = await resolveAgyCliBin();
  if (!path.isAbsolute(executable.command)) return;
  const info = await stat(executable.command).catch(() => null);
  if (info === null || !info.isFile() || info.size <= 0 || info.size > 250_000_000) return;
  extractAgyDefaultModelKeys((await readFile(executable.command)).toString("latin1"), models);
}

async function readRecentTextFiles(root: string, models: Set<string>, remaining: { count: number }): Promise<void> {
  if (remaining.count <= 0) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const files: { pathname: string; mtimeMs: number; size: number }[] = [];
  const dirs: string[] = [];
  for (const entry of entries) {
    const pathname = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!["node_modules", "mcp", "bin"].includes(entry.name)) dirs.push(pathname);
      continue;
    }
    if (!entry.isFile() || !/\.(json|jsonl|log|txt)$/i.test(entry.name)) continue;
    try {
      const info = await stat(pathname);
      if (info.size > 2_000_000) continue;
      files.push({ pathname, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const file of files.slice(0, remaining.count)) {
    try {
      extractAgyModelLabels(await readFile(file.pathname, "utf8"), models);
      remaining.count -= 1;
    } catch {
    }
    if (remaining.count <= 0) return;
  }
  for (const dir of dirs.slice(0, 40)) {
    await readRecentTextFiles(dir, models, remaining);
    if (remaining.count <= 0) return;
  }
}

async function discoverAgyModels(settingsModel: string | null, input: { forceRefresh?: boolean } = {}): Promise<AgyModelDiscovery> {
  const now = Date.now();
  if (!input.forceRefresh && cachedDiscovery !== null && cachedDiscovery.expiresAt > now) {
    const models = new Set(cachedDiscovery.result.models);
    addModelLabel(models, settingsModel);
    return { ...cachedDiscovery.result, models };
  }

  const models = new Set<string>();
  addModelLabel(models, settingsModel);
  let error: string | null = null;
  try {
    await readRecentTextFiles(agyAppDataDir(), models, { count: 120 });
    await readInstalledClientModelKeys(models);
  } catch (discoveryError) {
    error = discoveryError instanceof Error ? discoveryError.message : "Unable to discover AGY models from local client artifacts.";
  }
  const result: AgyModelDiscovery = {
    models,
    source: models.size > (settingsModel === null ? 0 : 1) ? "observed" : models.size > 0 ? "cache" : "bundled",
    error,
  };
  cachedDiscovery = { expiresAt: now + 5 * 60 * 1000, result };
  return result;
}

export async function getAgyRuntimeOptions(input: { forceRefresh?: boolean } = {}): Promise<CodexRuntimeOptions> {
  const config = getConfig();
  const settings = await readProviderSettings(agySettingsPath());
  const settingsModel = stringSetting(settings, "model");
  const discovery = await discoverAgyModels(settingsModel, input);
  const models = new Map<string, CodexModelOption>();
  upsertModel(models, { slug: settingsModel, description: "Current Antigravity CLI settings model.", priority: 50 });
  let priority = 45;
  for (const model of discovery.models) {
    upsertModel(models, { slug: model, description: "Observed in local Antigravity CLI settings, logs, or installed-client default keys.", priority });
    priority -= 1;
  }
  return {
    models: Array.from(models.values()).sort((a, b) => b.priority - a.priority || a.displayName.localeCompare(b.displayName)),
    defaults: {
      model: settingsModel,
      reasoningEffort: null,
      serviceTier: null,
      sandboxMode: "workspace-write" as ExecutorSandboxMode,
      networkAccess: null,
      timeoutMs: config.agyTimeoutMs,
    },
    source: discovery.source === "bundled" && settings.exists ? "cache" : discovery.source,
    fetchedAt: new Date().toISOString(),
    error: settings.error ?? discovery.error,
  };
}

export async function validateAgyRuntimeOverrides(input: {
  model: string | null;
}): Promise<{ model: string | null; reasoningEffort: null; reason: string | null }> {
  const model = input.model?.trim() ? input.model.trim() : null;
  return {
    model,
    reasoningEffort: null,
    reason: null,
  };
}

export async function applyAgyRuntimeModel(model: string | null): Promise<{ model: string | null; changed: boolean; settingsPath: string; error: string | null }> {
  const normalized = model?.trim() ? model.trim() : null;
  if (normalized === null) {
    return { model: null, changed: false, settingsPath: agySettingsPath(), error: null };
  }
  const settings = await readProviderSettings(agySettingsPath());
  if (settings.error !== null) {
    return { model: normalized, changed: false, settingsPath: settings.path, error: settings.error };
  }
  if (stringSetting(settings, "model") === normalized) {
    return { model: normalized, changed: false, settingsPath: settings.path, error: null };
  }
  await writeProviderSettings(settings.path, { ...settings.data, model: normalized });
  return { model: normalized, changed: true, settingsPath: settings.path, error: null };
}
