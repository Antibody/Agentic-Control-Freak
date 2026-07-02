import { NextRequest, NextResponse } from "next/server";
import { importProject } from "@/lib/server/project-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const source = body.source;
    const name = optionalString(body.name);
    const confirmedRisk = body.confirmedRisk === true;

    if (source === "local") {
      const localPath = typeof body.localPath === "string" ? body.localPath : "";
      if (localPath.trim().length === 0) {
        return NextResponse.json({ ok: false, error: "Provide a folder path to import." }, { status: 400 });
      }
      const result = await importProject({ source: "local", localPath, name, confirmedRisk });
      return NextResponse.json({ ok: true, data: result });
    }

    if (source === "git") {
      const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : "";
      if (repoUrl.trim().length === 0) {
        return NextResponse.json({ ok: false, error: "Provide a repository URL to clone." }, { status: 400 });
      }
      const branch = optionalString(body.branch) ?? null;
      const result = await importProject({ source: "git", repoUrl, branch, name, confirmedRisk, signal: request.signal });
      return NextResponse.json({ ok: true, data: result });
    }

    return NextResponse.json({ ok: false, error: "Invalid import source." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown project import error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
