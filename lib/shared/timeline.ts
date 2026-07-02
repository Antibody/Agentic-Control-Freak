import type {
  ApprovalRecord,
  ActivityKind,
  AgentRunRecord,
  ChatAttachment,
  ChatRole,
  CheckpointRecord,
  EventRecord,
  HandoffRecord,
  PlanRecord,
  PreviewServerRecord,
  PublicAppState,
  TaskRecord,
  VerificationRunRecord,
  WorkSessionRecord,
  WorkSessionState,
} from "@/lib/shared/types";
import { computeAbandonedHistoryWindows, type AbandonedHistoryWindow } from "@/lib/shared/history";

export type PhaseId = "plan" | "code" | "verify" | "preview" | "research" | "handoff";

export interface PhaseDescriptor {
  id: PhaseId;
  label: string;
  status: "pending" | "active" | "done" | "error";
}

export type Tone = "neutral" | "success" | "warning" | "danger";

interface BaseItem {
  id: string;
  createdAt: string;
}

export interface TimelineMessageItem extends BaseItem {
  kind: "message";
  role: ChatRole;
  content: string;
  messageKind: string;
  attachments: ChatAttachment[];
}

export interface TimelineAgentReplyItem extends BaseItem {
  kind: "agent_reply";
  run: AgentRunRecord;
}

export interface TimelinePlanItem extends BaseItem {
  kind: "plan";
  plan: PlanRecord;
  tasks: TaskRecord[];
}

export interface TimelineApprovalItem extends BaseItem {
  kind: "approval";
  approval: ApprovalRecord;
}

export interface TimelineVerificationItem extends BaseItem {
  kind: "verification";
  run: VerificationRunRecord;
}

export interface TimelinePreviewItem extends BaseItem {
  kind: "preview";
  preview: PreviewServerRecord;
}

export interface TimelineHandoffItem extends BaseItem {
  kind: "handoff";
  handoff: HandoffRecord;
}

export interface TimelineMilestoneItem extends BaseItem {
  kind: "milestone";
  label: string;
  detail?: string;
  tone: Tone;
  phase: PhaseId;
}

export interface TimelineActivityItem extends BaseItem {
  kind: "activity";
  label: string;
  detail?: string;
  phase: PhaseId;
}

export interface TimelineRestoreItem extends BaseItem {
  kind: "restore";
  checkpoint: CheckpointRecord | null;
  restoredFrom: CheckpointRecord | null;
  undoneItems: TimelineItem[];
}

export type TimelineItem =
  | TimelineMessageItem
  | TimelineAgentReplyItem
  | TimelinePlanItem
  | TimelineApprovalItem
  | TimelineVerificationItem
  | TimelinePreviewItem
  | TimelineHandoffItem
  | TimelineMilestoneItem
  | TimelineActivityItem
  | TimelineRestoreItem;

const IMPLEMENTATION_PHASE_ORDER: PhaseId[] = ["plan", "code", "verify", "preview", "handoff"];
const RESEARCH_PHASE_ORDER: PhaseId[] = ["research", "handoff"];

const PHASE_LABELS: Record<PhaseId, string> = {
  plan: "Plan",
  code: "Code",
  verify: "Verify",
  preview: "Preview",
  research: "Research",
  handoff: "Handoff",
};

const STATE_TO_PHASE: Record<WorkSessionState, PhaseId> = {
  intake: "plan",
  clarifying: "plan",
  planning: "plan",
  awaiting_approval: "plan",
  queued: "code",
  executing: "code",
  verifying: "verify",
  blocked: "code",
  handoff_needed: "handoff",
  completed: "handoff",
  failed: "code",
  canceled: "code",
};

const ACTIVITY_LABELS: Partial<Record<WorkSessionState, string>> = {
  intake: "Reading your request",
  clarifying: "Asking a follow-up",
  planning: "Drafting the plan",
  queued: "Queueing work",
  executing: "Starting work",
  verifying: "Validating",
};

