import type { DomainEventName, Identifier } from "@/lib/shared/types";

export type TelegramControlRole = "viewer" | "operator" | "admin";

export interface TelegramPrincipal {
  telegramUserId: string;
  role: TelegramControlRole;
  firstName: string | null;
  username: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface TelegramChatBinding {
  telegramChatId: string;
  telegramUserId: string;
  workSessionId: Identifier;
  createdAt: string;
  updatedAt: string;
}

export interface TelegramPairingChallenge {
  codeHash: string;
  role: TelegramControlRole;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export interface TelegramCallbackNonce {
  nonceHash: string;
  telegramUserId: string;
  telegramChatId: string;
  action: string;
  targetId: string;
  expiresAt: string;
  createdAt: string;
  usedAt: string | null;
}

export interface TelegramEventCursor {
  telegramChatId: string;
  workSessionId: Identifier | null;
  lastEventId: Identifier | null;
  updatedAt: string;
}

export interface TelegramPairingAttempt {
  telegramUserId: string;
  failedCount: number;
  windowStartedAt: string;
  lockedUntil: string | null;
}

export interface TelegramProcessedUpdate {
  updateId: number;
  at: string;
}

export interface TelegramAuditRecord {
  id: Identifier;
  telegramUserId: string;
  telegramChatId: string;
  workSessionId: Identifier | null;
  command: string;
  ok: boolean;
  summary: string;
  createdAt: string;
}

export interface TelegramControlState {
  principals: TelegramPrincipal[];
  chatBindings: TelegramChatBinding[];
  pairingChallenges: TelegramPairingChallenge[];
  pairingAttempts: TelegramPairingAttempt[];
  callbackNonces: TelegramCallbackNonce[];
  eventCursors: TelegramEventCursor[];
  processedUpdates: TelegramProcessedUpdate[];
  auditLog: TelegramAuditRecord[];
}

export interface TelegramInboundMessage {
  kind: "message";
  updateId: number;
  messageId: number;
  chatId: string;
  chatType: "private" | "group" | "supergroup" | "channel";
  fromId: string | null;
  firstName?: string | null;
  username?: string | null;
  text: string;
}

export interface TelegramInboundCallback {
  kind: "callback";
  updateId: number;
  callbackQueryId: string;
  messageId: number | null;
  chatId: string | null;
  chatType: string | null;
  fromId: string;
  firstName?: string | null;
  username?: string | null;
  data: string;
}

export type TelegramInboundUpdate = TelegramInboundMessage | TelegramInboundCallback;

export interface TelegramButton {
  text: string;
  callbackData: string;
}

export interface TelegramBotEffect {
  type: "message" | "answerCallback";
  chatId?: string;
  callbackQueryId?: string;
  text: string;
  parseMode?: "HTML";
  buttons?: TelegramButton[][];
}

export interface TelegramControlResponse {
  ok: boolean;
  effects: TelegramBotEffect[];
  error?: string;
}

export interface TelegramMessageNotification {
  type: "message";
  chatId: string;
  text: string;
  parseMode?: "HTML";
  buttons?: TelegramButton[][];
  eventId: Identifier;
  eventName: DomainEventName;
}

export interface TelegramPhotoNotification {
  type: "photo";
  chatId: string;
  caption: string;
  parseMode?: "HTML";
  artifactId: Identifier;
  fileName: string;
  eventId: Identifier;
  eventName: DomainEventName;
}

export type TelegramNotification = TelegramMessageNotification | TelegramPhotoNotification;
