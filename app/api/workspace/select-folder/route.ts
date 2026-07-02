import { NextRequest, NextResponse } from "next/server";
import { inspectWorkspaceCandidate, selectWorkspaceFolder } from "@/lib/server/workspace-selection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SelectWorkspaceRequest {
  workSessionId: string;
  path: string;
  confirmedRisk?: boolean;
}

function isSelectWorkspaceRequest(value: unknown): value is SelectWorkspaceRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.workSessionId === "string" &&
    typeof candidate.path === "string" &&
    (candidate.confirmedRisk === undefined || typeof candidate.confirmedRisk === "boolean")
  );
}

function errorCandidate(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("candidate" in error)) {
    return null;
  }
  return (error as { candidate?: unknown }).candidate ?? null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as unknown;
    if (!isSelectWorkspaceRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid workspace selection request." }, { status: 400 });
    }
    const result = await selectWorkspaceFolder(body);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const candidate = errorCandidate(error);
    if (candidate !== null) {
      return NextResponse.json(
        { ok: false, error: "Workspace selection requires confirmation.", data: { candidate } },
        { status: 409 }
      );
    }
    const message = error instanceof Error ? error.message : "Unknown workspace selection error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body === null || typeof (body as { path?: unknown }).path !== "string") {
      return NextResponse.json({ ok: false, error: "Invalid workspace inspection request." }, { status: 400 });
    }
    const candidate = await inspectWorkspaceCandidate((body as { path: string }).path);
    return NextResponse.json({ ok: true, data: { candidate } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown workspace inspection error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
