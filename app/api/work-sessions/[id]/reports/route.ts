import { NextRequest, NextResponse } from "next/server";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function reportType(metadata: Record<string, unknown>, artifactKind: string): string | null {
  if (typeof metadata.reportType === "string") return metadata.reportType;
  if (typeof metadata.artifactRole === "string") return metadata.artifactRole;
  if (artifactKind === "verification" || artifactKind === "handoff") return artifactKind;
  return artifactKind === "report" ? "report" : null;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const db = await getDatabaseSnapshot();
    const workSession = db.workSessions.find((session) => session.id === id) ?? null;
    if (workSession === null) {
      return NextResponse.json({ ok: false, error: "Work session not found." }, { status: 404 });
    }
    const reports = db.artifacts
      .filter((artifact) => artifact.workSessionId === id)
      .map((artifact) => ({ artifact, type: reportType(artifact.metadata, artifact.artifactKind) }))
      .filter((entry): entry is { artifact: typeof entry.artifact; type: string } => entry.type !== null)
      .map(({ artifact, type }) => ({
        ...artifact,
        reportType: type,
        summary: typeof artifact.metadata.summary === "string" ? artifact.metadata.summary : null,
      }))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return NextResponse.json({ ok: true, data: reports });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown work-session reports API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
