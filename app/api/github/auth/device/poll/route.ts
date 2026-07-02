import { NextRequest, NextResponse } from "next/server";
import { pollGithubDeviceAuth } from "@/lib/server/github-auth";
import { emitEvent } from "@/lib/server/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PollRequest {
  deviceCode?: string;
  workSessionId?: string | null;
}

function isPollRequest(value: unknown): value is PollRequest {
  return typeof value === "object" && value !== null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json().catch(() => null)) as unknown;
    if (!isPollRequest(body) || typeof body.deviceCode !== "string" || body.deviceCode.trim().length === 0) {
      return NextResponse.json({ ok: false, error: "Invalid GitHub device code." }, { status: 400 });
    }
    const result = await pollGithubDeviceAuth(body.deviceCode.trim());
    if (result.status === "complete" && typeof body.workSessionId === "string" && body.workSessionId.length > 0) {
      await emitEvent({
        workSessionId: body.workSessionId,
        eventName: "github.auth.completed",
        aggregateType: "github_auth",
        aggregateId: null,
        payload: { message: `Connected GitHub as ${result.account?.login ?? "unknown"}.` },
      });
    }
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub auth error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
