import { NextRequest, NextResponse } from "next/server";
import { approveOrRejectApproval } from "@/lib/server/workflow-controller";
import { getDatabaseSnapshot, mutateDatabase, currentTimestamp, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { resolveWorkSessionProcessApproval } from "@/lib/server/runtime/process-registry";
import type { ApprovalPostRequest } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function isApprovalPostRequest(value: unknown): value is ApprovalPostRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.status === "approved" || candidate.status === "rejected") &&
    (candidate.note === undefined || typeof candidate.note === "string")
  );
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = (await request.json()) as unknown;
    if (!isApprovalPostRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid approval request." }, { status: 400 });
    }
    const snapshot = await getDatabaseSnapshot();
    const approval = snapshot.approvals.find((candidate) => candidate.id === params.id);
    if (approval !== undefined && approval.payload.codexAppServer === true) {
      if (approval.status !== "pending") {
        return NextResponse.json({ ok: false, error: "Approval is no longer pending." }, { status: 409 });
      }
      const live = await resolveWorkSessionProcessApproval(approval.workSessionId, {
        approvalId: approval.id,
        status: body.status,
        note: body.note,
      });
      if (!live.ok) {
        return NextResponse.json({ ok: false, error: live.message }, { status: 409 });
      }
      const updated = await mutateDatabase((db) => {
        const record = db.approvals.find((candidate) => candidate.id === approval.id);
        if (record === undefined) {
          throw new Error("Approval was not found.");
        }
        record.status = body.status;
        record.resolvedAt = currentTimestamp();
        record.resolvedBy = db.users[0]?.id ?? null;
        const run = record.agentRunId === null ? undefined : db.agentRuns.find((candidate) => candidate.id === record.agentRunId);
        if (run !== undefined && run.status === "waiting_approval") {
          run.status = "running";
        }
        const workSession = db.workSessions.find((candidate) => candidate.id === record.workSessionId);
        if (workSession !== undefined && workSession.currentState === "awaiting_approval") {
          workSession.currentState = "executing";
          updateWorkSessionTimestamp(workSession);
        }
        return { ...record };
      });
      await emitEvent({
        workSessionId: updated.workSessionId,
        eventName: body.status === "approved" ? "approval.approved" : "approval.rejected",
        aggregateType: "approval",
        aggregateId: updated.id,
        payload: {
          note: body.note ?? "",
          approvalKind: updated.approvalKind,
          provider: "codex-app-server",
        },
        context: { approvalId: updated.id, agentRunId: updated.agentRunId ?? undefined },
      });
      return NextResponse.json({
        ok: true,
        data: {
          workSessionId: updated.workSessionId,
          approvalKind: updated.approvalKind,
          state: "executing",
          steps: ["codex-approval-resolved"],
        },
      });
    }
    const result = await approveOrRejectApproval(
      { approvalId: params.id, status: body.status, note: body.note },
      { advance: body.status === "approved" ? "background" : "none" }
    );
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown approval API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
