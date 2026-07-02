import { NextResponse } from "next/server";
import { createUserMemory, listUserMemories } from "@/lib/server/user-memory";
import type { UserMemoryStatus } from "@/lib/shared/types";

export const runtime = "nodejs";

const statuses = new Set<UserMemoryStatus>(["active", "dismissed"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function GET(): Promise<NextResponse> {
  try {
    const memories = await listUserMemories();
    return NextResponse.json({ ok: true, data: { memories } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load user memory.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json() as unknown;
    if (!isObject(body) || typeof body.content !== "string") {
      return NextResponse.json({ ok: false, error: "User memory content is required." }, { status: 400 });
    }
    const status = typeof body.status === "string" && statuses.has(body.status as UserMemoryStatus)
      ? body.status as UserMemoryStatus
      : undefined;
    const memory = await createUserMemory({
      content: body.content,
      status,
      pinned: typeof body.pinned === "boolean" ? body.pinned : undefined,
    });
    return NextResponse.json({ ok: true, data: { memory } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create user memory.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
