import { NextResponse } from "next/server";
import { clearGithubAuth } from "@/lib/server/github-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  try {
    await clearGithubAuth();
    return NextResponse.json({ ok: true, data: { loggedOut: true } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub logout error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
