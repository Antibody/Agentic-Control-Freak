import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import type {
  TelegramCallbackNonce,
  TelegramControlRole,
  TelegramControlState,
  TelegramPairingChallenge,
} from "@/lib/server/telegram-control/types";

type Mutator<T> = (state: TelegramControlState) => T;

let stateLock: Promise<void> = Promise.resolve();

export const PAIRING_MAX_FAILED_ATTEMPTS = 5;
const PAIRING_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const PAIRING_LOCKOUT_MS = 15 * 60 * 1000;
const PROCESSED_UPDATE_RETENTION = 1000;

function emptyState(): TelegramControlState {
  return {
    principals: [],
    chatBindings: [],
    pairingChallenges: [],
    pairingAttempts: [],
    callbackNonces: [],
    eventCursors: [],
    processedUpdates: [],
    auditLog: [],
  };
}

function statePath(): string {
  return path.join(path.dirname(getConfig().dbFile), "telegram-control.json");
}

function nowIso(): string {
  return new Date().toISOString();
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readRawState(): Promise<TelegramControlState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as Partial<TelegramControlState>;
    return {
      principals: parsed.principals ?? [],
      chatBindings: parsed.chatBindings ?? [],
      pairingChallenges: parsed.pairingChallenges ?? [],
      pairingAttempts: parsed.pairingAttempts ?? [],
      callbackNonces: parsed.callbackNonces ?? [],
      eventCursors: parsed.eventCursors ?? [],
      processedUpdates: parsed.processedUpdates ?? [],
      auditLog: parsed.auditLog ?? [],
    };
  } catch {
    return emptyState();
  }
}

async function writeRawState(state: TelegramControlState): Promise<void> {
  const file = statePath();
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temp, file);
}

function pruneExpired(state: TelegramControlState): void {
  const now = Date.now();
  state.pairingChallenges = state.pairingChallenges.filter((challenge) => challenge.usedAt === null && Date.parse(challenge.expiresAt) > now);
  state.callbackNonces = state.callbackNonces.filter((nonce) => Date.parse(nonce.expiresAt) > now && nonce.usedAt === null);
  state.pairingAttempts = (state.pairingAttempts ?? []).filter((attempt) => {
    const lockActive = attempt.lockedUntil !== null && Date.parse(attempt.lockedUntil) > now;
    const windowActive = Date.parse(attempt.windowStartedAt) + PAIRING_ATTEMPT_WINDOW_MS > now;
    return lockActive || windowActive;
  });
  state.processedUpdates = (state.processedUpdates ?? []).slice(-PROCESSED_UPDATE_RETENTION);
  state.auditLog = state.auditLog.slice(-500);
}

export async function readTelegramControlState(): Promise<TelegramControlState> {
  const state = await readRawState();
  pruneExpired(state);
  return state;
}

export async function mutateTelegramControlState<T>(mutator: Mutator<T>): Promise<T> {
  let release!: () => void;
  const nextLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = stateLock;
  stateLock = previous.then(() => nextLock);
  await previous;
  try {
    const state = await readRawState();
    pruneExpired(state);
    const result = mutator(state);
    pruneExpired(state);
    await writeRawState(state);
    return result;
  } finally {
    release();
  }
}

export async function createTelegramPairingChallenge(role: TelegramControlRole = "operator", ttlMinutes = 10): Promise<{ code: string; challenge: TelegramPairingChallenge }> {
  const code = randomBytes(8).toString("hex").toUpperCase();
  const challenge: TelegramPairingChallenge = {
    codeHash: hashSecret(code),
    role,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString(),
    usedAt: null,
  };
  await mutateTelegramControlState((state) => {
    state.pairingChallenges.push(challenge);
  });
  return { code, challenge };
}

export function verifyPairingCode(challenge: TelegramPairingChallenge, code: string): boolean {
  return constantTimeEqual(challenge.codeHash, hashSecret(code.trim().toUpperCase()));
}

export async function createTelegramCallbackNonce(input: {
  telegramUserId: string;
  telegramChatId: string;
  action: string;
  targetId: string;
  ttlMinutes?: number;
}): Promise<string> {
  const nonce = randomBytes(12).toString("base64url");
  const record: TelegramCallbackNonce = {
    nonceHash: hashSecret(nonce),
    telegramUserId: input.telegramUserId,
    telegramChatId: input.telegramChatId,
    action: input.action,
    targetId: input.targetId,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + (input.ttlMinutes ?? 15) * 60 * 1000).toISOString(),
    usedAt: null,
  };
  await mutateTelegramControlState((state) => {
    state.callbackNonces.push(record);
  });
  return nonce;
}

export function callbackNonceMatches(record: TelegramCallbackNonce, nonce: string): boolean {
  return constantTimeEqual(record.nonceHash, hashSecret(nonce));
}

export function createAuditId(): string {
  return randomUUID();
}

export function pairingLockoutUntil(state: TelegramControlState, telegramUserId: string): string | null {
  const attempt = (state.pairingAttempts ?? []).find((candidate) => candidate.telegramUserId === telegramUserId);
  if (attempt?.lockedUntil != null && Date.parse(attempt.lockedUntil) > Date.now()) {
    return attempt.lockedUntil;
  }
  return null;
}

export function registerPairingFailure(state: TelegramControlState, telegramUserId: string): void {
  const now = Date.now();
  state.pairingAttempts ??= [];
  let attempt = state.pairingAttempts.find((candidate) => candidate.telegramUserId === telegramUserId);
  if (attempt === undefined) {
    attempt = { telegramUserId, failedCount: 0, windowStartedAt: new Date(now).toISOString(), lockedUntil: null };
    state.pairingAttempts.push(attempt);
  }
  if (Date.parse(attempt.windowStartedAt) + PAIRING_ATTEMPT_WINDOW_MS <= now && (attempt.lockedUntil === null || Date.parse(attempt.lockedUntil) <= now)) {
    attempt.failedCount = 0;
    attempt.windowStartedAt = new Date(now).toISOString();
    attempt.lockedUntil = null;
  }
  attempt.failedCount += 1;
  if (attempt.failedCount >= PAIRING_MAX_FAILED_ATTEMPTS) {
    attempt.lockedUntil = new Date(now + PAIRING_LOCKOUT_MS).toISOString();
  }
}

export function clearPairingAttempts(state: TelegramControlState, telegramUserId: string): void {
  state.pairingAttempts = (state.pairingAttempts ?? []).filter((candidate) => candidate.telegramUserId !== telegramUserId);
}

export async function claimTelegramUpdateId(updateId: number): Promise<boolean> {
  return mutateTelegramControlState((state) => {
    state.processedUpdates ??= [];
    if (state.processedUpdates.some((candidate) => candidate.updateId === updateId)) {
      return false;
    }
    state.processedUpdates.push({ updateId, at: nowIso() });
    if (state.processedUpdates.length > PROCESSED_UPDATE_RETENTION) {
      state.processedUpdates = state.processedUpdates.slice(-PROCESSED_UPDATE_RETENTION);
    }
    return true;
  });
}