const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  runtime_check: "Checking runtime",
  preparing_prompt: "Preparing prompt",
  running_runtime: "Reasoning",
  researching_repo: "Researching repo",
  searching_web: "Searching web",
  reading_files: "Reading files",
  editing_files: "Editing files",
  running_command: "Running command",
  dependency_research: "Researching dependencies",
  installing_dependencies: "Installing dependencies",
  verifying: "Validating",
  preview: "Starting preview",
  snapshot: "Capturing snapshot",
  preparing_report: "Preparing report",
  finishing: "Finishing",
  waiting: "Waiting",
};

const ACTIVITY_KIND_VALUES = new Set<ActivityKind>(Object.keys(ACTIVITY_KIND_LABELS) as ActivityKind[]);

interface ActivityProjection {
  label: string;
  detail?: string;
  kind?: ActivityKind;
}

function phaseOrderFor(workSession: WorkSessionRecord | null): PhaseId[] {
  return workSession?.deliveryKind === "research" ? RESEARCH_PHASE_ORDER : IMPLEMENTATION_PHASE_ORDER;
}

function phaseForState(workSession: WorkSessionRecord): PhaseId {
  if (workSession.deliveryKind === "research" && !["completed", "handoff_needed"].includes(workSession.currentState)) {
    return "research";
  }
  return STATE_TO_PHASE[workSession.currentState];
}

function activityLabelFor(workSession: WorkSessionRecord): string | undefined {
  if (workSession.deliveryKind === "research" && workSession.currentState === "executing") {
    return "Researching";
  }
  return ACTIVITY_LABELS[workSession.currentState];
}

function phaseForActivityKind(kind: ActivityKind | undefined, workSession: WorkSessionRecord): PhaseId {
  if (workSession.deliveryKind === "research" && !["completed", "handoff_needed"].includes(workSession.currentState)) {
    return "research";
  }
  if (kind === "verifying") return "verify";
  if (kind === "preview" || kind === "snapshot") return "preview";
  if (kind === "preparing_report") return "handoff";
  return phaseForState(workSession);
}

function ts(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortByTime<T extends BaseItem>(items: T[]): T[] {
  return [...items].sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
}

function tasksByPlan(state: PublicAppState): Map<string, TaskRecord[]> {
  const grouped = new Map<string, TaskRecord[]>();
  for (const task of state.tasks) {
    const list = grouped.get(task.planId);
    if (list === undefined) {
      grouped.set(task.planId, [task]);
    } else {
      list.push(task);
    }
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.ordinal - b.ordinal);
  }
  return grouped;
}

