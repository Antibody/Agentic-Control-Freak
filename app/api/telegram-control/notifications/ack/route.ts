import { NextRequest, NextResponse } from "next/server";
import { acknowledgeTelegramNotifications } from "@/lib/server/telegram-control/notifications";
import { isWorkerAuthorized } from "@/lib/server/telegram-control/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAckBody(value: unknown): value is { chatId: string; eventIds: string[] } {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.chatId === "string" && Array.isArray(candidate.eventIds) && candidate.eventIds.every((entry) => typeof entry === "string");
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isWorkerAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, error: "Unauthorized Telegram control worker." }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as unknown;
  if (!isAckBody(body)) {
    return NextResponse.json({ ok: false, error: "Invalid notification ack." }, { status: 400 });
  }
  await acknowledgeTelegramNotifications(body);
  return NextResponse.json({ ok: true });
}
