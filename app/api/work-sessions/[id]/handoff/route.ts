import { NextRequest, NextResponse } from "next/server";
import { forceHandoff } from "@/lib/server/workflow-controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const result = await forceHandoff(params.id);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown handoff API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
