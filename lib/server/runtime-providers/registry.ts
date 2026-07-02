import { getAgyRuntimeOptions, validateAgyRuntimeOverrides } from "@/lib/server/runtime/agy-runtime-options";
import { getClaudeRuntimeOptions, validateClaudeModelEffort } from "@/lib/server/runtime/claude-model-catalog";
import { getCodexRuntimeOptions, validateCodexModelReasoning } from "@/lib/server/runtime/codex-model-catalog";
import { getOllamaRuntimeOptions, validateOllamaModel } from "@/lib/server/runtime/ollama-model-catalog";
import type { RuntimeProviderPlugin } from "@/lib/server/runtime-providers/contracts";
import type { AgentProvider, RuntimeOverrides } from "@/lib/shared/types";

function clearCodexOnlyFields(overrides: RuntimeOverrides): void {
  overrides.sandboxMode = null;
  overrides.networkAccess = null;
  overrides.codexTransportMode = null;
}

function clearOllamaFields(overrides: RuntimeOverrides): void {
  overrides.temperature = null;
  overrides.numCtx = null;
}

const providers: RuntimeProviderPlugin[] = [
  {
    id: "codex-cli",
    displayName: "Codex CLI",
    getOptions: getCodexRuntimeOptions,
    validateOverrides: async (overrides) => {
      const validated = await validateCodexModelReasoning({
        model: overrides.model,
        reasoningEffort: overrides.reasoningEffort,
        serviceTier: overrides.serviceTier,
      });
      overrides.model = validated.model;
      overrides.reasoningEffort = validated.reasoningEffort;
      overrides.serviceTier = validated.serviceTier;
      clearOllamaFields(overrides);
      return { runtimeOverrides: overrides, validationNote: validated.reason };
    },
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    getOptions: getClaudeRuntimeOptions,
    validateOverrides: async (overrides) => {
      const validated = await validateClaudeModelEffort({
        model: overrides.model,
        reasoningEffort: overrides.reasoningEffort,
        serviceTier: overrides.serviceTier,
      });
      overrides.model = validated.model;
      overrides.reasoningEffort = validated.reasoningEffort;
      overrides.serviceTier = validated.serviceTier;
      clearCodexOnlyFields(overrides);
      clearOllamaFields(overrides);
      return { runtimeOverrides: overrides, validationNote: validated.reason };
    },
  },
  {
    id: "antigravity-cli",
    displayName: "Antigravity CLI",
    getOptions: getAgyRuntimeOptions,
    validateOverrides: async (overrides) => {
      const validated = await validateAgyRuntimeOverrides({ model: overrides.model });
      overrides.model = validated.model;
      overrides.reasoningEffort = validated.reasoningEffort;
      overrides.serviceTier = null;
      clearCodexOnlyFields(overrides);
      clearOllamaFields(overrides);
      return { runtimeOverrides: overrides, validationNote: validated.reason };
    },
  },
  {
    id: "ollama",
    displayName: "Ollama",
    getOptions: getOllamaRuntimeOptions,
    validateOverrides: async (overrides) => {
      const validated = await validateOllamaModel(overrides.model);
      overrides.model = validated.model;
      overrides.reasoningEffort = null;
      overrides.serviceTier = null;
      clearCodexOnlyFields(overrides);
      return { runtimeOverrides: overrides, validationNote: validated.reason };
    },
  },
];

export function runtimeProviderPlugins(): RuntimeProviderPlugin[] {
  return providers;
}

export function runtimeProviderIds(): AgentProvider[] {
  return providers.map((provider) => provider.id);
}

export function runtimeProviderFor(provider: AgentProvider): RuntimeProviderPlugin {
  const found = providers.find((candidate) => candidate.id === provider);
  if (found === undefined) {
    throw new Error(`Runtime provider is not registered: ${provider}`);
  }
  return found;
}
