import { getConfig } from "@/lib/server/config";
import type {
  ChatMessage,
  ChatModelClient,
  ChatModelDoctorResult,
  ChatModelOption,
  ChatRequestOptions,
  ChatToolCall,
  ChatTurnResult,
} from "@/lib/server/runtime/chat-model-client";

export class OllamaToolsUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaToolsUnsupportedError";
  }
}

function looksLikeToolsUnsupported(message: string): boolean {
  return /does not support tools|registry.*tools|template.*tools/i.test(message);
}

interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}

interface OllamaChatResponse {
  message?: { role?: string; content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  error?: string;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagModel {
  name?: string;
  model?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string };
}

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function mapToolCalls(raw: OllamaToolCall[] | undefined): ChatToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const calls: ChatToolCall[] = [];
  for (const entry of raw) {
    const name = entry.function?.name;
    if (typeof name === "string" && name.trim().length > 0) {
      calls.push({ name: name.trim(), arguments: normalizeToolArguments(entry.function?.arguments) });
    }
  }
  return calls;
}

function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    wire.tool_calls = message.toolCalls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }));
  }
  if (message.role === "tool" && message.toolName !== undefined) {
    wire.tool_name = message.toolName;
  }
  return wire;
}

export function createOllamaClient(): ChatModelClient {
  const baseUrl = getConfig().ollamaBaseUrl;

  async function chat(model: string, messages: ChatMessage[], options: ChatRequestOptions): Promise<ChatTurnResult> {
    const ownController = new AbortController();
    const timeout = setTimeout(() => ownController.abort("timeout"), options.timeoutMs);
    const onParentAbort = (): void => ownController.abort(options.signal?.reason ?? "aborted");
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        ownController.abort(options.signal.reason ?? "aborted");
      } else {
        options.signal.addEventListener("abort", onParentAbort, { once: true });
      }
    }

    const modelOptions: Record<string, unknown> = {};
    if (typeof options.temperature === "number") {
      modelOptions.temperature = options.temperature;
    }
    if (typeof options.numCtx === "number" && options.numCtx > 0) {
      modelOptions.num_ctx = options.numCtx;
    }

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(toWireMessage),
      stream: false,
      keep_alive: options.keepAlive ?? "5m",
    };
    if (Object.keys(modelOptions).length > 0) {
      body.options = modelOptions;
    }
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }

    try {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ownController.signal,
      });
      const json = (await response.json()) as OllamaChatResponse;
      if (!response.ok || typeof json.error === "string") {
        const message = json.error ?? `Ollama /api/chat failed with HTTP ${response.status}.`;
        if (body.tools !== undefined && looksLikeToolsUnsupported(message)) {
          throw new OllamaToolsUnsupportedError(message);
        }
        throw new Error(message);
      }
      return {
        content: typeof json.message?.content === "string" ? json.message.content : "",
        toolCalls: mapToolCalls(json.message?.tool_calls),
        reasoning: typeof json.message?.thinking === "string" && json.message.thinking.trim().length > 0
          ? json.message.thinking.trim()
          : undefined,
        usage: {
          promptTokens: typeof json.prompt_eval_count === "number" ? json.prompt_eval_count : null,
          outputTokens: typeof json.eval_count === "number" ? json.eval_count : null,
        },
      };
    } finally {
      clearTimeout(timeout);
      if (options.signal !== undefined) {
        options.signal.removeEventListener("abort", onParentAbort);
      }
    }
  }

  async function listModels(): Promise<ChatModelOption[]> {
    const response = await fetch(`${baseUrl}/api/tags`, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Ollama /api/tags failed with HTTP ${response.status}.`);
    }
    const json = (await response.json()) as { models?: OllamaTagModel[] };
    const models = Array.isArray(json.models) ? json.models : [];
    return models
      .map((entry): ChatModelOption | null => {
        const name = entry.name ?? entry.model;
        if (typeof name !== "string" || name.trim().length === 0) {
          return null;
        }
        return {
          name: name.trim(),
          family: entry.details?.family ?? null,
          parameterSize: entry.details?.parameter_size ?? null,
          quantization: entry.details?.quantization_level ?? null,
          supportsTools: null,
          contextLength: null,
        };
      })
      .filter((entry): entry is ChatModelOption => entry !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function showModelContextLength(model: string): Promise<number | null> {
    const trimmed = model.trim();
    if (trimmed.length === 0) {
      return null;
    }
    try {
      const response = await fetch(`${baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: trimmed }),
      });
      if (!response.ok) {
        return null;
      }
      const json = (await response.json()) as { model_info?: Record<string, unknown> };
      const info = json.model_info;
      if (typeof info !== "object" || info === null) {
        return null;
      }
      for (const [key, value] of Object.entries(info)) {
        if (key.endsWith(".context_length") && typeof value === "number" && Number.isFinite(value) && value > 0) {
          return Math.round(value);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async function doctor(): Promise<ChatModelDoctorResult> {
    const config = getConfig();
    const checkedAt = new Date().toISOString();
    let version: string | null = null;
    try {
      const versionResponse = await fetch(`${baseUrl}/api/version`, { method: "GET" });
      if (versionResponse.ok) {
        const json = (await versionResponse.json()) as { version?: string };
        version = typeof json.version === "string" ? json.version : null;
      }
    } catch {
      version = null;
    }
    try {
      const models = await listModels();
      const defaultModel = config.ollamaModel.trim();
      return {
        available: true,
        baseUrl,
        version,
        modelCount: models.length,
        defaultModelPresent: defaultModel.length === 0 || models.some((model) => model.name === defaultModel),
        error: models.length === 0 ? "Ollama is reachable but no models are installed (run `ollama pull <model>`)." : null,
        checkedAt,
      };
    } catch (error) {
      return {
        available: false,
        baseUrl,
        version,
        modelCount: 0,
        defaultModelPresent: false,
        error: error instanceof Error ? error.message : "Ollama is not reachable.",
        checkedAt,
      };
    }
  }

  return { kind: "ollama", chat, listModels, showModelContextLength, doctor };
}
