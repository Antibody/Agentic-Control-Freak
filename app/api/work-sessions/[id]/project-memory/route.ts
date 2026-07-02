import { NextResponse } from "next/server";
import { createManualProjectMemory, listProjectMemories } from "@/lib/server/project-memory";
import type { ProjectMemoryCategory, ProjectMemoryScope, ProjectMemoryStatus } from "@/lib/shared/types";

export const runtime = "nodejs";

const categories = new Set<ProjectMemoryCategory>(["architecture", "style", "constraint", "verification", "decision", "handoff"]);
const scopes = new Set<ProjectMemoryScope>(["project", "session", "lineage"]);
const statuses = new Set<ProjectMemoryStatus>(["active", "candidate", "dismissed"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const params = await context.params;
    const memories = await listProjectMemories(params.id);
    return NextResponse.json({ ok: true, data: { memories } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load project memory.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = await request.json() as unknown;
    if (!isObject(body) || typeof body.content !== "string") {
      return NextResponse.json({ ok: false, error: "Project memory content is required." }, { status: 400 });
    }
    const category = typeof body.category === "string" && categories.has(body.category as ProjectMemoryCategory)
      ? body.category as ProjectMemoryCategory
      : undefined;
    const scope = typeof body.scope === "string" && scopes.has(body.scope as ProjectMemoryScope)
      ? body.scope as ProjectMemoryScope
      : undefined;
    const status = typeof body.status === "string" && statuses.has(body.status as ProjectMemoryStatus)
      ? body.status as ProjectMemoryStatus
      : undefined;
    const memory = await createManualProjectMemory({
      workSessionId: params.id,
      content: body.content,
      category,
      scope,
      status,
      pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
    });
    return NextResponse.json({ ok: true, data: { memory } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create project memory.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
