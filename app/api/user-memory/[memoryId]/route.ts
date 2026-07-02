import { NextResponse } from "next/server";
import { deleteUserMemory, updateUserMemory } from "@/lib/server/user-memory";
import type { UserMemoryStatus } from "@/lib/shared/types";

export const runtime = "nodejs";

const statuses = new Set<UserMemoryStatus>(["active", "dismissed"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function PATCH(request: Request, context: { params: Promise<{ memoryId: string }> }): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = await request.json() as unknown;
    if (!isObject(body)) {
      return NextResponse.json({ ok: false, error: "Patch body is required." }, { status: 400 });
    }
    const memory = await updateUserMemory({
      memoryId: params.memoryId,
      content: typeof body.content === "string" ? body.content : undefined,
      status: typeof body.status === "string" && statuses.has(body.status as UserMemoryStatus) ? body.status as UserMemoryStatus : undefined,
      pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
    });
    return NextResponse.json({ ok: true, data: { memory } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update user memory.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ memoryId: string }> }): Promise<NextResponse> {
  try {
    const params = await context.params;
    await deleteUserMemory(params.memoryId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to delete user memory.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
