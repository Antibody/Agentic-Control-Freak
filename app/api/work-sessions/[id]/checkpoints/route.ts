import { NextResponse } from "next/server";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const params = await context.params;
  const db = await getDatabaseSnapshot();
  const workSession = db.workSessions.find((candidate) => candidate.id === params.id);
  if (workSession === undefined) {
    return NextResponse.json({ ok: false, error: "Work session was not found." }, { status: 404 });
  }
  const checkpoints = db.checkpoints
    .filter((checkpoint) => checkpoint.workSessionId === params.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return NextResponse.json({ ok: true, data: { checkpoints, currentCheckpointId: workSession.checkpointRef } });
}
