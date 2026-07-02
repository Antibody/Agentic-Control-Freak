import { NextRequest, NextResponse } from "next/server";
import { resetDatabase } from "@/lib/server/db/file-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const resetConfirmation = "delete database";

function hasResetConfirmation(value: unknown): value is { confirmation: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "confirmation" in value &&
    value.confirmation === resetConfirmation
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!hasResetConfirmation(body)) {
    return NextResponse.json(
      { ok: false, error: `Reset requires typing "${resetConfirmation}".` },
      { status: 400 },
    );
  }
  const db = await resetDatabase();
  return NextResponse.json({ ok: true, data: { projects: db.projects.length, workSessions: db.workSessions.length } });
}
