import { NextRequest, NextResponse } from "next/server";
import { continueTimedOutTask, editTask, rerunTask, skipTask, type TaskEdit } from "@/lib/server/workflow-controller";
import { EDITABLE_TASK_KINDS, RISK_LEVELS } from "@/lib/shared/plan";
import type { PlanTaskKind, RiskLevel } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string; taskId: string }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
}

function normalizeTaskEdit(value: unknown): TaskEdit | null {
  if (!isObject(value)) {
    return null;
  }
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (title.length === 0 || description.length === 0) {
    return null;
  }
  const taskKind = (EDITABLE_TASK_KINDS as readonly string[]).includes(value.taskKind as string)
    ? (value.taskKind as PlanTaskKind)
    : "modify";
  const riskLevel = (RISK_LEVELS as readonly string[]).includes(value.riskLevel as string)
    ? (value.riskLevel as RiskLevel)
    : "low";
  return {
    title,
    description,
    objective: typeof value.objective === "string" && value.objective.trim().length > 0 ? value.objective.trim() : description,
    taskKind,
    targetFiles: stringArray(value.targetFiles),
    expectedChanges: stringArray(value.expectedChanges),
    acceptanceCriteria: stringArray(value.acceptanceCriteria),
    verificationHints: stringArray(value.verificationHints),
    riskLevel,
  };
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = (await request.json().catch(() => null)) as unknown;
    const action = isObject(body) ? body.action : undefined;

    if (action === "rerun") {
      const note = isObject(body) && typeof body.note === "string" ? body.note : null;
      const result = await rerunTask({ workSessionId: params.id, taskId: params.taskId, note });
      return NextResponse.json({ ok: true, data: result });
    }

    if (action === "skip") {
      const result = await skipTask({ workSessionId: params.id, taskId: params.taskId });
      return NextResponse.json({ ok: true, data: result });
    }

    if (action === "continue-timeout") {
      const result = await continueTimedOutTask({ workSessionId: params.id, taskId: params.taskId });
      return NextResponse.json({ ok: true, data: result });
    }

    if (action === "edit") {
      const edit = normalizeTaskEdit(isObject(body) ? body.task : null);
      if (edit === null) {
        return NextResponse.json({ ok: false, error: "Invalid task edit: title and description are required." }, { status: 400 });
      }
      const result = await editTask({ workSessionId: params.id, taskId: params.taskId, edit });
      return NextResponse.json({ ok: true, data: result });
    }

    return NextResponse.json({ ok: false, error: "Unsupported task action." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown task action error.";
    const status = message.includes("not found")
      ? 404
      : message.includes("does not belong") || message.includes("Only not-started")
        ? 400
        : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
