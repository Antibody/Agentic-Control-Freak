import { NextRequest, NextResponse } from "next/server";
import { startGithubDeviceAuth } from "@/lib/server/github-auth";
import { emitEvent } from "@/lib/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface StartRequest {
  scopes?: string[];
  workSessionId?: string | null;
}

function isStartRequest(value: unknown): value is StartRequest {
  return typeof value === "object" && value !== null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => ({}))) as unknown;
    if (!isStartRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid GitHub auth request." }, { status: 400 });
    }
    const result = await startGithubDeviceAuth();
    if (typeof body.workSessionId === "string" && body.workSessionId.length > 0) {
      await emitEvent({
        workSessionId: body.workSessionId,
        eventName: "github.auth.started",
        aggregateType: "github_auth",
        aggregateId: null,
        payload: { message: "GitHub device login started." },
      });
    }
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub auth error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
