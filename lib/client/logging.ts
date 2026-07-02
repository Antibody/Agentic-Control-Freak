type ClientLogLevel = "info" | "warn" | "error";

type ClientLogValue =
  | string
  | number
  | boolean
  | null
  | ClientLogValue[]
  | { [key: string]: ClientLogValue };

function sanitize(value: unknown, depth = 0): ClientLogValue {
  if (depth > 5) {
    return "[truncated]";
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted-api-key>")
      .replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*["']?[^"'\s]+/gi, (match) => {
        const key = match.split(/[:=]/)[0] ?? "secret";
        return `${key}=<redacted>`;
      })
      .slice(0, 800);
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
  return String(value).slice(0, 800);
}

export function logClientProcess(level: ClientLogLevel, stage: string, details: Record<string, unknown> = {}): void {
  const sanitized = sanitize(details);
  const detailObject = typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized) ? sanitized : {};
  console.log(`[client:${stage}] ${JSON.stringify({
    ts: new Date().toISOString(),
    level,
    stage,
    ...detailObject,
  })}`);
}