export function computePhases(
  state: PublicAppState,
  workSession: WorkSessionRecord | null,
): PhaseDescriptor[] {
  if (workSession === null) {
    return IMPLEMENTATION_PHASE_ORDER.map((id) => ({ id, label: PHASE_LABELS[id], status: "pending" }));
  }
  if (workSession.deliveryKind === "research") {
    const agentRunsForSession = state.agentRuns.filter((run) => run.workSessionId === workSession.id);
    const hasResearchRun = agentRunsForSession.some((run) => run.role === "researcher");
    const researchFailed = agentRunsForSession.some((run) => run.role === "researcher" && run.status === "failed");
    const reportReady = state.artifacts.some(
      (artifact) => artifact.workSessionId === workSession.id && artifact.artifactKind === "report" && (
        artifact.metadata.artifactRole === "research_full_report" ||
        artifact.metadata.artifactRole === "research_report"
      ),
    );
    const handoffsForSession = state.handoffs.filter((handoff) => handoff.workSessionId === workSession.id);
    return RESEARCH_PHASE_ORDER.map((id) => {
      if (id === "research") {
        if (reportReady && workSession.currentState === "completed") return { id, label: PHASE_LABELS[id], status: "done" };
        if (researchFailed || workSession.currentState === "blocked" || workSession.currentState === "failed") return { id, label: PHASE_LABELS[id], status: "error" };
        return { id, label: PHASE_LABELS[id], status: hasResearchRun || workSession.currentState === "executing" ? "active" : "pending" };
      }
      if (workSession.currentState === "completed" || handoffsForSession.length > 0) {
        return { id, label: PHASE_LABELS[id], status: "done" };
      }
      return { id, label: PHASE_LABELS[id], status: "pending" };
    });
  }

  const plansForSession = state.plans.filter((plan) => plan.workSessionId === workSession.id);
  const approvedPlan = plansForSession.find((plan) => plan.status === "approved");
  const anyPlan = plansForSession.length > 0;

  const tasksForSession = plansForSession.flatMap((plan) =>
    state.tasks.filter((task) => task.planId === plan.id),
  );
  const anyTaskStarted = tasksForSession.some(
    (task) => task.status === "in_progress" || task.status === "done" || task.status === "blocked",
  );
  const allTasksDone =
    tasksForSession.length > 0 && tasksForSession.every((task) => task.status === "done" || task.status === "skipped");

  const verificationsForSession = state.verificationRuns.filter((run) => run.workSessionId === workSession.id);
  const anyVerification = verificationsForSession.length > 0;
  const lastVerification = verificationsForSession.sort((a, b) => ts(b.startedAt) - ts(a.startedAt))[0];
  const verificationPassed = lastVerification?.status === "passed";
  const verificationFailed = lastVerification?.status === "failed";

  const previewsForSession = state.previewServers.filter((preview) => preview.workSessionId === workSession.id);
  const previewReady = previewsForSession.some((preview) => preview.status === "ready");
  const previewFailed = previewsForSession.some((preview) => preview.status === "failed");
  const anyPreview = previewsForSession.length > 0;

  const handoffsForSession = state.handoffs.filter((handoff) => handoff.workSessionId === workSession.id);
  const anyHandoff = handoffsForSession.length > 0;
  const sessionComplete = workSession.currentState === "completed";

  const currentPhase = phaseForState(workSession);

  const phases: PhaseDescriptor[] = phaseOrderFor(workSession).map((id) => {
    let status: PhaseDescriptor["status"] = "pending";
    switch (id) {
      case "plan":
        if (approvedPlan !== undefined) status = "done";
        else if (anyPlan || currentPhase === "plan") status = "active";
        break;
      case "code":
        if (allTasksDone) status = "done";
        else if (anyTaskStarted || currentPhase === "code") status = "active";
        if (workSession.currentState === "failed" || workSession.currentState === "blocked" || workSession.currentState === "canceled") {
          if (status === "active") status = "error";
        }
        break;
      case "verify":
        if (verificationPassed) status = "done";
        else if (verificationFailed) status = "error";
        else if (anyVerification || currentPhase === "verify") status = "active";
        break;
      case "preview":
        if (previewReady) status = "done";
        else if (previewFailed) status = "error";
        else if (anyPreview) status = "active";
        break;
      case "handoff":
        if (sessionComplete && anyHandoff) status = "done";
        else if (anyHandoff || currentPhase === "handoff") status = "active";
        break;
    }
    return { id, label: PHASE_LABELS[id], status };
  });

  return phases;
}

interface BuildTimelineInput {
  state: PublicAppState;
  workSession: WorkSessionRecord | null;
}

function lastSeenEventBefore(events: EventRecord[], at: number): EventRecord | null {
  let best: EventRecord | null = null;
  for (const event of events) {
    if (ts(event.createdAt) <= at) {
      if (best === null || ts(event.createdAt) > ts(best.createdAt)) {
        best = event;
      }
    }
  }
  return best;
}

