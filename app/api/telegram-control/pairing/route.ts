import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/server/config";
import { createTelegramPairingChallenge } from "@/lib/server/telegram-control/state";
import { isWorkerAuthorized } from "@/lib/server/telegram-control/security";
import type { TelegramControlRole } from "@/lib/server/telegram-control/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseRole(value: unknown): TelegramControlRole {
  return value === "viewer" || value === "operator" || value === "admin" ? value : "operator";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!getConfig().telegramControlEnabled) {
    return NextResponse.json({ ok: false, error: "Telegram control is disabled." }, { status: 409 });
  }
  if (!isWorkerAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, error: "Unauthorized Telegram control pairing request." }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const ttlMinutes = typeof body.ttlMinutes === "number" && Number.isFinite(body.ttlMinutes)
    ? Math.max(1, Math.min(60, Math.floor(body.ttlMinutes)))
    : 10;
  const created = await createTelegramPairingChallenge(parseRole(body.role), ttlMinutes);
  return NextResponse.json({
    ok: true,
    data: {
      code: created.code,
      role: created.challenge.role,
      expiresAt: created.challenge.expiresAt,
      usage: `/pair ${created.code}`,
    },
  });
}
