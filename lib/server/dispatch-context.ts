import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { createActiveHistoryFilter } from "@/lib/shared/history";
import type { AgentRunRecord, AppDatabase, TaskRecord, WorkSessionRecord } from "@/lib/shared/types";

const maxRetryAddendumChars = 1500;
const maxContinuityChars = 2000;
const maxCompactContinuityChars = 1200;

function oneLine(input: string, maxLength: number): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function truncateBlock(input: string, maxLength: number): string {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function finishedRunsForTask(db: AppDatabase, workSession: WorkSessionRecord, taskId: string, currentAgentRunId: string): AgentRunRecord[] {
  const inHistory = createActiveHistoryFilter(workSession, db.checkpoints);
  return db.agentRuns
    .filter((run) =>
      run.workSessionId === workSession.id &&
      run.taskId === taskId &&
      run.id !== currentAgentRunId &&
      inHistory(run.startedAt))
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());
}

function isRepairTask(task: TaskRecord): boolean {
  return typeof task.metadata.repairForTaskId === "string"
    || typeof task.metadata.repairForVerificationRunId === "string"
    || typeof task.metadata.repairForPreviewId === "string";
}

async function buildRepairLineageAddendum(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  currentAgentRunId: string;
}): Promise<string | null> {
  if (!isRepairTask(input.task)) {
    return null;
  }
  const db = await getDatabaseSnapshot();
  const priorRepairs = db.tasks
    .filter((candidate) =>
      candidate.planId === input.task.planId &&
      candidate.id !== input.task.id &&
      candidate.ordinal < input.task.ordinal &&
      isRepairTask(candidate))
    .sort((left, right) => right.ordinal - left.ordinal);
  if (priorRepairs.length === 0) {
    return null;
  }
  const latestPrior = priorRepairs[0];
  const fingerprintOf = (task: TaskRecord): string | null =>
    typeof task.metadata.failureFingerprint === "string" && task.metadata.failureFingerprint.trim().length > 0
      ? task.metadata.failureFingerprint
      : task.lastFailureFingerprint;
  const currentFingerprint = fingerprintOf(input.task);
  const priorFingerprint = fingerprintOf(latestPrior);
  const verdictLine = currentFingerprint !== null && priorFingerprint !== null
    ? currentFingerprint === priorFingerprint
      ? "- The most recent repair did NOT clear this failure: the failure fingerprint is identical. Its approach was wrong or incomplete; diagnose the root cause differently instead of repeating it."
      : "- The previous repair's failure was resolved; this is a DIFFERENT failure (new fingerprint). Do not disturb the prior fix while addressing this one."
    : "";
  const repairLines = priorRepairs.slice(0, 3).map((repair) => {
    const runs = finishedRunsForTask(db, input.workSession, repair.id, input.currentAgentRunId);
    const run = runs.find((candidate) => candidate.summary.trim().length > 0 && !candidate.summary.startsWith("Superseded by a later attempt")) ?? runs[0] ?? null;
    const outcome = run === null ? repair.status : run.status;
    const summary = run === null || run.summary.trim().length === 0 ? "no run summary was recorded" : run.summary;
    return `- ${oneLine(repair.title, 60)} (${outcome}): ${oneLine(summary, 280)}`;
  });
  const priorRepairIds = new Set(priorRepairs.map((repair) => repair.id));
  const priorRunIds = new Set(
    db.agentRuns
      .filter((run) => run.workSessionId === input.workSession.id && run.taskId !== null && priorRepairIds.has(run.taskId))
      .map((run) => run.id),
  );
  const changedFiles = Array.from(new Set(
    db.codeChanges
      .filter((change) => priorRunIds.has(change.agentRunId))
      .map((change) => `${change.changeKind}: ${change.filePath}`),
  )).slice(-12);
  const fileLines = changedFiles.length > 0
    ? `Files already changed by prior repairs (inspect their current state first):\n${changedFiles.map((file) => `- ${file}`).join("\n")}`
    : "";
  const block = [
    `Repair lineage (this is repair task #${priorRepairs.length + 1} in this plan; compiled at dispatch):`,
    verdictLine,
    `Prior repair attempts (most recent first):`,
    ...repairLines,
    fileLines,
    "Build on prior repairs rather than reverting them, and make one focused patch for the recorded failure.",
  ].filter((entry) => entry.length > 0).join("\n");
  return truncateBlock(block, maxRetryAddendumChars);
}

