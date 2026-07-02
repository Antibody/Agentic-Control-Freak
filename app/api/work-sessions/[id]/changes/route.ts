import { NextRequest, NextResponse } from "next/server";
import { getSessionChangeSet } from "@/lib/server/session-changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const handoffId = request.nextUrl.searchParams.get("handoffId");
    if (handoffId === null || handoffId.trim().length === 0) {
      return NextResponse.json({ ok: false, error: "handoffId is required." }, { status: 400 });
    }
    const result = await getSessionChangeSet({ workSessionId: params.id, handoffId });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown changed files API error.";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
