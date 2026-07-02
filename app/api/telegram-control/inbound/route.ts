import { NextRequest, NextResponse } from "next/server";
import { dispatchTelegramUpdate } from "@/lib/server/telegram-control/dispatcher";
import { isWorkerAuthorized } from "@/lib/server/telegram-control/security";
import type { TelegramInboundUpdate } from "@/lib/server/telegram-control/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isInboundUpdate(value: unknown): value is TelegramInboundUpdate {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "message") {
    return (
      typeof candidate.updateId === "number" &&
      typeof candidate.messageId === "number" &&
      typeof candidate.chatId === "string" &&
      typeof candidate.chatType === "string" &&
      (candidate.fromId === null || typeof candidate.fromId === "string") &&
      typeof candidate.text === "string"
    );
  }
  if (candidate.kind === "callback") {
    return (
      typeof candidate.updateId === "number" &&
      typeof candidate.callbackQueryId === "string" &&
      (candidate.messageId === null || typeof candidate.messageId === "number") &&
      (candidate.chatId === null || typeof candidate.chatId === "string") &&
      typeof candidate.fromId === "string" &&
      typeof candidate.data === "string"
    );
  }
  return false;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isWorkerAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, error: "Unauthorized Telegram control worker." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as unknown;
  if (!isInboundUpdate(body)) {
    return NextResponse.json({ ok: false, error: "Invalid Telegram inbound update." }, { status: 400 });
  }
  const result = await dispatchTelegramUpdate(body);
  return NextResponse.json(result);
}
