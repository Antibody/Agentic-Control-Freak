import { NextRequest, NextResponse } from "next/server";
import { forkWorkSession } from "@/lib/server/work-session-fork";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ForkRequest {
  checkpointId?: string | null;
  handoffId?: string | null;
  planId?: string | null;
  title?: string;
}

function isForkRequest(value: unknown): value is ForkRequest {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.checkpointId === undefined || candidate.checkpointId === null || typeof candidate.checkpointId === "string") &&
    (candidate.handoffId === undefined || candidate.handoffId === null || typeof candidate.handoffId === "string") &&
    (candidate.planId === undefined || candidate.planId === null || typeof candidate.planId === "string") &&
    (candidate.title === undefined || typeof candidate.title === "string")
  );
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = (await request.json().catch(() => null)) as unknown;
    if (!isForkRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid fork request." }, { status: 400 });
    }
    const checkpointId = typeof body?.checkpointId === "string" && body.checkpointId.trim().length > 0
      ? body.checkpointId.trim()
      : null;
    const handoffId = typeof body?.handoffId === "string" && body.handoffId.trim().length > 0
      ? body.handoffId.trim()
      : null;
    const planId = typeof body?.planId === "string" && body.planId.trim().length > 0
      ? body.planId.trim()
      : null;
    const forkPointCount = [checkpointId, handoffId, planId].filter((value) => value !== null).length;
    if (forkPointCount > 1) {
      return NextResponse.json({ ok: false, error: "Fork from a checkpoint, handoff, or approved plan, not more than one." }, { status: 400 });
    }
    const title = typeof body?.title === "string" ? body.title : undefined;
    const result = await forkWorkSession({ workSessionId: params.id, checkpointId, handoffId, planId, title });
    return NextResponse.json({
      ok: true,
      data: {
        projectId: result.project.id,
        runtimeProfileId: result.runtimeProfile.id,
        chatSessionId: result.chatSession.id,
        workSessionId: result.workSession.id,
        forkedFromWorkSessionId: result.forkedFromWorkSessionId,
        forkedFromCheckpointId: result.forkedFromCheckpointId,
        forkedFromHandoffId: result.forkedFromHandoffId,
        forkedFromPlanId: result.forkedFromPlanId,
        baselineCheckpointId: result.baselineCheckpoint?.id ?? null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown fork error.";
    const status = message.includes("not found") ? 404 : message.includes("running") || message.includes("active") ? 409 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
