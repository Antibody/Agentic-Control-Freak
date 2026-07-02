import { timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/server/config";
import type { TelegramControlRole, TelegramControlState, TelegramInboundUpdate, TelegramPrincipal } from "@/lib/server/telegram-control/types";

const roleRank: Record<TelegramControlRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

export function hasRole(principal: TelegramPrincipal, required: TelegramControlRole): boolean {
  return principal.revokedAt === null && roleRank[principal.role] >= roleRank[required];
}

const MIN_WORKER_TOKEN_LENGTH = 24;

export function isWorkerAuthorized(headerValue: string | null): boolean {
  const configured = getConfig().telegramControlWorkerToken;
  if (configured.trim().length < MIN_WORKER_TOKEN_LENGTH || headerValue === null) {
    return false;
  }
  const prefix = "Bearer ";
  if (!headerValue.startsWith(prefix)) {
    return false;
  }
  const provided = headerValue.slice(prefix.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function findAuthorizedPrincipal(state: TelegramControlState, userId: string | null): TelegramPrincipal | null {
  if (userId === null) {
    return null;
  }
  const config = getConfig();
  const envAllowed = config.telegramControlAllowedUserIds.includes(userId);
  const stored = state.principals.find((principal) => principal.telegramUserId === userId) ?? null;
  if (stored !== null) {
    return stored.revokedAt === null ? stored : null;
  }
  if (!envAllowed) {
    return null;
  }
  return {
    telegramUserId: userId,
    role: "admin",
    firstName: null,
    username: null,
    createdAt: new Date(0).toISOString(),
    revokedAt: null,
  };
}

export function chatIsAllowed(update: TelegramInboundUpdate): boolean {
  const config = getConfig();
  const chatId = update.kind === "message" ? update.chatId : update.chatId;
  if (chatId === null) {
    return false;
  }
  if (update.kind === "message" && update.chatType !== "private") {
    return config.telegramControlGroupsEnabled && config.telegramControlAllowedChatIds.includes(chatId);
  }
  if (update.kind === "callback" && update.chatType !== null && update.chatType !== "private") {
    return config.telegramControlGroupsEnabled && config.telegramControlAllowedChatIds.includes(chatId);
  }
  return true;
}

export function requireMentionForGroup(update: TelegramInboundUpdate): boolean {
  if (update.kind !== "message") {
    return false;
  }
  return update.chatType !== "private" && !update.text.startsWith("/");
}