export function buildTimeline({ state, workSession }: BuildTimelineInput): {
  items: TimelineItem[];
  activity: TimelineActivityItem | null;
} {
  if (workSession === null) {
    return { items: [], activity: null };
  }

  const chatSessionId = workSession.chatSessionId;
  const items: TimelineItem[] = [];

  const groupedTasks = tasksByPlan(state);

  const checkpointsById = new Map<string, CheckpointRecord>();
  for (const checkpoint of state.checkpoints) {
    if (checkpoint.workSessionId === workSession.id) {
      checkpointsById.set(checkpoint.id, checkpoint);
    }
  }
  const abandonedWindows = computeAbandonedHistoryWindows(workSession, state.checkpoints);
  const currentCheckpoint =
    workSession.checkpointRef === null ? null : checkpointsById.get(workSession.checkpointRef) ?? null;
  const currentIsRestore = currentCheckpoint?.trigger === "restore";

  for (const message of state.chatMessages) {
    if (message.chatSessionId !== chatSessionId) continue;
    items.push({
      kind: "message",
      id: `msg:${message.id}`,
      createdAt: message.createdAt,
      role: message.role,
      content: message.content,
      messageKind: message.messageKind,
      attachments: message.attachments ?? [],
    });
  }

  for (const run of state.agentRuns) {
    if (run.workSessionId !== workSession.id) continue;
    if ((run.status !== "completed" && run.status !== "failed") || run.summary.trim().length === 0) continue;
    items.push({
      kind: "agent_reply",
      id: `agent-reply:${run.id}`,
      createdAt: run.endedAt ?? run.startedAt,
      run,
    });
  }

  for (const plan of state.plans) {
    if (plan.workSessionId !== workSession.id) continue;
    items.push({
      kind: "plan",
      id: `plan:${plan.id}`,
      createdAt: plan.createdAt,
      plan,
      tasks: groupedTasks.get(plan.id) ?? [],
    });
    if (plan.status === "approved" && plan.approvedAt !== null) {
      items.push({
        kind: "milestone",
        id: `milestone:plan-approved:${plan.id}`,
        createdAt: plan.approvedAt,
        label: `Plan v${plan.version} approved`,
        tone: "success",
        phase: "code",
      });
    }
  }

  for (const approval of state.approvals) {
    if (approval.workSessionId !== workSession.id) continue;
    if (approval.approvalKind === "plan") {
      continue;
    }
    items.push({
      kind: "approval",
      id: `approval:${approval.id}`,
      createdAt: approval.requestedAt,
      approval,
    });
  }

  for (const run of state.verificationRuns) {
    if (run.workSessionId !== workSession.id) continue;
    items.push({
      kind: "verification",
      id: `verification:${run.id}`,
      createdAt: run.startedAt,
      run,
    });
  }

  const appServable = (workSession.previewFirstServableAt ?? null) !== null;
  const previewsForSession = state.previewServers.filter(
    (preview) => preview.workSessionId === workSession.id && (preview.mode !== "probe" || appServable),
  );
  const previewsSorted = [...previewsForSession].sort((a, b) => ts(b.startedAt) - ts(a.startedAt));
  const latestPreview = previewsSorted[0] ?? null;
  if (latestPreview !== null) {
    items.push({
      kind: "preview",
      id: `preview:${latestPreview.id}`,
      createdAt: latestPreview.startedAt,
      preview: latestPreview,
    });
    if (latestPreview.status === "ready") {
      items.push({
        kind: "milestone",
        id: `milestone:preview-ready:${latestPreview.id}`,
        createdAt: latestPreview.lastHealthCheckAt ?? latestPreview.startedAt,
        label: "Preview ready",
        detail: latestPreview.url,
        tone: "success",
        phase: "preview",
      });
    } else if (latestPreview.status === "failed") {
      items.push({
        kind: "milestone",
        id: `milestone:preview-failed:${latestPreview.id}`,
        createdAt: latestPreview.lastHealthCheckAt ?? latestPreview.startedAt,
        label: "Preview failed to start",
        tone: "danger",
        phase: "preview",
      });
    }
  }

  for (const handoff of state.handoffs) {
    if (handoff.workSessionId !== workSession.id) continue;
    items.push({
      kind: "handoff",
      id: `handoff:${handoff.id}`,
      createdAt: handoff.createdAt,
      handoff,
    });
  }

  if (workSession.currentState === "completed" && !currentIsRestore) {
    items.push({
      kind: "milestone",
      id: `milestone:session-complete:${workSession.id}`,
      createdAt: workSession.updatedAt,
      label: "Session complete",
      tone: "success",
      phase: "handoff",
    });
  } else if (workSession.currentState === "failed") {
    items.push({
      kind: "milestone",
      id: `milestone:session-failed:${workSession.id}`,
      createdAt: workSession.updatedAt,
      label: "Session failed",
      tone: "danger",
      phase: phaseForState(workSession),
    });
  } else if (workSession.currentState === "canceled") {
    items.push({
      kind: "milestone",
      id: `milestone:session-canceled:${workSession.id}`,
      createdAt: workSession.updatedAt,
      label: "Session canceled",
      tone: "warning",
      phase: phaseForState(workSession),
    });
  }

  const projected = foldAbandonedHistory(items, abandonedWindows, checkpointsById);
  const sorted = sortByTime(projected);

  const eventsForSession = state.eventLog.filter((event) => event.workSessionId === workSession.id);
  const hasUserMessage = state.chatMessages.some(
    (message) => message.chatSessionId === chatSessionId && message.role === "user",
  );
  const activity = hasUserMessage ? buildActivityItem(workSession, eventsForSession) : null;

  return { items: sorted, activity };
}

