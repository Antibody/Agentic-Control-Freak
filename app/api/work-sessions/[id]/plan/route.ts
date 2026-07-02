import { NextRequest, NextResponse } from "next/server";
import { PlanNotEditableError, PlanValidationError, saveEditedPlanAndRun, setPlanStack } from "@/lib/server/workflow-controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function isPlanEditBody(value: unknown): value is { planId: string; planJson: Record<string, unknown> } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.planId === "string" &&
    candidate.planId.length > 0 &&
    typeof candidate.planJson === "object" &&
    candidate.planJson !== null
  );
}

function isSetStackBody(value: unknown): value is { planId: string; action: "set-stack"; stack: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.action === "set-stack" &&
    typeof candidate.planId === "string" &&
    candidate.planId.length > 0 &&
    typeof candidate.stack === "string" &&
    candidate.stack.length > 0
  );
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = (await request.json()) as unknown;
    if (isSetStackBody(body)) {
      const result = await setPlanStack({
        workSessionId: params.id,
        planId: body.planId,
        stack: body.stack,
      });
      return NextResponse.json({ ok: true, data: result });
    }
    if (!isPlanEditBody(body)) {
      return NextResponse.json({ ok: false, error: "Invalid plan edit request." }, { status: 400 });
    }
    const result = await saveEditedPlanAndRun({
      workSessionId: params.id,
      planId: body.planId,
      planJson: body.planJson,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    if (error instanceof PlanValidationError) {
      return NextResponse.json({ ok: false, error: error.errors.join(" ") }, { status: 400 });
    }
    if (error instanceof PlanNotEditableError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Unknown plan edit API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
