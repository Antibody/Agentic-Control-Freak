import { NextRequest, NextResponse } from "next/server";
import { resetWorkspaceToGenerated } from "@/lib/server/workspace-selection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body === null || typeof (body as { workSessionId?: unknown }).workSessionId !== "string") {
      return NextResponse.json({ ok: false, error: "Invalid generated workspace request." }, { status: 400 });
    }
    const result = await resetWorkspaceToGenerated((body as { workSessionId: string }).workSessionId);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown generated workspace reset error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