export async function buildRetryAddendum(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  currentAgentRunId: string;
}): Promise<string | null> {
  if (input.task.attemptCount <= 0) {
    return buildRepairLineageAddendum(input);
  }
  const db = await getDatabaseSnapshot();
  const priorRuns = finishedRunsForTask(db, input.workSession, input.task.id, input.currentAgentRunId);
  const priorRunIds = new Set(priorRuns.map((run) => run.id));
  const changedFiles = Array.from(new Set(
    db.codeChanges
      .filter((change) => priorRunIds.has(change.agentRunId))
      .map((change) => `${change.changeKind}: ${change.filePath}`),
  )).slice(-12);
  const failureLine = input.task.lastFailureSummary !== null && input.task.lastFailureSummary.trim().length > 0
    ? `- Last failure: ${oneLine(input.task.lastFailureSummary, 360)}`
    : "- Last failure: no summary was recorded.";
  const fingerprintLine = input.task.lastFailureFingerprint !== null && input.task.lastFailureFingerprint.trim().length > 0
    ? `- Failure fingerprint: ${oneLine(input.task.lastFailureFingerprint, 80)}`
    : "";
  const runLines = priorRuns
    .filter((run) => run.summary.trim().length > 0 && !run.summary.startsWith("Superseded by a later attempt"))
    .slice(0, 2)
    .map((run) => `- Prior attempt (${run.status}): ${oneLine(run.summary, 320)}`);
  const fileLines = changedFiles.length > 0
    ? `Files already changed by previous attempts (inspect their current state first):\n${changedFiles.map((file) => `- ${file}`).join("\n")}`
    : "";
  const block = [
    `Retry context (attempt ${input.task.attemptCount + 1} of this task, compiled at dispatch):`,
    failureLine,
    fingerprintLine,
    ...runLines,
    fileLines,
    "Do not repeat already-applied edits or discard useful partial work. Make one focused patch that addresses the recorded failure.",
  ].filter((entry) => entry.length > 0).join("\n");
  return truncateBlock(block, maxRetryAddendumChars);
}

export async function buildContinuityBlock(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  currentAgentRunId: string;
  compact: boolean;
}): Promise<string | null> {
  const db = await getDatabaseSnapshot();
  const inHistory = createActiveHistoryFilter(input.workSession, db.checkpoints);
  const sessionRuns = db.agentRuns
    .filter((run) =>
      run.workSessionId === input.workSession.id &&
      run.id !== input.currentAgentRunId &&
      inHistory(run.startedAt))
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());
  if (sessionRuns.length === 0) {
    return null;
  }
  const sessionRunIds = new Set(sessionRuns.map((run) => run.id));
  const recentChanges = Array.from(new Set(
    db.codeChanges
      .filter((change) => sessionRunIds.has(change.agentRunId))
      .map((change) => `${change.changeKind}: ${change.filePath}`),
  )).slice(input.compact ? -8 : -12);
  const taskTitles = new Map(db.tasks.map((candidate) => [candidate.id, candidate.title]));
  const runLines = sessionRuns
    .filter((run) => run.summary.trim().length > 0 && !run.summary.startsWith("Superseded by a later attempt"))
    .slice(0, input.compact ? 3 : 4)
    .map((run) => {
      const title = run.taskId === null ? run.role : taskTitles.get(run.taskId) ?? run.role;
      return `- [${run.status}] ${oneLine(title, 70)}: ${oneLine(run.summary, input.compact ? 180 : 260)}`;
    });
  if (recentChanges.length === 0 && runLines.length === 0) {
    return null;
  }
  const block = [
    "Session continuity (what this work session has already done; compiled at dispatch):",
    runLines.length > 0 ? `Prior task outcomes:\n${runLines.join("\n")}` : "",
    recentChanges.length > 0 ? `Files changed so far:\n${recentChanges.map((file) => `- ${file}`).join("\n")}` : "",
    "Build on this work. Do not recreate or overwrite completed deliverables unless this task explicitly requires it.",
  ].filter((entry) => entry.length > 0).join("\n");
  return truncateBlock(block, input.compact ? maxCompactContinuityChars : maxContinuityChars);
}
