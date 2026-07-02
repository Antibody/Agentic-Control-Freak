import path from "node:path";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { gitFileDiff, listGitChangedFiles } from "@/lib/server/runtime/workspace-git";
import { parseUnifiedDiffStats } from "@/lib/shared/diff-utils";
import { isGeneratedPreviewArtifact } from "@/lib/shared/stack-capabilities";
import { createActiveHistoryFilter } from "@/lib/shared/history";
import type {
  AppDatabase,
  CheckpointRecord,
  CodeChangeRecord,
  HandoffRecord,
  Identifier,
  SessionChangedFile,
  SessionChangeSet,
  SessionFileDiff,
  WorkSessionRecord,
} from "@/lib/shared/types";

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\/+/, "");
}

function assertSafeRelativePath(filePath: string): string {
  const normalized = normalizePath(filePath.trim());
  if (
    normalized.length === 0 ||
    path.isAbsolute(filePath) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("Invalid file path.");
  }
  return normalized;
}

function sessionCheckpointsBeforeHandoff(db: AppDatabase, workSession: WorkSessionRecord, handoff: HandoffRecord): CheckpointRecord[] {
  const inHistory = createActiveHistoryFilter(workSession, db.checkpoints);
  return db.checkpoints
    .filter((checkpoint) =>
      checkpoint.workSessionId === workSession.id &&
      checkpoint.createdAt <= handoff.createdAt &&
      inHistory(checkpoint.createdAt)
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function resolveCheckpointPair(db: AppDatabase, workSession: WorkSessionRecord, handoff: HandoffRecord): {
  base: CheckpointRecord | null;
  target: CheckpointRecord | null;
} {
  const checkpoints = sessionCheckpointsBeforeHandoff(db, workSession, handoff);
  if (checkpoints.length === 0) {
    return { base: null, target: null };
  }
  const target = [...checkpoints].reverse().find((checkpoint) => checkpoint.id === workSession.checkpointRef) ?? checkpoints[checkpoints.length - 1] ?? null;
  const historyBase = workSession.historyBaseCheckpointId === null
    ? null
    : checkpoints.find((checkpoint) => checkpoint.id === workSession.historyBaseCheckpointId) ?? null;
  const base = historyBase ?? checkpoints[0] ?? null;
  return { base, target };
}

function agentRunsBeforeHandoff(db: AppDatabase, workSession: WorkSessionRecord, handoff: HandoffRecord): Set<Identifier> {
  const inHistory = createActiveHistoryFilter(workSession, db.checkpoints);
  return new Set(
    db.agentRuns
      .filter((run) =>
        run.workSessionId === workSession.id &&
        run.startedAt <= handoff.createdAt &&
        inHistory(run.startedAt)
      )
      .map((run) => run.id)
  );
}

function recordedChangesForHandoff(db: AppDatabase, workSession: WorkSessionRecord, handoff: HandoffRecord): CodeChangeRecord[] {
  const runIds = agentRunsBeforeHandoff(db, workSession, handoff);
  return db.codeChanges.filter((change) => runIds.has(change.agentRunId));
}

function fallbackChangeSet(db: AppDatabase, workSession: WorkSessionRecord, handoff: HandoffRecord): SessionChangedFile[] {
  const byPath = new Map<string, SessionChangedFile>();
  for (const change of recordedChangesForHandoff(db, workSession, handoff)) {
    if (isGeneratedPreviewArtifact(change.filePath)) {
      continue;
    }
    const stats = parseUnifiedDiffStats(change.diffExcerpt);
    byPath.set(change.filePath, {
      filePath: change.filePath,
      previousPath: null,
      changeKind: change.changeKind,
      additions: stats.additions,
      deletions: stats.deletions,
      binary: stats.binary,
    });
  }
  return [...byPath.values()].sort((a, b) => a.filePath.localeCompare(b.filePath));
}

async function enrichCheckpointFiles(input: {
  workSession: WorkSessionRecord;
  baseCommitHash: string;
  targetCommitHash: string;
  files: SessionChangedFile[];
}): Promise<SessionChangedFile[]> {
  const enriched: SessionChangedFile[] = [];
  for (const file of input.files) {
    if (isGeneratedPreviewArtifact(file.filePath)) {
      continue;
    }
    const diff = await gitFileDiff({
      workSessionId: input.workSession.id,
      workTree: input.workSession.activeWorktreePath,
      baseCommitHash: input.baseCommitHash,
      targetCommitHash: input.targetCommitHash,
      filePath: file.filePath,
    }).catch(() => "");
    const stats = parseUnifiedDiffStats(diff);
    enriched.push({
      ...file,
      additions: stats.additions,
      deletions: stats.deletions,
      binary: stats.binary,
    });
  }
  return enriched.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function requireSessionAndHandoff(db: AppDatabase, workSessionId: Identifier, handoffId: Identifier): {
  workSession: WorkSessionRecord;
  handoff: HandoffRecord;
} {
  const workSession = db.workSessions.find((candidate) => candidate.id === workSessionId);
  if (workSession === undefined) {
    throw new Error("Work session was not found.");
  }
  const handoff = db.handoffs.find((candidate) => candidate.id === handoffId && candidate.workSessionId === workSessionId);
  if (handoff === undefined) {
    throw new Error("Handoff was not found.");
  }
  return { workSession, handoff };
}

export async function getSessionChangeSet(input: {
  workSessionId: Identifier;
  handoffId: Identifier;
}): Promise<SessionChangeSet> {
  const db = await getDatabaseSnapshot();
  const { workSession, handoff } = requireSessionAndHandoff(db, input.workSessionId, input.handoffId);
  const pair = resolveCheckpointPair(db, workSession, handoff);
  if (pair.base !== null && pair.target !== null) {
    try {
      const files = await listGitChangedFiles({
        workSessionId: workSession.id,
        workTree: workSession.activeWorktreePath,
        baseCommitHash: pair.base.commitHash,
        targetCommitHash: pair.target.commitHash,
      });
      return {
        workSessionId: workSession.id,
        handoffId: handoff.id,
        source: "checkpoint",
        baseCheckpointId: pair.base.id,
        targetCheckpointId: pair.target.id,
        files: await enrichCheckpointFiles({
          workSession,
          baseCommitHash: pair.base.commitHash,
          targetCommitHash: pair.target.commitHash,
          files,
        }),
      };
    } catch {
    }
  }
  return {
    workSessionId: workSession.id,
    handoffId: handoff.id,
    source: "recorded_changes",
    baseCheckpointId: null,
    targetCheckpointId: null,
    files: fallbackChangeSet(db, workSession, handoff),
  };
}

export async function getSessionFileDiff(input: {
  workSessionId: Identifier;
  handoffId: Identifier;
  filePath: string;
}): Promise<SessionFileDiff> {
  const filePath = assertSafeRelativePath(input.filePath);
  const db = await getDatabaseSnapshot();
  const { workSession, handoff } = requireSessionAndHandoff(db, input.workSessionId, input.handoffId);
  const pair = resolveCheckpointPair(db, workSession, handoff);
  if (pair.base !== null && pair.target !== null) {
    try {
      const files = await listGitChangedFiles({
        workSessionId: workSession.id,
        workTree: workSession.activeWorktreePath,
        baseCommitHash: pair.base.commitHash,
        targetCommitHash: pair.target.commitHash,
      });
      if (!files.some((file) => file.filePath === filePath || file.previousPath === filePath)) {
        throw new Error("File is not part of this handoff change set.");
      }
      const diff = await gitFileDiff({
        workSessionId: workSession.id,
        workTree: workSession.activeWorktreePath,
        baseCommitHash: pair.base.commitHash,
        targetCommitHash: pair.target.commitHash,
        filePath,
      });
      const stats = parseUnifiedDiffStats(diff);
      return {
        workSessionId: workSession.id,
        handoffId: handoff.id,
        filePath,
        source: "checkpoint",
        diff,
        additions: stats.additions,
        deletions: stats.deletions,
        binary: stats.binary,
        hunks: stats.hunks,
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("not part")) {
        throw error;
      }
    }
  }

  const change = recordedChangesForHandoff(db, workSession, handoff).find((candidate) => candidate.filePath === filePath);
  if (change === undefined) {
    throw new Error("File is not part of this handoff change set.");
  }
  const stats = parseUnifiedDiffStats(change.diffExcerpt);
  return {
    workSessionId: workSession.id,
    handoffId: handoff.id,
    filePath,
    source: "recorded_changes",
    diff: change.diffExcerpt || "No diff excerpt was captured for this file.",
    additions: stats.additions,
    deletions: stats.deletions,
    binary: stats.binary,
    hunks: stats.hunks,
  };
}