function foldAbandonedHistory(
  items: TimelineItem[],
  windows: AbandonedHistoryWindow[],
  checkpointsById: Map<string, CheckpointRecord>,
): TimelineItem[] {
  if (windows.length === 0) {
    return items;
  }

  const active: TimelineItem[] = [];
  const undoneByWindow = new Map<number, TimelineItem[]>();
  for (const item of items) {
    const windowIndex = windows.findIndex(
      (window) => item.createdAt > window.start && item.createdAt < window.end,
    );
    if (windowIndex === -1) {
      active.push(item);
      continue;
    }
    const bucket = undoneByWindow.get(windowIndex);
    if (bucket === undefined) {
      undoneByWindow.set(windowIndex, [item]);
    } else {
      bucket.push(item);
    }
  }

  windows.forEach((window, index) => {
    const checkpoint =
      window.restoreCheckpointId === null ? null : checkpointsById.get(window.restoreCheckpointId) ?? null;
    const restoredFrom =
      window.restoredFromCheckpointId === null
        ? null
        : checkpointsById.get(window.restoredFromCheckpointId) ?? null;
    active.push({
      kind: "restore",
      id: checkpoint !== null ? `restore:${checkpoint.id}` : `restore:flat:${window.end}`,
      createdAt: window.end,
      checkpoint,
      restoredFrom,
      undoneItems: sortByTime(undoneByWindow.get(index) ?? []),
    });
  });

  return active;
}

function buildActivityItem(
  workSession: WorkSessionRecord,
  events: EventRecord[],
): TimelineActivityItem | null {
  const fallbackLabel = activityLabelFor(workSession);
  if (fallbackLabel === undefined) return null;

  const latest = latestActivityEventBefore(events, Date.now(), workSession) ?? lastSeenEventBefore(events, Date.now());
  const projection = latest === null ? null : activityProjectionFromEvent(latest, workSession, fallbackLabel);
  const label = projection?.label ?? fallbackLabel;
  const detail = projection?.detail ?? (
    workSession.deliveryKind === "research" && workSession.currentState === "executing"
      ? researchActivityDetailFromEvent(latest)
      : activityDetailFromEvent(latest, workSession)
  );

  return {
    kind: "activity",
    id: `activity:${workSession.id}:${workSession.currentState}`,
    createdAt: workSession.updatedAt,
    label,
    detail,
    phase: phaseForActivityKind(projection?.kind, workSession),
  };
}

function researchActivityDetailFromEvent(event: EventRecord | null): string | undefined {
  if (event === null) return undefined;
  const message = event.payload.message;
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  const summary = event.payload.summary;
  if (typeof summary === "string" && summary.length > 0) {
    return summary;
  }
  return "Inspecting the workspace and preparing a report.";
}

