import { NextRequest, NextResponse } from "next/server";
import { createProjectBundle } from "@/lib/server/projects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateProjectRequest {
  name: string;
  slug: string;
  localRepoPath?: string;
  repoUrl?: string;
}

function isCreateProjectRequest(value: unknown): value is CreateProjectRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    typeof candidate.slug === "string" &&
    (candidate.localRepoPath === undefined || typeof candidate.localRepoPath === "string") &&
    (candidate.repoUrl === undefined || typeof candidate.repoUrl === "string")
  );
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as unknown;
    if (!isCreateProjectRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid project request." }, { status: 400 });
    }
    const created = await createProjectBundle(body);
    return NextResponse.json({ ok: true, data: created });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown project API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
