import { NextRequest, NextResponse } from "next/server";
import { getSessionFileDiff } from "@/lib/server/session-changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const handoffId = request.nextUrl.searchParams.get("handoffId");
    const filePath = request.nextUrl.searchParams.get("filePath");
    if (handoffId === null || handoffId.trim().length === 0) {
      return NextResponse.json({ ok: false, error: "handoffId is required." }, { status: 400 });
    }
    if (filePath === null || filePath.trim().length === 0) {
      return NextResponse.json({ ok: false, error: "filePath is required." }, { status: 400 });
    }
    const result = await getSessionFileDiff({ workSessionId: params.id, handoffId, filePath });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown diff API error.";
    const status = message.includes("not found") || message.includes("not part") ? 404 : message.includes("Invalid") ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
