import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { boundedText, chatSummary } from "@/lib/server/text-bounds";
import type { AgentRunRecord, Identifier, TranscriptTurnRecord } from "@/lib/shared/types";

const maxTranscriptTurnsForBrief = 12;

function dataRoot(): string {
  return path.dirname(getConfig().dbFile);
}

function transcriptRefFor(workSessionId: Identifier): string {
  return `transcripts/${workSessionId}.jsonl`;
}

function transcriptPathFromRef(ref: string): string {
  return path.join(dataRoot(), ref);
}

function compactLine(input: string, maxLength: number): string {
  return boundedText(input.replace(/\s+/g, " ").trim(), maxLength);
}

export function transcriptRefForWorkSession(workSessionId: Identifier): string {
  return transcriptRefFor(workSessionId);
}

export async function appendTranscriptTurns(input: {
  workSessionId: Identifier;
  transcriptRef: string | null;
  turns: TranscriptTurnRecord[];
}): Promise<string | null> {
  if (input.turns.length === 0) {
    return input.transcriptRef;
  }
  const ref = input.transcriptRef ?? transcriptRefFor(input.workSessionId);
  const filePath = transcriptPathFromRef(ref);
  await mkdir(path.dirname(filePath), { recursive: true });
  const lines = input.turns.map((turn) => JSON.stringify(turn)).join("\n");
  await appendFile(filePath, `${lines}\n`, "utf8");
  return ref;
}

export async function readTranscriptTurns(ref: string | null): Promise<TranscriptTurnRecord[]> {
  if (ref === null) {
    return [];
  }
  try {
    const content = await readFile(transcriptPathFromRef(ref), "utf8");
    const turns: TranscriptTurnRecord[] = [];
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as Partial<TranscriptTurnRecord>;
        if (
          typeof parsed.provider === "string" &&
          typeof parsed.model === "string" &&
          typeof parsed.role === "string" &&
          typeof parsed.finalText === "string" &&
          typeof parsed.ts === "string"
        ) {
          turns.push(parsed as TranscriptTurnRecord);
        }
      } catch {
        continue;
      }
    }
    return turns;
  } catch {
    return [];
  }
}

export function defaultTranscriptTurn(input: {
  agentRun: AgentRunRecord;
  finalText: string;
  ts?: string;
}): TranscriptTurnRecord {
  return {
    agentRunId: input.agentRun.id,
    taskId: input.agentRun.taskId,
    provider: input.agentRun.runtimeKind,
    model: input.agentRun.model,
    role: input.agentRun.role,
    finalText: input.finalText,
    ts: input.ts ?? new Date().toISOString(),
  };
}

export function buildSwitchHandoffBrief(input: {
  previousRun: AgentRunRecord;
  currentRun: AgentRunRecord;
  turns: TranscriptTurnRecord[];
}): string {
  const recent = input.turns.slice(-maxTranscriptTurnsForBrief);
  const lines = recent
    .map((turn) => {
      const reasoningNote = turn.reasoning !== undefined && turn.reasoning.trim().length > 0
        ? " Reasoning was captured in the side transcript and intentionally omitted here."
        : "";
      return `- [${turn.provider} | ${turn.role} | ${turn.model}] ${compactLine(turn.finalText, 450)}${reasoningNote}`;
    })
    .filter((line) => !line.endsWith("] "));
  const fallback = compactLine(input.currentRun.summary, 700);
  return `# Cross-provider Handoff Brief

Reason: provider switched from ${input.previousRun.runtimeKind} to ${input.currentRun.runtimeKind}.

## Distilled Recent Work
${lines.length > 0 ? lines.join("\n") : `- ${fallback}`}

## Continuity Notes
- Use this brief as provider-neutral context only.
- Raw reasoning is never re-injected into prompts.
`;
}

export function switchHandoffChatSummary(markdown: string): string {
  return chatSummary(markdown.replace(/^# Cross-provider Handoff Brief\s*/i, "").trim());
}
