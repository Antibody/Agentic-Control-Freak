import { NextRequest, NextResponse } from "next/server";
import { currentTimestamp, mutateDatabase } from "@/lib/server/db/file-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface RenameRequest {
  title: string;
}

function isRenameRequest(value: unknown): value is RenameRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "title" in value &&
    typeof value.title === "string"
  );
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = (await request.json().catch(() => null)) as unknown;
    if (!isRenameRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid rename request." }, { status: 400 });
    }

    const title = body.title.replace(/\s+/g, " ").trim();
    if (title.length === 0) {
      return NextResponse.json({ ok: false, error: "Chat name cannot be empty." }, { status: 400 });
    }
    if (title.length > 120) {
      return NextResponse.json({ ok: false, error: "Chat name must be 120 characters or less." }, { status: 400 });
    }

    const updated = await mutateDatabase((db) => {
      const workSession = db.workSessions.find((candidate) => candidate.id === params.id);
      if (workSession === undefined) {
        throw new Error("Work session was not found.");
      }
      const chatSession = db.chatSessions.find((candidate) => candidate.id === workSession.chatSessionId);
      if (chatSession === undefined) {
        throw new Error("Chat session was not found.");
      }
      chatSession.title = title;
      chatSession.updatedAt = currentTimestamp();
      workSession.updatedAt = chatSession.updatedAt;
      return { workSession, chatSession };
    });

    return NextResponse.json({ ok: true, data: updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown rename error.";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const deleted = await mutateDatabase((db) => {
      const workSession = db.workSessions.find((candidate) => candidate.id === params.id);
      if (workSession === undefined) {
        throw new Error("Work session was not found.");
      }

      const planIds = new Set(
        db.plans.filter((plan) => plan.workSessionId === workSession.id).map((plan) => plan.id),
      );
      const agentRunIds = new Set(
        db.agentRuns.filter((run) => run.workSessionId === workSession.id).map((run) => run.id),
      );
      const projectId = workSession.projectId;
      const chatSessionId = workSession.chatSessionId;
      const runtimeProfileId = workSession.runtimeProfileId;

      db.workSessions = db.workSessions.filter((candidate) => candidate.id !== workSession.id);
      db.chatSessions = db.chatSessions.filter((candidate) => candidate.id !== chatSessionId);
      db.chatMessages = db.chatMessages.filter((message) => message.chatSessionId !== chatSessionId);
      db.plans = db.plans.filter((plan) => plan.workSessionId !== workSession.id);
      db.tasks = db.tasks.filter((task) => !planIds.has(task.planId));
      db.agentRuns = db.agentRuns.filter((run) => run.workSessionId !== workSession.id);
      db.toolRuns = db.toolRuns.filter((run) => !agentRunIds.has(run.agentRunId));
      db.codeChanges = db.codeChanges.filter((change) => !agentRunIds.has(change.agentRunId));
      db.verificationRuns = db.verificationRuns.filter((run) => run.workSessionId !== workSession.id);
      db.approvals = db.approvals.filter((approval) => approval.workSessionId !== workSession.id);
      db.steeringMessages = db.steeringMessages.filter((message) => message.workSessionId !== workSession.id);
      db.handoffs = db.handoffs.filter((handoff) => handoff.workSessionId !== workSession.id);
      db.artifacts = db.artifacts.filter((artifact) => artifact.workSessionId !== workSession.id);
      db.previewServers = db.previewServers.filter((preview) => preview.workSessionId !== workSession.id);
      db.githubExports = db.githubExports.filter((githubExport) => githubExport.workSessionId !== workSession.id);
      db.eventLog = db.eventLog.filter(
        (event) =>
          event.workSessionId !== workSession.id &&
          event.chatSessionId !== chatSessionId &&
          event.projectId !== projectId,
      );

      if (!db.workSessions.some((candidate) => candidate.projectId === projectId)) {
        db.projects = db.projects.filter((project) => project.id !== projectId);
        db.runtimeProfiles = db.runtimeProfiles.filter((profile) => profile.projectId !== projectId);
      } else if (!db.workSessions.some((candidate) => candidate.runtimeProfileId === runtimeProfileId)) {
        db.runtimeProfiles = db.runtimeProfiles.filter((profile) => profile.id !== runtimeProfileId);
      }

      return { workSessionId: workSession.id, chatSessionId, projectId };
    });

    return NextResponse.json({ ok: true, data: deleted });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown delete error.";
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
