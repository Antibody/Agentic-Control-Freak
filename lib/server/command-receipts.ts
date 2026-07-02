import { createHash } from "node:crypto";
import { createCommandReceiptRecord, mutateDatabase } from "@/lib/server/db/file-db";
import type { Identifier, JsonObject } from "@/lib/shared/types";

interface ReceiptRequest {
  workSessionId: Identifier;
  commandType: string;
  idempotencyKey: string | null;
  requestBody: unknown;
}

interface ReceiptStart {
  mode: "started";
  receiptId: Identifier;
}

interface ReceiptReplay {
  mode: "replay";
  response: { ok: true; data: JsonObject } | { ok: false; error: string };
}

export type ReceiptStartResult = ReceiptStart | ReceiptReplay;

function toJsonObject(value: unknown): JsonObject {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return JSON.parse(JSON.stringify(value)) as JsonObject;
  }
  return { value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function hashRequest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function idempotencyKeyFromRequest(headers: Headers, body: unknown): string | null {
  const header = headers.get("idempotency-key") ?? headers.get("x-idempotency-key");
  if (header !== null && header.trim().length > 0) {
    return header.trim().slice(0, 200);
  }
  if (typeof body === "object" && body !== null) {
    const candidate = (body as Record<string, unknown>).idempotencyKey;
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().slice(0, 200);
    }
  }
  return null;
}

export async function startCommandReceipt(input: ReceiptRequest): Promise<ReceiptStartResult> {
  if (input.idempotencyKey === null) {
    return { mode: "started", receiptId: "" };
  }
  const idempotencyKey = input.idempotencyKey;
  const requestHash = hashRequest(input.requestBody);
  return mutateDatabase((db) => {
    const existing = db.commandReceipts.find((receipt) =>
      receipt.workSessionId === input.workSessionId &&
      receipt.commandType === input.commandType &&
      receipt.idempotencyKey === idempotencyKey
    );
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        return { mode: "replay", response: { ok: false, error: "Idempotency key was reused with a different request." } } satisfies ReceiptReplay;
      }
      if (existing.status === "completed" && existing.result !== null) {
        return { mode: "replay", response: { ok: true, data: existing.result } } satisfies ReceiptReplay;
      }
      if (existing.status === "failed") {
        return { mode: "replay", response: { ok: false, error: existing.error ?? "Prior command failed." } } satisfies ReceiptReplay;
      }
      return { mode: "replay", response: { ok: false, error: "Matching command is already running." } } satisfies ReceiptReplay;
    }
    const receipt = createCommandReceiptRecord({
      workSessionId: input.workSessionId,
      idempotencyKey,
      commandType: input.commandType,
      requestHash,
      status: "running",
      result: null,
      error: null,
    });
    db.commandReceipts.push(receipt);
    return { mode: "started", receiptId: receipt.id } satisfies ReceiptStart;
  });
}

export async function completeCommandReceipt(receiptId: Identifier, result: unknown): Promise<void> {
  if (receiptId.length === 0) return;
  const jsonResult = toJsonObject(result);
  await mutateDatabase((db) => {
    const receipt = db.commandReceipts.find((candidate) => candidate.id === receiptId);
    if (receipt !== undefined) {
      receipt.status = "completed";
      receipt.result = jsonResult;
      receipt.error = null;
      receipt.updatedAt = new Date().toISOString();
    }
  });
}

export async function failCommandReceipt(receiptId: Identifier, error: unknown): Promise<void> {
  if (receiptId.length === 0) return;
  await mutateDatabase((db) => {
    const receipt = db.commandReceipts.find((candidate) => candidate.id === receiptId);
    if (receipt !== undefined) {
      receipt.status = "failed";
      receipt.result = null;
      receipt.error = error instanceof Error ? error.message : String(error);
      receipt.updatedAt = new Date().toISOString();
    }
  });
}
