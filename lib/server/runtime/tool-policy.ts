import type { ToolCatalogEntry, ToolPolicyMode } from "@/lib/shared/types";
import { toolCatalogForMode } from "@/lib/server/runtime/tool-catalog";

export interface ToolPolicyDecision {
  allowed: boolean;
  reason: string;
}

export function decideToolPolicy(input: {
  mode: ToolPolicyMode;
  toolName: string;
  catalog?: ToolCatalogEntry[];
}): ToolPolicyDecision {
  const catalog = input.catalog ?? toolCatalogForMode(input.mode);
  const entry = catalog.find((candidate) => candidate.id === input.toolName);
  if (entry === undefined) {
    return { allowed: false, reason: `Tool '${input.toolName}' is not registered for ${input.mode} mode.` };
  }
  if (!entry.mode.includes(input.mode)) {
    return { allowed: false, reason: `Tool '${input.toolName}' is not allowed in ${input.mode} mode.` };
  }
  if ((input.mode === "plan" || input.mode === "research") && entry.mutability !== "read" && entry.mutability !== "finish") {
    return { allowed: false, reason: `Tool '${input.toolName}' mutates the workspace and is blocked in ${input.mode} mode.` };
  }
  return { allowed: true, reason: "Allowed by tool policy." };
}

export function renderToolPolicySummary(mode: ToolPolicyMode): string {
  const entries = toolCatalogForMode(mode);
  const lines = entries.map((entry) => `- ${entry.id}: ${entry.mutability}, risk ${entry.risk}`);
  return `Active tool policy: ${mode}\n${lines.join("\n")}`;
}
