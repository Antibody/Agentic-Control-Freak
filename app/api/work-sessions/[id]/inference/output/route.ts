import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { getConfig } from "@/lib/server/config";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { resolveSandboxFile } from "@/lib/server/ml/inference-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeMime(raw: string | null): string {
  if (raw !== null && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(raw)) {
    return raw;
  }
  return "application/octet-stream";
}

function safeFilename(rel: string): string {
  const base = rel.split("/").pop() ?? "output";
  return base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "output";
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const config = getConfig();
    if (!config.mlPipelineEnabled) {
      return NextResponse.json({ ok: false, error: "The ML pipeline is disabled." }, { status: 400 });
    }
    const snapshot = await getDatabaseSnapshot();
    const workSession = snapshot.workSessions.find((session) => session.id === id);
    if (workSession === undefined) {
      return NextResponse.json({ ok: false, error: "Work session was not found." }, { status: 404 });
    }
    const rel = request.nextUrl.searchParams.get("path") ?? "";
    if (rel.length === 0) {
      return NextResponse.json({ ok: false, error: "Missing path." }, { status: 400 });
    }
    const absolute = resolveSandboxFile(workSession.activeWorktreePath, rel);
    if (absolute === null) {
      return NextResponse.json({ ok: false, error: "Invalid output path." }, { status: 400 });
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      return NextResponse.json({ ok: false, error: "Output file was not found." }, { status: 404 });
    }
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": safeMime(request.nextUrl.searchParams.get("mime")),
        "content-disposition": `inline; filename="${safeFilename(rel)}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown inference output error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
