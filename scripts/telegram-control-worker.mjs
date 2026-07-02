import { Bot, InputFile } from "grammy";
import { loadEnvFiles } from "./load-env-file.mjs";
import { resolveTelegramEndpoint } from "./telegram-shared.mjs";

loadEnvFiles();

const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
const notificationIntervalMs = Number(process.env.TELEGRAM_CONTROL_NOTIFICATION_INTERVAL_MS ?? "3000");

if (!botToken) {
  throw new Error("TELEGRAM_BOT_TOKEN is required.");
}
const { appUrl, workerToken } = resolveTelegramEndpoint();

const bot = new Bot(botToken);

function headers() {
  return {
    authorization: `Bearer ${workerToken}`,
    "content-type": "application/json",
  };
}

async function postJson(path, body) {
  const response = await fetch(`${appUrl}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
    throw new Error(error);
  }
  return json;
}

async function getJson(path) {
  const response = await fetch(`${appUrl}${path}`, {
    method: "GET",
    headers: headers(),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
    throw new Error(error);
  }
  return json;
}

async function getBytes(path) {
  const response = await fetch(`${appUrl}${path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${workerToken}`,
    },
  });
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    const error = typeof json.error === "string" ? json.error : `HTTP ${response.status}`;
    throw new Error(error);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  return { bytes, contentType };
}

function keyboard(buttons) {
  if (!Array.isArray(buttons)) {
    return undefined;
  }
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.callbackData,
      })),
    ),
  };
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

async function applyEffects(effects) {
  for (const effect of effects ?? []) {
    if (effect.type === "answerCallback" && effect.callbackQueryId) {
      await bot.api.answerCallbackQuery(effect.callbackQueryId, { text: effect.text }).catch(() => undefined);
      continue;
    }
    if (effect.type === "message" && effect.chatId) {
      if (!hasText(effect.text)) {
        console.warn("[telegram-control] skipped empty bot effect message");
        continue;
      }
      await bot.api.sendMessage(effect.chatId, effect.text, {
        parse_mode: effect.parseMode,
        reply_markup: keyboard(effect.buttons),
        disable_web_page_preview: true,
      });
    }
  }
}

function normalizeMessage(ctx) {
  const msg = ctx.message;
  if (!msg || typeof msg.text !== "string") {
    return null;
  }
  return {
    kind: "message",
    updateId: ctx.update.update_id,
    messageId: msg.message_id,
    chatId: String(msg.chat.id),
    chatType: msg.chat.type,
    fromId: msg.from?.id === undefined ? null : String(msg.from.id),
    firstName: msg.from?.first_name ?? null,
    username: msg.from?.username ?? null,
    text: msg.text,
  };
}

function normalizeCallback(ctx) {
  const cb = ctx.callbackQuery;
  if (!cb || typeof cb.data !== "string") {
    return null;
  }
  return {
    kind: "callback",
    updateId: ctx.update.update_id,
    callbackQueryId: cb.id,
    messageId: cb.message?.message_id ?? null,
    chatId: cb.message?.chat?.id === undefined ? null : String(cb.message.chat.id),
    chatType: cb.message?.chat?.type ?? null,
    fromId: String(cb.from.id),
    firstName: cb.from.first_name ?? null,
    username: cb.from.username ?? null,
    data: cb.data,
  };
}

bot.on("message:text", async (ctx) => {
  const update = normalizeMessage(ctx);
  if (update === null) {
    return;
  }
  try {
    const result = await postJson("/api/telegram-control/inbound", update);
    await applyEffects(result.effects);
  } catch (error) {
    console.warn(`[telegram-control] inbound message failed: ${error instanceof Error ? error.message : String(error)}`);
    await ctx.reply("Telegram control error. Check the worker logs.").catch(() => undefined);
  }
});

bot.on("callback_query:data", async (ctx) => {
  const update = normalizeCallback(ctx);
  if (update === null) {
    return;
  }
  try {
    const result = await postJson("/api/telegram-control/inbound", update);
    await applyEffects(result.effects);
  } catch (error) {
    console.warn(`[telegram-control] callback failed: ${error instanceof Error ? error.message : String(error)}`);
    await ctx.answerCallbackQuery({ text: "Telegram control error." }).catch(() => undefined);
  }
});

async function pollNotifications() {
  try {
    const result = await getJson("/api/telegram-control/notifications");
    const notifications = result.data?.notifications ?? [];
    const byChat = new Map();
    for (const notification of notifications) {
      if (notification.type === "photo") {
        const artifact = await getBytes(`/api/telegram-control/artifacts/${encodeURIComponent(notification.artifactId)}?chatId=${encodeURIComponent(notification.chatId)}`);
        if (artifact.contentType !== "image/png") {
          throw new Error(`Unexpected Telegram screenshot content type: ${artifact.contentType}`);
        }
        await bot.api.sendPhoto(notification.chatId, new InputFile(artifact.bytes, notification.fileName ?? "preview-screenshot.png"), {
          caption: notification.caption,
          parse_mode: notification.parseMode,
        });
      } else {
        if (!hasText(notification.text)) {
          console.warn(`[telegram-control] skipped empty notification message for event ${notification.eventName ?? notification.eventId ?? "unknown"}`);
          const ids = byChat.get(notification.chatId) ?? [];
          ids.push(notification.eventId);
          byChat.set(notification.chatId, ids);
          continue;
        }
        await bot.api.sendMessage(notification.chatId, notification.text, {
          parse_mode: notification.parseMode,
          reply_markup: keyboard(notification.buttons),
          disable_web_page_preview: true,
        });
      }
      const ids = byChat.get(notification.chatId) ?? [];
      ids.push(notification.eventId);
      byChat.set(notification.chatId, ids);
    }
    for (const [chatId, eventIds] of byChat.entries()) {
      await postJson("/api/telegram-control/notifications/ack", { chatId, eventIds });
    }
  } catch (error) {
    console.warn(`[telegram-control] notification poll failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

setInterval(() => {
  void pollNotifications();
}, Number.isFinite(notificationIntervalMs) && notificationIntervalMs >= 1000 ? notificationIntervalMs : 3000);

bot.catch((error) => {
  console.error("[telegram-control] bot error", error.error);
});

console.log(`[telegram-control] polling Telegram and forwarding to ${appUrl}`);
await bot.start({
  allowed_updates: ["message", "callback_query"],
});
