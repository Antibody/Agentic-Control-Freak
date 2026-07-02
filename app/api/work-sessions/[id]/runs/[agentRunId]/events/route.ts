import { NextRequest, NextResponse } from "next/server";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; agentRunId: string }>;
}

function createdAfter(value: string, since: string | null): boolean {
  if (since === null || since.trim().length === 0) return true;
  const sinceMs = new Date(since).getTime();
  const valueMs = new Date(value).getTime();
  return Number.isFinite(sinceMs) && Number.isFinite(valueMs) ? valueMs > sinceMs : true;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { id, agentRunId } = await context.params;
    const since = request.nextUrl.searchParams.get("since");
    const db = await getDatabaseSnapshot();
    const agentRun = db.agentRuns.find((run) => run.id === agentRunId && run.workSessionId === id) ?? null;
    if (agentRun === null) {
      return NextResponse.json({ ok: false, error: "Agent run not found." }, { status: 404 });
    }
    const events = db.eventLog
      .filter((event) => event.workSessionId === id && event.context.agentRunId === agentRunId && createdAfter(event.createdAt, since))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const tools = db.toolRuns
      .filter((tool) => tool.agentRunId === agentRunId)
      .sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    const artifacts = db.artifacts
      .filter((artifact) => artifact.workSessionId === id && artifact.metadata.agentRunId === agentRunId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return NextResponse.json({ ok: true, data: { agentRun, events, tools, artifacts } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown run events API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
