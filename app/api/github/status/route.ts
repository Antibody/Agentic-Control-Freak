import { NextResponse } from "next/server";
import { githubAuthStatus } from "@/lib/server/github-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ ok: true, data: await githubAuthStatus() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub status error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
