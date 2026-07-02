import { randomUUID } from "node:crypto";
import { logProcess } from "@/lib/server/logging";
import type { Identifier } from "@/lib/shared/types";

export type WorkSessionOperationKind = "controller" | "verification" | "preview" | "snapshot" | "github-export" | "experiment" | "calibration" | "inference";

export interface ActiveWorkSessionOperation {
  id: Identifier;
  workSessionId: Identifier;
  kind: WorkSessionOperationKind;
  label: string;
  startedAt: string;
}

export interface WorkSessionOperationHandle extends ActiveWorkSessionOperation {
  signal: AbortSignal;
  unregister: () => void;
  throwIfAborted: () => void;
}

const activeOperations = new Map<Identifier, WorkSessionOperationHandle>();
const signalControllers = new WeakMap<AbortSignal, AbortController>();

export class WorkSessionOperationAbortedError extends Error {
  readonly workSessionId: Identifier;
  readonly operationKind: WorkSessionOperationKind;

  constructor(workSessionId: Identifier, operationKind: WorkSessionOperationKind, message = "Operation aborted by user.") {
    super(message);
    this.name = "WorkSessionOperationAbortedError";
    this.workSessionId = workSessionId;
    this.operationKind = operationKind;
  }
}

export function isWorkSessionOperationAbortedError(error: unknown): error is WorkSessionOperationAbortedError {
  return error instanceof WorkSessionOperationAbortedError || (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "WorkSessionOperationAbortedError")
  );
}

export function registerWorkSessionOperation(input: {
  workSessionId: Identifier;
  kind: WorkSessionOperationKind;
  label: string;
}): WorkSessionOperationHandle {
  const controller = new AbortController();
  const operation: WorkSessionOperationHandle = {
    id: randomUUID(),
    workSessionId: input.workSessionId,
    kind: input.kind,
    label: input.label,
    startedAt: new Date().toISOString(),
    signal: controller.signal,
    unregister: () => {
      activeOperations.delete(operation.id);
      logProcess("info", "operation_registry.unregistered", {
        workSessionId: operation.workSessionId,
        operationId: operation.id,
        kind: operation.kind,
        label: operation.label,
      });
    },
    throwIfAborted: () => {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason instanceof Error) {
          throw reason;
        }
        throw new WorkSessionOperationAbortedError(input.workSessionId, input.kind);
      }
    },
  };

  signalControllers.set(controller.signal, controller);
  activeOperations.set(operation.id, operation);
  logProcess("info", "operation_registry.registered", {
    workSessionId: operation.workSessionId,
    operationId: operation.id,
    kind: operation.kind,
    label: operation.label,
  });
  return operation;
}

export function activeOperationsForWorkSession(workSessionId: Identifier): ActiveWorkSessionOperation[] {
  return Array.from(activeOperations.values())
    .filter((operation) => operation.workSessionId === workSessionId)
    .map(({ id, workSessionId: sessionId, kind, label, startedAt }) => ({
      id,
      workSessionId: sessionId,
      kind,
      label,
      startedAt,
    }));
}

export function abortWorkSessionOperations(workSessionId: Identifier, reason = "User requested abort."): number {
  const operations = Array.from(activeOperations.values()).filter((operation) => operation.workSessionId === workSessionId);
  return abortOperations(operations, reason);
}

export function abortWorkSessionOperationsByKind(
  workSessionId: Identifier,
  kind: WorkSessionOperationKind,
  reason = "User requested abort.",
): number {
  const operations = Array.from(activeOperations.values()).filter(
    (operation) => operation.workSessionId === workSessionId && operation.kind === kind,
  );
  return abortOperations(operations, reason);
}

function abortOperations(operations: WorkSessionOperationHandle[], reason: string): number {
  let aborted = 0;
  for (const operation of operations) {
    const signal = operation.signal;
    if (signal.aborted) {
      continue;
    }
    const controller = abortControllerForSignal(signal);
    if (controller === null) {
      continue;
    }
    logProcess("warn", "operation_registry.abort.requested", {
      workSessionId: operation.workSessionId,
      operationId: operation.id,
      kind: operation.kind,
      label: operation.label,
      reason,
    });
    controller.abort(new WorkSessionOperationAbortedError(operation.workSessionId, operation.kind, reason));
    aborted += 1;
    logProcess("warn", "operation_registry.abort.completed", {
      workSessionId: operation.workSessionId,
      operationId: operation.id,
      kind: operation.kind,
      label: operation.label,
    });
  }
  return aborted;
}

function abortControllerForSignal(signal: AbortSignal): AbortController | null {
  return signalControllers.get(signal) ?? null;
}
