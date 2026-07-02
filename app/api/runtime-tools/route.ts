import { NextRequest, NextResponse } from "next/server";
import { toolCatalogForMode } from "@/lib/server/runtime/tool-catalog";
import type { ToolPolicyMode } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const modes: ToolPolicyMode[] = ["plan", "research", "execute", "repair"];

function parseMode(value: string | null): ToolPolicyMode {
  return modes.includes(value as ToolPolicyMode) ? value as ToolPolicyMode : "execute";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const mode = parseMode(request.nextUrl.searchParams.get("mode"));
  return NextResponse.json({ ok: true, data: { mode, tools: toolCatalogForMode(mode) } });
}
