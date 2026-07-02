export type CodexAppServerMessage =
  | { kind: "response"; id: number; result: Record<string, unknown>; error: Record<string, unknown> | null }
  | { kind: "server_request"; id: number; method: string; params: Record<string, unknown> }
  | { kind: "notification"; method: string; params: Record<string, unknown> }
  | { kind: "invalid"; reason: string };

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function decodeCodexAppServerLine(line: string): CodexAppServerMessage {
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    const record = asRecord(parsed);
    if (record === null) {
      return { kind: "invalid", reason: "JSON-RPC message was not an object." };
    }
    message = record;
  } catch {
    return { kind: "invalid", reason: "Line was not valid JSON." };
  }

  const id = typeof message.id === "number" ? message.id : null;
  const method = typeof message.method === "string" ? message.method : null;
  const params = asRecord(message.params) ?? {};

  if (id !== null && method === null) {
    return {
      kind: "response",
      id,
      result: asRecord(message.result) ?? {},
      error: asRecord(message.error),
    };
  }
  if (id !== null && method !== null) {
    return { kind: "server_request", id, method, params };
  }
  if (method !== null) {
    return { kind: "notification", method, params };
  }
  return { kind: "invalid", reason: "Message had neither response id nor method." };
}

export function codexErrorMessage(error: Record<string, unknown> | null, fallback: string): string {
  return typeof error?.message === "string" && error.message.trim().length > 0 ? error.message : fallback;
}
