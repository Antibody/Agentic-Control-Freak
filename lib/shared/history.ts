import type { CheckpointRecord, Identifier } from "@/lib/shared/types";

export interface AbandonedHistoryWindow {
  start: string;
  end: string;
  restoreCheckpointId: Identifier | null;
  restoredFromCheckpointId: Identifier | null;
}

export interface ActiveHistorySession {
  id: Identifier;
  checkpointRef: Identifier | null;
  historyBaseCheckpointCreatedAt: string | null;
  historyRestoredAt: string | null;
}

export function computeAbandonedHistoryWindows(
  workSession: ActiveHistorySession,
  checkpoints: readonly CheckpointRecord[],
  options?: { fromCheckpointId?: Identifier | null },
): AbandonedHistoryWindow[] {
  const byId = new Map<Identifier, CheckpointRecord>();
  for (const checkpoint of checkpoints) {
    if (checkpoint.workSessionId === workSession.id) {
      byId.set(checkpoint.id, checkpoint);
    }
  }
  const startId = options?.fromCheckpointId ?? workSession.checkpointRef;
  const windows: AbandonedHistoryWindow[] = [];
  const visited = new Set<Identifier>();
  let current = startId === null ? undefined : byId.get(startId);
  const walkedAnyCheckpoint = current !== undefined;
  while (current !== undefined && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.trigger === "restore" && current.restoredFromCheckpointId !== null) {
      const target = byId.get(current.restoredFromCheckpointId);
      if (target !== undefined && target.createdAt < current.createdAt) {
        windows.push({
          start: target.createdAt,
          end: current.createdAt,
          restoreCheckpointId: current.id,
          restoredFromCheckpointId: target.id,
        });
        current = target;
        continue;
      }
    }
    current = current.previousCheckpointId === null ? undefined : byId.get(current.previousCheckpointId);
  }
  if (
    !walkedAnyCheckpoint &&
    windows.length === 0 &&
    workSession.historyBaseCheckpointCreatedAt !== null &&
    workSession.historyRestoredAt !== null &&
    workSession.historyBaseCheckpointCreatedAt < workSession.historyRestoredAt
  ) {
    windows.push({
      start: workSession.historyBaseCheckpointCreatedAt,
      end: workSession.historyRestoredAt,
      restoreCheckpointId: null,
      restoredFromCheckpointId: null,
    });
  }
  return windows;
}

export function isTimestampInActiveHistory(windows: readonly AbandonedHistoryWindow[], timestamp: string): boolean {
  for (const window of windows) {
    if (timestamp > window.start && timestamp < window.end) {
      return false;
    }
  }
  return true;
}

export function createActiveHistoryFilter(
  workSession: ActiveHistorySession | undefined,
  checkpoints: readonly CheckpointRecord[],
): (timestamp: string) => boolean {
  if (workSession === undefined) {
    return () => true;
  }
  const windows = computeAbandonedHistoryWindows(workSession, checkpoints);
  if (windows.length === 0) {
    return () => true;
  }
  return (timestamp) => isTimestampInActiveHistory(windows, timestamp);
}
