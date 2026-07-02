import { NextRequest, NextResponse } from "next/server";
import { emitEvent } from "@/lib/server/events";
import type { DomainEventName, Identifier, JsonObject, JsonValue } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonValue(entry)]));
  }
  return String(value);
}

function jsonObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? jsonValue(value) as JsonObject : { value: jsonValue(value) };
}

function stringField(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function eventNameForHook(event: string): DomainEventName {
  if (event === "PostToolUse") {
    return "tool.completed";
  }
  if (event === "PreToolUse") {
    return "tool.started";
  }
  if (event === "Stop") {
    return "agent.completed";
  }
  return "tool.completed";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const raw = await request.json().catch(() => null);
  const payload = jsonObject(raw);
  const body = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const nativeEvent = stringField(body, ["event", "hook_event", "type"]) ?? "Unknown";
  const workSessionId = stringField(body, ["workSessionId", "work_session_id"]) as Identifier | null;
  const toolName = stringField(body, ["tool_name", "toolName", "tool"]) ?? nativeEvent;
  const agentRunId = stringField(body, ["agentRunId", "agent_run_id"]);

  await emitEvent({
    workSessionId,
    eventName: eventNameForHook(nativeEvent),
    aggregateType: nativeEvent === "Stop" ? "agent_run" : "tool_run",
    aggregateId: agentRunId,
    payload: {
      nativeEvent,
      toolName,
      authoritative: false,
      hookPayload: payload,
    },
    producer: { module: "codex-hook-ingest", runtimeKind: "codex", role: nativeEvent === "Stop" ? "executor" : undefined },
    context: { agentRunId: agentRunId ?? undefined },
  });

  return NextResponse.json({ ok: true });
}

