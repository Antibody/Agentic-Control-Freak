
export interface ChatToolParameterSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; items?: { type: string } }>;
  required?: string[];
}

export interface ChatToolDef {
  name: string;
  description: string;
  parameters: ChatToolParameterSchema;
}

export interface ChatToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ChatToolCall[];
  toolName?: string;
}

export interface ChatTokenUsage {
  promptTokens: number | null;
  outputTokens: number | null;
}

export interface ChatTurnResult {
  content: string;
  toolCalls: ChatToolCall[];
  reasoning?: string;
  usage?: ChatTokenUsage;
}

export interface ChatModelOption {
  name: string;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  supportsTools: boolean | null;
  contextLength: number | null;
}

export interface ChatModelDoctorResult {
  available: boolean;
  baseUrl: string;
  version: string | null;
  modelCount: number;
  defaultModelPresent: boolean;
  error: string | null;
  checkedAt: string;
}

export interface ChatRequestOptions {
  temperature?: number | null;
  numCtx?: number | null;
  keepAlive?: string;
  tools?: ChatToolDef[];
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ChatModelClient {
  readonly kind: "ollama";
  chat(model: string, messages: ChatMessage[], options: ChatRequestOptions): Promise<ChatTurnResult>;
  listModels(): Promise<ChatModelOption[]>;
  showModelContextLength(model: string): Promise<number | null>;
  doctor(): Promise<ChatModelDoctorResult>;
}
