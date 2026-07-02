import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { renderSourceContextBlocks } from "@/lib/server/source-context";
import type { Identifier, PlaybookRecord, TaskRecord, WorkSessionRecord } from "@/lib/shared/types";

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? []);
}

function scorePlaybook(playbook: PlaybookRecord, textWords: Set<string>, workSession: WorkSessionRecord): number {
  let score = 0;
  if (playbook.projectId === workSession.projectId) score += 4;
  if (playbook.workSessionId === workSession.id) score += 2;
  for (const token of words(`${playbook.title} ${playbook.trigger} ${playbook.tags.join(" ")}`)) {
    if (textWords.has(token)) score += 1;
  }
  return score;
}

export async function findRelevantPlaybooks(input: {
  workSession: WorkSessionRecord;
  task?: TaskRecord | null;
  limit?: number;
}): Promise<PlaybookRecord[]> {
  const db = await getDatabaseSnapshot();
  const taskText = input.task === null || input.task === undefined
    ? ""
    : `${input.task.title} ${input.task.description} ${input.task.acceptanceCriteria.join(" ")} ${JSON.stringify(input.task.metadata)}`;
  const textWords = words(`${input.workSession.lastUserMessage} ${taskText}`);
  return db.playbooks
    .filter((playbook) => playbook.status === "approved")
    .map((playbook) => ({ playbook, score: scorePlaybook(playbook, textWords, input.workSession) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || new Date(b.playbook.updatedAt).getTime() - new Date(a.playbook.updatedAt).getTime())
    .slice(0, input.limit ?? 3)
    .map((entry) => entry.playbook);
}

export async function renderRelevantPlaybooksForPrompt(input: {
  workSession: WorkSessionRecord;
  task?: TaskRecord | null;
  sourceId?: Identifier;
}): Promise<string> {
  const playbooks = await findRelevantPlaybooks(input);
  if (playbooks.length === 0) {
    return "";
  }
  return renderSourceContextBlocks(playbooks.map((playbook) => ({
    trustLevel: "trusted",
    sourceType: "artifact",
    sourceId: playbook.id,
    title: `Approved playbook: ${playbook.title}`,
    content: [
      `Trigger:\n${playbook.trigger}`,
      `Procedure:\n${playbook.procedure}`,
      playbook.tags.length > 0 ? `Tags: ${playbook.tags.join(", ")}` : "",
    ].filter(Boolean).join("\n\n"),
    maxChars: 5000,
  })));
}
