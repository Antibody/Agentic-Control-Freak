import { NextRequest, NextResponse } from "next/server";
import { currentTimestamp, mutateDatabase } from "@/lib/server/db/file-db";
import type { PlaybookStatus } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const statuses: PlaybookStatus[] = ["draft", "approved", "archived"];

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === "string" ? value.trim().slice(0, max) : undefined;
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const updated = await mutateDatabase((db) => {
      const playbook = db.playbooks.find((candidate) => candidate.id === id) ?? null;
      if (playbook === null) return null;
      const title = optionalString(body.title, 120);
      const trigger = optionalString(body.trigger, 1000);
      const procedure = optionalString(body.procedure, 12000);
      if (title !== undefined && title.length > 0) playbook.title = title;
      if (trigger !== undefined && trigger.length > 0) playbook.trigger = trigger;
      if (procedure !== undefined && procedure.length > 0) playbook.procedure = procedure;
      if (Array.isArray(body.tags)) {
        playbook.tags = body.tags.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean).slice(0, 12);
      }
      if (statuses.includes(body.status as PlaybookStatus)) {
        playbook.status = body.status as PlaybookStatus;
      }
      playbook.updatedAt = currentTimestamp();
      return playbook;
    });
    if (updated === null) {
      return NextResponse.json({ ok: false, error: "Playbook not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, data: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown playbook API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