function eventPayloadText(event: EventRecord, key: string): string | undefined {
  const value = event.payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function payloadActivityKind(event: EventRecord): ActivityKind | undefined {
  const value = event.payload.activityKind;
  return typeof value === "string" && ACTIVITY_KIND_VALUES.has(value as ActivityKind) ? value as ActivityKind : undefined;
}

function latestActivityEventBefore(events: EventRecord[], at: number, workSession: WorkSessionRecord): EventRecord | null {
  let best: EventRecord | null = null;
  for (const event of events) {
    if (ts(event.createdAt) > at || !isActivityEvent(event, workSession)) continue;
    if (best === null || ts(event.createdAt) > ts(best.createdAt)) {
      best = event;
    }
  }
  return best;
}

function isActivityEvent(event: EventRecord, workSession: WorkSessionRecord): boolean {
  if (
    payloadActivityKind(event) !== undefined ||
    eventPayloadText(event, "activityLabel") !== undefined ||
    eventPayloadText(event, "activityDetail") !== undefined
  ) {
    return true;
  }
  if (event.eventName === "tool.started" || event.eventName === "tool.completed" || event.eventName === "tool.failed") {
    return true;
  }
  if (
    event.eventName === "agent.preflight.started" ||
    event.eventName === "agent.preflight.passed" ||
    event.eventName === "agent.preflight.failed" ||
    event.eventName === "agent.started" ||
    event.eventName === "agent.prompt.prepared" ||
    event.eventName === "agent.process.started" ||
    event.eventName === "agent.process.output.delta" ||
    event.eventName === "agent.process.exited" ||
    event.eventName === "agent.completed" ||
    event.eventName === "agent.failed" ||
    event.eventName === "code.change.detected" ||
    event.eventName === "task.progress" ||
    event.eventName.startsWith("verification.") ||
    event.eventName.startsWith("preview.") ||
    event.eventName.startsWith("snapshot.")
  ) {
    return true;
  }
  return workSession.currentState === "executing" && event.eventName.startsWith("task.");
}

function runtimeLabelForEvent(event: EventRecord, workSession: WorkSessionRecord): string {
  const runtimeKind = event.producer.runtimeKind;
  if (runtimeKind === "claude") return "Claude Code";
  if (runtimeKind === "antigravity") return "AGY CLI";
  if (runtimeKind === "ollama") return "Ollama";
  if (runtimeKind === "codex") return "Codex CLI";

  if (workSession.agentProvider === "claude-code") return "Claude Code";
  if (workSession.agentProvider === "antigravity-cli") return "AGY CLI";
  if (workSession.agentProvider === "ollama") return "Ollama";
  if (workSession.agentProvider === "codex-cli") return "Codex CLI";
  return "agent";
}

function toolNameForEvent(event: EventRecord): string | undefined {
  for (const key of ["toolName", "tool_name", "tool", "name", "nativeEvent"]) {
    const value = event.payload[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function toolTargetForEvent(event: EventRecord, toolName: string): string | undefined {
  const query = eventPayloadText(event, "query");
  if (query !== undefined && toolName.toLowerCase().includes("search")) return `"${query}"`;
  const path = eventPayloadText(event, "path") ?? eventPayloadText(event, "filePath");
  if (path !== undefined) return path;
  if (query !== undefined) return `"${query}"`;
  const command = eventPayloadText(event, "command");
  if (command !== undefined) return command;
  return undefined;
}

function activityKindForToolName(toolName: string, workSession: WorkSessionRecord): ActivityKind {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_");
  if (
    normalized.includes("web_search") ||
    normalized.includes("search_query") ||
    normalized.includes("fetch_url") ||
    normalized.includes("browser") ||
    normalized === "web.run"
  ) {
    return "searching_web";
  }
  if (
    normalized.includes("search_text") ||
    normalized.includes("grep") ||
    normalized.includes("rg") ||
    normalized.includes("glob") ||
    normalized.includes("find")
  ) {
    return "researching_repo";
  }
  if (
    normalized.includes("read_file") ||
    normalized === "read" ||
    normalized.includes("list_dir") ||
    normalized === "ls"
  ) {
    return workSession.deliveryKind === "research" ? "researching_repo" : "reading_files";
  }
  if (
    normalized.includes("write_file") ||
    normalized.includes("delete_file") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("write") ||
    normalized.includes("delete")
  ) {
    return "editing_files";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("command") ||
    normalized.includes("terminal")
  ) {
    return "running_command";
  }
  if (normalized.includes("finish")) {
    return workSession.deliveryKind === "research" ? "preparing_report" : "finishing";
  }
  return workSession.deliveryKind === "research" ? "researching_repo" : "running_runtime";
}

function activityKindFromText(text: string, workSession: WorkSessionRecord): ActivityKind | undefined {
  const normalized = text.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  if (lower.length === 0) return undefined;
  if (lower.includes("dependency research")) return "dependency_research";
  if (lower.includes("installing dependenc") || lower.includes("npm install") || lower.includes("pnpm install") || lower.includes("pnpm add")) {
    return "installing_dependencies";
  }
  if (lower.includes("search_text") || lower.includes("grep ") || lower.includes(" rg ") || lower.startsWith("rg ")) return "researching_repo";
  if (lower.includes("web_search") || lower.includes("searching web") || lower.includes("search_query") || lower.includes("fetch_url")) return "searching_web";
  if (lower.includes("read_file") || lower.includes("list_dir") || lower.startsWith("read ") || lower.startsWith("ls ")) {
    return workSession.deliveryKind === "research" ? "researching_repo" : "reading_files";
  }
  if (lower.includes("write_file") || lower.includes("delete_file") || lower.includes("apply_patch") || lower.includes("editing file")) return "editing_files";
  if (lower.includes("verification") || lower.includes("typecheck") || lower.includes("eslint") || lower.includes("lint")) return "verifying";
  if (lower.includes("preview") || lower.includes("dev server") || lower.includes("localhost")) return "preview";
  if (lower.includes("snapshot") || lower.includes("screenshot") || lower.includes("dom captured")) return "snapshot";
  if (/^\$\s+\S+/.test(normalized)) return "running_command";
  return undefined;
}

function labelForActivityKind(kind: ActivityKind, workSession: WorkSessionRecord): string {
  if (kind === "researching_repo" && workSession.deliveryKind === "research") {
    return "Researching repo";
  }
  return ACTIVITY_KIND_LABELS[kind];
}

function projectionFromKind(
  event: EventRecord,
  workSession: WorkSessionRecord,
  kind: ActivityKind,
  detail?: string,
  label?: string,
): ActivityProjection {
  return {
    kind,
    label: eventPayloadText(event, "activityLabel") ?? label ?? labelForActivityKind(kind, workSession),
    detail: eventPayloadText(event, "activityDetail") ?? detail ?? eventPayloadText(event, "message") ?? eventPayloadText(event, "summary"),
  };
}

function activityProjectionFromEvent(
  event: EventRecord,
  workSession: WorkSessionRecord,
  fallbackLabel: string,
): ActivityProjection | null {
  const explicitKind = payloadActivityKind(event);
  const explicitDetail = eventPayloadText(event, "activityDetail") ?? eventPayloadText(event, "message") ?? eventPayloadText(event, "summary");
  if (explicitKind !== undefined) {
    return projectionFromKind(event, workSession, explicitKind, explicitDetail);
  }
  const explicitLabel = eventPayloadText(event, "activityLabel");
  if (explicitLabel !== undefined) {
    return { label: explicitLabel, detail: explicitDetail };
  }

  if (event.eventName === "tool.started" || event.eventName === "tool.completed" || event.eventName === "tool.failed") {
    const toolName = toolNameForEvent(event) ?? "tool";
    const kind = activityKindForToolName(toolName, workSession);
    const target = toolTargetForEvent(event, toolName);
    return projectionFromKind(event, workSession, kind, target === undefined ? toolName : `${toolName}: ${target}`);
  }

  if (event.eventName === "agent.preflight.started" || event.eventName === "agent.preflight.passed" || event.eventName === "agent.preflight.failed") {
    return projectionFromKind(event, workSession, "runtime_check", explicitDetail, `Checking ${runtimeLabelForEvent(event, workSession)}`);
  }
  if (event.eventName === "agent.started") {
    return projectionFromKind(event, workSession, "preparing_prompt", explicitDetail, `Starting ${runtimeLabelForEvent(event, workSession)}`);
  }
  if (event.eventName === "agent.prompt.prepared") {
    return projectionFromKind(event, workSession, "preparing_prompt", explicitDetail);
  }
  if (event.eventName === "agent.process.started") {
    return projectionFromKind(event, workSession, "running_runtime", explicitDetail);
  }
  if (event.eventName === "agent.process.output.delta") {
    const text = eventPayloadText(event, "text") ?? eventPayloadText(event, "message");
    const kind = text === undefined ? undefined : activityKindFromText(text, workSession);
    return kind === undefined
      ? { label: fallbackLabel, detail: text }
      : projectionFromKind(event, workSession, kind, text);
  }
  if (event.eventName === "code.change.detected") {
    const filePath = eventPayloadText(event, "filePath");
    const changeKind = eventPayloadText(event, "changeKind");
    return projectionFromKind(event, workSession, "editing_files", filePath === undefined ? undefined : changeKind === undefined ? filePath : `${changeKind}: ${filePath}`);
  }
  if (event.eventName === "task.progress") {
    const message = eventPayloadText(event, "message");
    const kind = message === undefined ? undefined : activityKindFromText(message, workSession);
    return kind === undefined
      ? { label: fallbackLabel, detail: message }
      : projectionFromKind(event, workSession, kind, message);
  }
  if (event.eventName.startsWith("verification.")) {
    return projectionFromKind(event, workSession, "verifying", activityDetailFromEvent(event, workSession));
  }
  if (event.eventName.startsWith("preview.")) {
    return projectionFromKind(event, workSession, "preview", activityDetailFromEvent(event, workSession));
  }
  if (event.eventName.startsWith("snapshot.")) {
    return projectionFromKind(event, workSession, "snapshot", activityDetailFromEvent(event, workSession));
  }
  if (event.eventName === "agent.process.exited" || event.eventName === "agent.completed") {
    return projectionFromKind(event, workSession, "finishing", explicitDetail);
  }
  if (event.eventName === "agent.failed") {
    return projectionFromKind(event, workSession, "waiting", explicitDetail);
  }
  return null;
}

function activityDetailFromEvent(event: EventRecord | null, workSession: WorkSessionRecord): string | undefined {
  if (event === null) return undefined;
  const payload = event.payload;
  const state = workSession.currentState;

  if (state === "executing") {
    if (event.eventName === "agent.preflight.started") {
      return eventPayloadText(event, "message") ?? `Checking ${runtimeLabelForEvent(event, workSession)}`;
    }
    if (event.eventName === "agent.preflight.passed") {
      return eventPayloadText(event, "message") ?? `${runtimeLabelForEvent(event, workSession)} is ready`;
    }
    if (event.eventName === "agent.preflight.failed") {
      return eventPayloadText(event, "message") ?? `${runtimeLabelForEvent(event, workSession)} preflight failed`;
    }
    if (event.eventName === "agent.prompt.prepared") {
      return eventPayloadText(event, "message") ?? `Prepared ${runtimeLabelForEvent(event, workSession)} prompt`;
    }
    if (event.eventName === "agent.process.started") {
      return eventPayloadText(event, "message") ?? `Running ${runtimeLabelForEvent(event, workSession)}`;
    }
    if (event.eventName === "agent.process.output.delta") {
      return eventPayloadText(event, "text") ?? eventPayloadText(event, "message");
    }
    if (event.eventName === "code.change.detected") {
      const filePath = payload.filePath;
      const changeKind = payload.changeKind;
      if (typeof filePath === "string") {
        return typeof changeKind === "string" ? `${changeKind}: ${filePath}` : filePath;
      }
    }
    if (event.eventName === "agent.process.exited") {
      return eventPayloadText(event, "message") ?? `${runtimeLabelForEvent(event, workSession)} finished`;
    }
    if (event.eventName === "task.progress") {
      return eventPayloadText(event, "message");
    }
  }

  if (state === "verifying") {
    if (event.eventName === "verification.started") {
      return "Starting verification";
    }
    if (event.eventName === "verification.command.started") {
      const command = payload.command;
      return typeof command === "string" ? `Running ${command}` : "Running verification command";
    }
    if (event.eventName === "verification.command.output.delta") {
      const text = payload.text;
      if (typeof text === "string" && text.length > 0) {
        return text;
      }
    }
    if (
      event.eventName === "verification.command.passed" ||
      event.eventName === "verification.command.skipped" ||
      event.eventName === "verification.command.failed"
    ) {
      const message = payload.message;
      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
    return "The controller is running validation checks.";
  }

  const summaryKeys = ["message", "title", "summary", "filePath", "command", "reason"];
  for (const key of summaryKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  if (state === "executing" && event.eventName.startsWith("task.")) {
    return event.eventName.replace(/\./g, " ");
  }
  return undefined;
}
