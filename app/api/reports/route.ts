import { NextResponse } from "next/server";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isReportArtifact(metadata: Record<string, unknown>, artifactKind: string): boolean {
  return ["report", "verification", "handoff"].includes(artifactKind) || typeof metadata.reportType === "string" || typeof metadata.artifactRole === "string";
}

export async function GET(): Promise<NextResponse> {
  try {
    const db = await getDatabaseSnapshot();
    const reports = db.artifacts
      .filter((artifact) => isReportArtifact(artifact.metadata, artifact.artifactKind))
      .map((artifact) => {
        const workSession = db.workSessions.find((session) => session.id === artifact.workSessionId) ?? null;
        const project = workSession === null ? null : db.projects.find((candidate) => candidate.id === workSession.projectId) ?? null;
        return {
          ...artifact,
          projectId: project?.id ?? null,
          projectName: project?.name ?? null,
          workSessionState: workSession?.currentState ?? null,
          reportType: typeof artifact.metadata.reportType === "string"
            ? artifact.metadata.reportType
            : typeof artifact.metadata.artifactRole === "string" ? artifact.metadata.artifactRole : artifact.artifactKind,
          summary: typeof artifact.metadata.summary === "string" ? artifact.metadata.summary : null,
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return NextResponse.json({ ok: true, data: reports });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown reports API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
