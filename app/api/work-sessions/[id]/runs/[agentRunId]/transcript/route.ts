import { NextResponse } from "next/server";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { readTranscriptTurns } from "@/lib/server/transcripts";
import { boundedText } from "@/lib/server/text-bounds";
import type { TranscriptTurnRecord } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; agentRunId: string }>;
}

interface RunProgressEntry {
  id: string;
  ts: string;
  text: string;
  kind: "message" | "command" | "file_change" | "output";
}

function publicTurn(turn: TranscriptTurnRecord): TranscriptTurnRecord {
  return {
    agentRunId: turn.agentRunId,
    taskId: turn.taskId ?? null,
    provider: turn.provider,
    model: turn.model,
    role: turn.role,
    finalText: boundedText(turn.finalText, 12000),
    reasoning: turn.reasoning === undefined ? undefined : boundedText(turn.reasoning, 12000),
    ts: turn.ts,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function extractJsonObjects(input: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char !== "}" || depth === 0) {
      continue;
    }

    depth -= 1;
    if (depth === 0 && start >= 0) {
      const candidate = input.slice(start, index + 1);
      try {
        const parsed = JSON.parse(candidate) as unknown;
        const record = asRecord(parsed);
        if (record !== null) objects.push(record);
      } catch {
      }
      start = -1;
    }
  }

  return objects;
}

function progressFromCodexEvent(event: Record<string, unknown>): RunProgressEntry[] {
  const item = asRecord(event.item);
  if (item === null) return [];
  const itemType = typeof item.type === "string" ? item.type : "";
  const id = typeof item.id === "string" ? item.id : "";

  if (itemType === "agent_message" && typeof item.text === "string" && item.text.trim().length > 0) {
    return [{ id, ts: "", text: item.text, kind: "message" }];
  }

  if (itemType === "command_execution" && typeof item.command === "string" && item.command.trim().length > 0) {
    return [{ id, ts: "", text: `$ ${item.command}`, kind: "command" }];
  }

  if (itemType === "file_change" && Array.isArray(item.changes)) {
    return item.changes.flatMap((change, index) => {
      const record = asRecord(change);
      const filePath = typeof record?.path === "string" ? record.path : "";
      if (filePath.trim().length === 0) return [];
      const kind = typeof record?.kind === "string" ? record.kind : "changed";
      return [{ id: `${id}:${index}`, ts: "", text: `${kind}: ${filePath}`, kind: "file_change" as const }];
    });
  }

  return [];
}

function progressEntriesFromText(input: string): Array<Omit<RunProgressEntry, "id" | "ts">> {
  const trimmed = input.trim();
  if (trimmed.length === 0) return [];

  const parsedObjects = extractJsonObjects(trimmed);
  if (parsedObjects.length > 0) {
    return parsedObjects
      .flatMap(progressFromCodexEvent)
      .map((entry) => ({ text: entry.text, kind: entry.kind }));
  }

  const kind: RunProgressEntry["kind"] = trimmed.startsWith("$ ") ? "command" : "output";
  return [{ text: trimmed, kind }];
}

function compactProgress(entries: RunProgressEntry[]): RunProgressEntry[] {
  const compacted: RunProgressEntry[] = [];
  for (const entry of entries) {
    const previous = compacted[compacted.length - 1];
    if (previous !== undefined && previous.text === entry.text && previous.kind === entry.kind) {
      continue;
    }
    compacted.push(entry);
  }
  return compacted.slice(-80);
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    const { id, agentRunId } = await context.params;
    const db = await getDatabaseSnapshot();
    const workSession = db.workSessions.find((candidate) => candidate.id === id) ?? null;
    const agentRun = db.agentRuns.find((run) => run.id === agentRunId && run.workSessionId === id) ?? null;
    if (workSession === null || agentRun === null) {
      return NextResponse.json({ ok: false, error: "Agent run not found." }, { status: 404 });
    }

    const allTurns = await readTranscriptTurns(workSession.transcriptRef);
    const turns = allTurns
      .filter((turn) => turn.agentRunId === agentRunId)
      .map(publicTurn);
    const fallback = turns.length === 0 && agentRun.summary.trim().length > 0
      ? [publicTurn({
          agentRunId,
          taskId: agentRun.taskId,
          provider: agentRun.runtimeKind,
          model: agentRun.model,
          role: agentRun.role,
          finalText: agentRun.summary,
          ts: agentRun.endedAt ?? agentRun.startedAt,
        })]
      : turns;

    const progress = compactProgress(db.eventLog
      .filter((event) =>
        event.workSessionId === id &&
        event.eventName === "agent.process.output.delta" &&
        (event.context.agentRunId === agentRunId || event.aggregateId === agentRunId)
      )
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .flatMap((event) => {
        const text = typeof event.payload.text === "string" ? event.payload.text : "";
        return progressEntriesFromText(text).map((entry, index) => ({
          id: `${event.id}:${index}`,
          ts: event.createdAt,
          text: boundedText(entry.text, 1600),
          kind: entry.kind,
        }));
      }));

    return NextResponse.json({ ok: true, data: { agentRun, turns: fallback, progress } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown run transcript API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
