import { NextRequest, NextResponse } from "next/server";
import { prepareGithubExport } from "@/lib/server/github-exporter";
import type { GithubExportSourceMode } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface PrepareRequest {
  sourceMode?: GithubExportSourceMode;
  checkpointId?: string | null;
}

function isPrepareRequest(value: unknown): value is PrepareRequest {
  return value === null || value === undefined || typeof value === "object";
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = (await request.json().catch(() => ({}))) as unknown;
    if (!isPrepareRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid GitHub export prepare request." }, { status: 400 });
    }
    const sourceMode = body?.sourceMode === "checkpoint" ? "checkpoint" : "current_workspace";
    const checkpointId = typeof body?.checkpointId === "string" && body.checkpointId.trim().length > 0 ? body.checkpointId.trim() : null;
    const result = await prepareGithubExport(params.id, sourceMode, checkpointId);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub export prepare error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
