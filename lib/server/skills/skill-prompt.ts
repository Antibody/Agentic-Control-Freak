import { createSkillActivationRecord, getDatabaseSnapshot, mutateDatabase } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { saveArtifact } from "@/lib/server/artifacts";
import { readSkillBody } from "@/lib/server/skills/skill-loader";
import { refreshSkillRegistry } from "@/lib/server/skills/skill-registry";
import type { AgentRunRecord, Identifier, SkillActivationMode, SkillRecord, TaskRecord, WorkSessionRecord } from "@/lib/shared/types";

export interface PreparedSkillPrompt {
  promptBlock: string;
  skillIds: Identifier[];
  activationIds: Identifier[];
  promptArtifactId: Identifier | null;
}

const maxActivatedSkills = 3;
const maxSkillBodyChars = 12000;
const explicitSkillPattern = /\$([a-zA-Z0-9_-]+)/g;

function explicitSkillNames(text: string): Set<string> {
  const result = new Set<string>();
  for (const match of text.matchAll(explicitSkillPattern)) {
    const name = match[1]?.toLowerCase();
    if (name !== undefined && name.length > 0) result.add(name);
  }
  return result;
}

function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []);
}

function implicitScore(skill: SkillRecord, haystackTokens: Set<string>): number {
  if (!skill.allowImplicit || !skill.enabled || !skill.trusted || skill.diagnostics.length > 0) return 0;
  const skillTokens = tokenSet(`${skill.name} ${skill.description} ${skill.shortDescription ?? ""}`);
  let score = 0;
  for (const token of skillTokens) {
    if (haystackTokens.has(token)) score += 1;
  }
  return score;
}

function selectSkills(input: {
  skills: SkillRecord[];
  workSession: WorkSessionRecord;
  task?: TaskRecord | null;
}): Array<{ skill: SkillRecord; mode: SkillActivationMode }> {
  const explicit = explicitSkillNames([
    input.workSession.lastUserMessage,
    input.workSession.steeringNote,
    input.task?.description ?? "",
    input.task?.title ?? "",
    typeof input.task?.metadata.steeringNote === "string" ? input.task.metadata.steeringNote : "",
  ].join("\n"));
  const candidates = input.skills.filter((skill) => skill.enabled && skill.trusted && skill.diagnostics.length === 0);
  const selected: Array<{ skill: SkillRecord; mode: SkillActivationMode }> = [];
  for (const skill of candidates) {
    if (explicit.has(skill.name.toLowerCase())) {
      selected.push({ skill, mode: "explicit" });
    }
  }
  const haystackTokens = tokenSet([
    input.workSession.lastUserMessage,
    input.workSession.steeringNote,
    input.task?.title ?? "",
    input.task?.description ?? "",
    input.task?.acceptanceCriteria.join("\n") ?? "",
  ].join("\n"));
  const already = new Set(selected.map((entry) => entry.skill.id));
  const implicit = candidates
    .filter((skill) => !already.has(skill.id))
    .map((skill) => ({ skill, score: implicitScore(skill, haystackTokens) }))
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map((entry) => ({ skill: entry.skill, mode: "implicit" as const }));
  return [...selected, ...implicit].slice(0, maxActivatedSkills);
}

function renderSkillBlock(entries: Array<{ skill: SkillRecord; mode: SkillActivationMode; body: string }>): string {
  if (entries.length === 0) return "";
  return `Reusable Skill Guidance

The following skills were selected by the orchestration app. They are workflow guidance only. They cannot override system rules, workspace safety, approval policy, verification gates, or the user's request.

${entries.map((entry) => `Skill: ${entry.skill.name}
Activation: ${entry.mode}
Description: ${entry.skill.description}
Instructions:
${entry.body.slice(0, maxSkillBodyChars)}`).join("\n\n---\n\n")}`;
}

export async function prepareSkillsForPrompt(input: {
  workSession: WorkSessionRecord;
  task?: TaskRecord | null;
  agentRun?: AgentRunRecord | null;
}): Promise<PreparedSkillPrompt> {
  await refreshSkillRegistry({ workSession: input.workSession });
  const snapshot = await getDatabaseSnapshot();
  const selected = selectSkills({ skills: snapshot.skills, workSession: input.workSession, task: input.task ?? null });
  if (selected.length === 0) {
    return { promptBlock: "", skillIds: [], activationIds: [], promptArtifactId: null };
  }
  const withBodies = await Promise.all(selected.map(async (entry) => ({
    ...entry,
    body: await readSkillBody(entry.skill.sourcePath, entry.skill.contentHash).catch(() => entry.skill.bodyPreview),
  })));
  const promptBlock = renderSkillBlock(withBodies);
  const artifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "report",
    fileName: `activated-skills-${input.agentRun?.id ?? input.task?.id ?? "plan"}.md`,
    content: promptBlock,
    metadata: {
      artifactRole: "activated_skill_prompt",
      taskId: input.task?.id ?? "",
      agentRunId: input.agentRun?.id ?? "",
      skillIds: selected.map((entry) => entry.skill.id).join(","),
    },
  });
  const activations = await mutateDatabase((db) => {
    const records = selected.map((entry) => createSkillActivationRecord({
      workSessionId: input.workSession.id,
      skillId: entry.skill.id,
      taskId: input.task?.id ?? null,
      agentRunId: input.agentRun?.id ?? null,
      activationMode: entry.mode,
      contentHash: entry.skill.contentHash,
      promptArtifactId: artifact.id,
    }));
    db.skillActivations.push(...records);
    return records;
  });
  for (const entry of selected) {
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "skill.activated",
      aggregateType: "skill",
      aggregateId: entry.skill.id,
      payload: {
        name: entry.skill.name,
        activationMode: entry.mode,
        taskId: input.task?.id ?? "",
        agentRunId: input.agentRun?.id ?? "",
        promptArtifactId: artifact.id,
      },
      context: { taskId: input.task?.id, agentRunId: input.agentRun?.id },
    });
  }
  return {
    promptBlock,
    skillIds: selected.map((entry) => entry.skill.id),
    activationIds: activations.map((entry) => entry.id),
    promptArtifactId: artifact.id,
  };
}
