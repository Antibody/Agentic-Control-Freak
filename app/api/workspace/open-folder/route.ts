import { NextResponse } from "next/server";
import { openNativeWorkspaceFolder } from "@/lib/server/workspace-selection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  try {
    const result = await openNativeWorkspaceFolder();
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown workspace picker error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
