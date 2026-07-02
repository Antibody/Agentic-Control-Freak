import { appendFile, mkdir, stat, truncate } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/server/config";
import { redactSecrets } from "@/lib/server/secret-redaction";
import type { JsonObject } from "@/lib/shared/types";

interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  attributes: JsonObject;
  status: "ok" | "error";
  error: string | null;
}

export interface TraceHandle {
  traceId: string;
  spanId: string;
  end: (input?: { status?: "ok" | "error"; error?: unknown; attributes?: JsonObject }) => Promise<void>;
}

const maxTraceBytes = 8 * 1024 * 1024;

function traceFilePath(): string {
  return path.join(path.dirname(getConfig().artifactsDir), "traces", "server.trace.ndjson");
}

function sanitizeJsonObject(input: JsonObject | undefined): JsonObject {
  const result: JsonObject = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string") {
      const redacted = redactSecrets(value);
      result[key] = redacted.length > 1000 ? `${redacted.slice(0, 1000)}...` : redacted;
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      result[key] = value;
    } else if (Array.isArray(value)) {
      result[key] = value.slice(0, 50).map((entry) =>
        typeof entry === "string" ? (entry.length > 300 ? `${redactSecrets(entry).slice(0, 300)}...` : redactSecrets(entry)) : entry
      ) as JsonObject[keyof JsonObject];
    } else if (typeof value === "object" && value !== null) {
      result[key] = value;
    }
  }
  return result;
}

async function appendSpan(span: TraceSpan): Promise<void> {
  const filePath = traceFilePath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const existing = await stat(filePath).catch(() => null);
  if (existing !== null && existing.size > maxTraceBytes) {
    await truncate(filePath, 0).catch(() => undefined);
  }
  await appendFile(filePath, `${JSON.stringify(span)}\n`, "utf8").catch(() => undefined);
}

export function startTraceSpan(input: {
  name: string;
  traceId?: string;
  parentSpanId?: string | null;
  attributes?: JsonObject;
}): TraceHandle {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const traceId = input.traceId ?? randomUUID();
  const spanId = randomUUID();
  let ended = false;
  return {
    traceId,
    spanId,
    end: async (endInput = {}) => {
      if (ended) return;
      ended = true;
      const endedAtMs = Date.now();
      const errorMessage = endInput.error instanceof Error
        ? endInput.error.message
        : endInput.error === undefined || endInput.error === null
          ? null
          : String(endInput.error);
      await appendSpan({
        traceId,
        spanId,
        parentSpanId: input.parentSpanId ?? null,
        name: input.name,
        startedAt,
        endedAt: new Date(endedAtMs).toISOString(),
        durationMs: endedAtMs - startedAtMs,
        attributes: sanitizeJsonObject({ ...(input.attributes ?? {}), ...(endInput.attributes ?? {}) }),
        status: endInput.status ?? (errorMessage === null ? "ok" : "error"),
        error: errorMessage === null ? null : redactSecrets(errorMessage),
      });
    },
  };
}

export async function traced<T>(input: {
  name: string;
  attributes?: JsonObject;
  run: (span: TraceHandle) => Promise<T>;
}): Promise<T> {
  const span = startTraceSpan({ name: input.name, attributes: input.attributes });
  try {
    const result = await input.run(span);
    await span.end();
    return result;
  } catch (error) {
    await span.end({ status: "error", error });
    throw error;
  }
}
