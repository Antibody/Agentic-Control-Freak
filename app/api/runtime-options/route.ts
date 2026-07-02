import { NextRequest, NextResponse } from "next/server";
import { runtimeProviderFor, runtimeProviderIds } from "@/lib/server/runtime-providers/registry";
import type { AgentProvider } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const forceRefresh = request.nextUrl.searchParams.get("refresh") === "1";
    const requestedProvider = request.nextUrl.searchParams.get("provider") as AgentProvider | null;
    const provider = requestedProvider !== null && runtimeProviderIds().includes(requestedProvider)
      ? requestedProvider
      : "codex-cli";
    const options = await runtimeProviderFor(provider).getOptions({ forceRefresh });
    return NextResponse.json({
      ok: true,
      data: {
        ...options,
        provider,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown runtime options error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
