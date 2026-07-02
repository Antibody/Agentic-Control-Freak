import { NextResponse } from "next/server";
import { readAppState } from "@/lib/server/db/file-db";
import { sweepExpiredPreviewIdleStops } from "@/lib/server/preview-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  await sweepExpiredPreviewIdleStops("app-state");
  const state = await readAppState();
  return NextResponse.json({ ok: true, data: state });
}
