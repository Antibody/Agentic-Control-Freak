import { NextResponse } from "next/server";
import { deleteProjectMemory, updateProjectMemory } from "@/lib/server/project-memory";
import type { ProjectMemoryCategory, ProjectMemoryScope, ProjectMemoryStatus } from "@/lib/shared/types";

export const runtime = "nodejs";

const categories = new Set<ProjectMemoryCategory>(["architecture", "style", "constraint", "verification", "decision", "handoff"]);
const scopes = new Set<ProjectMemoryScope>(["project", "session", "lineage"]);
const statuses = new Set<ProjectMemoryStatus>(["active", "candidate", "dismissed"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string; memoryId: string }> }): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = await request.json() as unknown;
    if (!isObject(body)) {
      return NextResponse.json({ ok: false, error: "Patch body is required." }, { status: 400 });
    }
    const memory = await updateProjectMemory({
      workSessionId: params.id,
      memoryId: params.memoryId,
      content: typeof body.content === "string" ? body.content : undefined,
      category: typeof body.category === "string" && categories.has(body.category as ProjectMemoryCategory) ? body.category as ProjectMemoryCategory : undefined,
      scope: typeof body.scope === "string" && scopes.has(body.scope as ProjectMemoryScope) ? body.scope as ProjectMemoryScope : undefined,
      status: typeof body.status === "string" && statuses.has(body.status as ProjectMemoryStatus) ? body.status as ProjectMemoryStatus : undefined,
      pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
    });
    return NextResponse.json({ ok: true, data: { memory } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update project memory.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; memoryId: string }> }): Promise<NextResponse> {
  try {
    const params = await context.params;
    await deleteProjectMemory(params.id, params.memoryId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete project memory.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
