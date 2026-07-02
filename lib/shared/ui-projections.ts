import type { ApprovalRecord, EventRecord, WorkSessionRecord } from "@/lib/shared/types";

export interface TimelineProjection {
  id: string;
  title: string;
  detail: string;
  meta: string;
  tone: "neutral" | "success" | "warning" | "danger";
  createdAt: string;
}

export interface StatusProjection {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger";
}

function titleFromEventName(eventName: string): string {
  return eventName
    .split(".")
    .map((part) => part.replace(/-/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toneFromEventName(eventName: string): TimelineProjection["tone"] {
  if (eventName.endsWith(".failed") || eventName.endsWith(".rejected") || eventName === "session.blocked") {
    return "danger";
  }
  if (eventName.endsWith(".passed") || eventName.endsWith(".completed") || eventName === "session.finished") {
    return "success";
  }
  if (eventName === "preview.ready") {
    return "success";
  }
  if (eventName === "preview.failed") {
    return "danger";
  }
  if (eventName.includes("approval") || eventName.includes("clarification") || eventName.endsWith(".started")) {
    return "warning";
  }
  return "neutral";
}

function payloadSummary(payload: EventRecord["payload"]): string {
  const summaryKeys = ["summary", "reason", "url", "title", "intent", "approvalKind", "mode"];
  for (const key of summaryKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "No projection detail.";
}

export function projectEventToTimeline(event: EventRecord): TimelineProjection {
  const context = event.context ?? {};
  const contextParts = [
    event.producer?.module ?? "unknown producer",
    context.repoName,
    context.branch,
    context.taskId ? `task ${context.taskId.slice(0, 8)}` : undefined,
  ].filter((part): part is string => typeof part === "string" && part.length > 0);

  return {
    id: event.id,
    title: titleFromEventName(event.eventName),
    detail: payloadSummary(event.payload),
    meta: contextParts.join(" / "),
    tone: toneFromEventName(event.eventName),
    createdAt: event.createdAt,
  };
}

export function projectWorkSessionStatus(workSession: WorkSessionRecord | null, approvals: ApprovalRecord[]): StatusProjection {
  if (workSession === null) {
    return { label: "loading", tone: "neutral" };
  }

  const pendingApprovals = approvals.filter((approval) => approval.status === "pending").length;
  if (pendingApprovals > 0) {
    return { label: `${workSession.currentState} / ${pendingApprovals} approval`, tone: "warning" };
  }
  if (workSession.deliveryKind === "research" && workSession.currentState === "executing") {
    return { label: "researching", tone: "neutral" };
  }
  if (workSession.deliveryKind === "research" && workSession.currentState === "completed") {
    return { label: "research complete", tone: "success" };
  }

  if (workSession.currentState === "completed") {
    return { label: workSession.currentState, tone: "success" };
  }
  if (workSession.currentState === "blocked" || workSession.currentState === "failed" || workSession.currentState === "canceled") {
    return { label: workSession.currentState, tone: "danger" };
  }
  if (workSession.currentState === "awaiting_approval" || workSession.currentState === "clarifying" || workSession.currentState === "verifying") {
    return { label: workSession.currentState, tone: "warning" };
  }
  return { label: workSession.currentState, tone: "neutral" };
}
