import type { JsonObject, JsonValue } from "@/lib/shared/types";
import { redactSecrets } from "@/lib/server/secret-redaction";

type LogLevel = "info" | "warn" | "error";

function sanitize(value: unknown, depth = 0): JsonValue {
  if (depth > 5) {
    return "[truncated]";
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redactSecrets(value).slice(0, 1200);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((entry) => sanitize(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, entry]) => [key, sanitize(entry, depth + 1)])
    );
  }
  return String(value).slice(0, 1200);
}

export function logProcess(level: LogLevel, stage: string, details: JsonObject = {}): void {
  const sanitizedDetails = sanitize(details);
  const detailObject = typeof sanitizedDetails === "object" && sanitizedDetails !== null && !Array.isArray(sanitizedDetails)
    ? sanitizedDetails
    : {};
  const payload = {
    ts: new Date().toISOString(),
    level,
    stage,
    ...detailObject,
  };
  console.log(`[orchestrator:${stage}] ${JSON.stringify(payload)}`);
}
