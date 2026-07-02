import { NextRequest, NextResponse } from "next/server";
import { collectTelegramNotifications } from "@/lib/server/telegram-control/notifications";
import { isWorkerAuthorized } from "@/lib/server/telegram-control/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isWorkerAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, error: "Unauthorized Telegram control worker." }, { status: 401 });
  }
  const notifications = await collectTelegramNotifications();
  return NextResponse.json({ ok: true, data: { notifications } });
}
