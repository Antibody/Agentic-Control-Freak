import type { ChatToolDef } from "@/lib/server/runtime/chat-model-client";
import type { ToolCatalogEntry, ToolPolicyMode } from "@/lib/shared/types";

export const ollamaWorkspaceToolCatalog: ToolCatalogEntry[] = [
  {
    id: "list_dir",
    description: "List files and subdirectories of a directory inside the workspace. Use '.' for the workspace root.",
    providerSupport: ["ollama"],
    mode: ["plan", "research", "execute", "repair"],
    mutability: "read",
    workspaceScope: "workspace",
    risk: "low",
    promptCost: "low",
  },
  {
    id: "read_file",
    description: "Read the UTF-8 contents of a file inside the workspace before editing it.",
    providerSupport: ["ollama"],
    mode: ["plan", "research", "execute", "repair"],
    mutability: "read",
    workspaceScope: "workspace",
    risk: "low",
    promptCost: "medium",
  },
  {
    id: "write_file",
    description: "Create or overwrite a file inside the workspace with the full new contents. Always pass the complete file, not a fragment.",
    providerSupport: ["ollama"],
    mode: ["execute", "repair"],
    mutability: "write",
    workspaceScope: "workspace",
    risk: "medium",
    promptCost: "medium",
  },
  {
    id: "delete_file",
    description: "Delete a file inside the workspace.",
    providerSupport: ["ollama"],
    mode: ["execute", "repair"],
    mutability: "delete",
    workspaceScope: "workspace",
    risk: "high",
    promptCost: "low",
  },
  {
    id: "finish",
    description: "Call this once the task is complete. Provide a concise summary of what changed and how to verify it.",
    providerSupport: ["ollama"],
    mode: ["plan", "research", "execute", "repair"],
    mutability: "finish",
    workspaceScope: "workspace",
    risk: "low",
    promptCost: "low",
  },
];

export function toolCatalogForMode(mode: ToolPolicyMode): ToolCatalogEntry[] {
  return ollamaWorkspaceToolCatalog.filter((entry) => entry.mode.includes(mode));
}

export function ollamaToolDefinitionsForMode(mode: ToolPolicyMode): ChatToolDef[] {
  return toolCatalogForMode(mode).map((entry) => {
    if (entry.id === "write_file") {
      const definition: ChatToolDef = {
        name: entry.id,
        description: entry.description,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            content: { type: "string", description: "The complete file contents." },
          },
          required: ["path", "content"],
        },
      };
      return definition;
    }
    if (entry.id === "finish") {
      const definition: ChatToolDef = {
        name: entry.id,
        description: entry.description,
        parameters: { type: "object", properties: { summary: { type: "string", description: "Summary of the work performed." } }, required: ["summary"] },
      };
      return definition;
    }
    const definition: ChatToolDef = {
      name: entry.id,
      description: entry.description,
      parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path." } }, required: entry.id === "list_dir" ? [] : ["path"] },
    };
    return definition;
  });
}
