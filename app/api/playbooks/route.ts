import { NextRequest, NextResponse } from "next/server";
import { createPlaybookRecord, getDatabaseSnapshot, mutateDatabase } from "@/lib/server/db/file-db";
import type { PlaybookStatus } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const statuses: PlaybookStatus[] = ["draft", "approved", "archived"];

function parseString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseTags(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean).slice(0, 12)
    : [];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const status = request.nextUrl.searchParams.get("status");
  const projectId = request.nextUrl.searchParams.get("projectId");
  const db = await getDatabaseSnapshot();
  const playbooks = db.playbooks
    .filter((playbook) => (statuses.includes(status as PlaybookStatus) ? playbook.status === status : true))
    .filter((playbook) => (projectId !== null ? playbook.projectId === projectId || playbook.projectId === null : true))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return NextResponse.json({ ok: true, data: playbooks });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const title = parseString(body.title, 120);
    const trigger = parseString(body.trigger, 1000);
    const procedure = parseString(body.procedure, 12000);
    if (title.length === 0 || trigger.length === 0 || procedure.length === 0) {
      return NextResponse.json({ ok: false, error: "title, trigger, and procedure are required." }, { status: 400 });
    }
    const status = statuses.includes(body.status as PlaybookStatus) ? body.status as PlaybookStatus : "draft";
    const playbook = await mutateDatabase((db) => {
      const record = createPlaybookRecord({
        projectId: parseString(body.projectId, 120) || null,
        workSessionId: parseString(body.workSessionId, 120) || null,
        title,
        trigger,
        procedure,
        tags: parseTags(body.tags),
        status,
        sourceAgentRunId: parseString(body.sourceAgentRunId, 120) || null,
        sourceTaskId: parseString(body.sourceTaskId, 120) || null,
      });
      db.playbooks.push(record);
      return record;
    });
    return NextResponse.json({ ok: true, data: playbook });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown playbooks API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
