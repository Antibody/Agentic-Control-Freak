import { getConfig } from "@/lib/server/config";
import { createOllamaClient } from "@/lib/server/runtime/ollama-client";
import type { CodexModelOption, CodexRuntimeOptions, ExecutorSandboxMode } from "@/lib/shared/types";


const memoryTtlMs = 60 * 1000;
let memoryCache: { expiresAt: number; options: CodexRuntimeOptions } | null = null;

function modelDisplayName(name: string, parameterSize: string | null, quantization: string | null): string {
  const suffix = [parameterSize, quantization].filter((part): part is string => typeof part === "string" && part.length > 0).join(" · ");
  return suffix.length > 0 ? `${name} (${suffix})` : name;
}

export async function getOllamaRuntimeOptions(input: { forceRefresh?: boolean } = {}): Promise<CodexRuntimeOptions> {
  const config = getConfig();
  const now = Date.now();
  const defaults: CodexRuntimeOptions["defaults"] = {
    model: config.ollamaModel.trim().length > 0 ? config.ollamaModel.trim() : null,
    reasoningEffort: null,
    serviceTier: null,
    sandboxMode: "workspace-write" as ExecutorSandboxMode,
    networkAccess: null,
    timeoutMs: config.ollamaTimeoutMs,
  };

  if (!input.forceRefresh && memoryCache !== null && memoryCache.expiresAt > now) {
    return { ...memoryCache.options, defaults };
  }

  try {
    const models = await createOllamaClient().listModels();
    const compact: CodexModelOption[] = models.map((model) => ({
      slug: model.name,
      displayName: modelDisplayName(model.name, model.parameterSize, model.quantization),
      description: model.family,
      defaultReasoningLevel: null,
      supportedReasoningLevels: [],
      supportedInApi: true,
      visibility: "list",
      priority: 0,
      contextWindow: model.contextLength,
      serviceTiers: [],
      defaultServiceTier: null,
    }));
    const options: CodexRuntimeOptions = {
      models: compact,
      defaults,
      source: "live",
      fetchedAt: new Date().toISOString(),
      error: compact.length === 0 ? "Ollama is reachable but has no installed models. Run `ollama pull <model>`." : null,
    };
    memoryCache = { expiresAt: now + memoryTtlMs, options };
    return options;
  } catch (error) {
    return {
      models: [],
      defaults,
      source: "empty",
      fetchedAt: null,
      error: error instanceof Error ? error.message : "Unable to reach Ollama.",
    };
  }
}

export async function validateOllamaModel(model: string | null): Promise<{ model: string | null; reason: string | null }> {
  const trimmed = model?.trim() ? model.trim() : null;
  if (trimmed === null) {
    return { model: null, reason: null };
  }
  const options = await getOllamaRuntimeOptions();
  if (options.models.length === 0) {
    return { model: trimmed, reason: null };
  }
  if (options.models.some((candidate) => candidate.slug === trimmed)) {
    return { model: trimmed, reason: null };
  }
  return { model: null, reason: `Ollama model '${trimmed}' is not installed; using the configured default. Run \`ollama pull ${trimmed}\`.` };
}
