import type { AgentProvider, CodexRuntimeOptions, RuntimeOverrides } from "@/lib/shared/types";

export interface RuntimeOverrideValidation {
  runtimeOverrides: RuntimeOverrides;
  validationNote: string | null;
}

export interface RuntimeProviderPlugin {
  id: AgentProvider;
  displayName: string;
  getOptions(input?: { forceRefresh?: boolean }): Promise<CodexRuntimeOptions>;
  validateOverrides(overrides: RuntimeOverrides): Promise<RuntimeOverrideValidation>;
}
