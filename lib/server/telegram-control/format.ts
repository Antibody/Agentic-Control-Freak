import type {
  ApprovalRecord,
  EventRecord,
  PlanRecord,
  PreviewServerRecord,
  PublicAppState,
  RuntimeOverrides,
  TaskRecord,
  VerificationRunRecord,
  WorkSessionRecord,
  AgentProvider,
  CodexRuntimeOptions,
} from "@/lib/shared/types";
import { standardServiceTier } from "@/lib/shared/runtime-overrides";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function clampTelegramText(value: string, max = 3900): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 20)).trimEnd()}\n...[truncated]`;
}

export function sessionLabel(state: PublicAppState, session: WorkSessionRecord): string {
  const chat = state.chatSessions.find((candidate) => candidate.id === session.chatSessionId);
  const project = state.projects.find((candidate) => candidate.id === session.projectId);
  return `${chat?.title ?? session.id} (${project?.slug ?? "project"})`;
}

export function formatSessionStatus(input: {
  state: PublicAppState;
  workSession: WorkSessionRecord;
  plan: PlanRecord | null;
  tasks: TaskRecord[];
  approval: ApprovalRecord | null;
  verification: VerificationRunRecord | null;
  preview: PreviewServerRecord | null;
}): string {
  const done = input.tasks.filter((task) => task.status === "done").length;
  const currentTask = input.tasks.find((task) => task.status === "in_progress") ?? input.tasks.find((task) => task.status === "todo") ?? null;
  const lines = [
    `<b>${escapeHtml(sessionLabel(input.state, input.workSession))}</b>`,
    `State: <code>${escapeHtml(input.workSession.currentState)}</code>${input.workSession.paused ? " paused" : ""}`,
    `Autonomy: <code>${escapeHtml(input.workSession.autonomyLevel)}</code>${input.workSession.awaitingStep ? `, waiting: ${escapeHtml(input.workSession.nextActionLabel ?? "step")}` : ""}`,
    `Plan: ${input.plan === null ? "none" : `${escapeHtml(input.plan.title)} (${escapeHtml(input.plan.status)})`}`,
    `Tasks: ${done}/${input.tasks.length}${currentTask !== null ? `, next: ${escapeHtml(currentTask.title)}` : ""}`,
    `Approval: ${input.approval === null ? "none pending" : `${escapeHtml(input.approval.approvalKind)} - ${escapeHtml(input.approval.reason)}`}`,
    `Verification: ${input.verification === null ? "none" : `${escapeHtml(input.verification.status)} - ${escapeHtml(input.verification.summary)}`}`,
    `Preview: ${input.preview === null ? "none" : `${escapeHtml(input.preview.status)} ${escapeHtml(input.preview.url)}`}`,
  ];
  return clampTelegramText(lines.join("\n"));
}

export function formatApproval(state: PublicAppState, approval: ApprovalRecord): string {
  const session = state.workSessions.find((candidate) => candidate.id === approval.workSessionId);
  const label = session === undefined ? approval.workSessionId : sessionLabel(state, session);
  const planId = typeof approval.payload.planId === "string" ? approval.payload.planId : null;
  const plan = planId === null ? null : state.plans.find((candidate) => candidate.id === planId) ?? null;
  const lines = [
    `<b>Approval requested</b>`,
    `Session: ${escapeHtml(label)}`,
    `Kind: <code>${escapeHtml(approval.approvalKind)}</code>`,
    `Reason: ${escapeHtml(approval.reason)}`,
  ];
  if (plan !== null) {
    lines.push(`Plan: ${escapeHtml(plan.title)}`);
    lines.push(clampTelegramText(escapeHtml(plan.planMarkdown), 1600));
  }
  return clampTelegramText(lines.join("\n"));
}

function providerLabel(provider: AgentProvider): string {
  switch (provider) {
    case "claude-code":
      return "Claude Code";
    case "antigravity-cli":
      return "AGY CLI";
    case "ollama":
      return "Ollama";
    case "codex-cli":
      return "Codex CLI";
  }
}

function valueOrInherit(value: string | number | boolean | null | undefined, inherited: string): string {
  if (value === null || value === undefined || value === "") {
    return `inherit (${inherited})`;
  }
  return String(value);
}

function modelLabel(options: CodexRuntimeOptions, slug: string | null): string {
  if (slug === null) {
    return "provider default";
  }
  return options.models.find((model) => model.slug === slug)?.displayName ?? slug;
}

function serviceTierLabel(options: CodexRuntimeOptions, overrides: RuntimeOverrides | null, provider: AgentProvider): string {
  if (provider !== "codex-cli" && provider !== "claude-code") {
    return "not supported";
  }
  const current = overrides?.serviceTier ?? null;
  if (current === standardServiceTier) {
    return "standard";
  }
  const available = options.models.flatMap((model) => model.serviceTiers ?? []);
  const inherited = options.defaults.serviceTier === null
    ? "provider default"
    : available.find((tier) => tier.id === options.defaults.serviceTier)?.name ?? options.defaults.serviceTier;
  if (current === null) {
    return `inherit (${inherited})`;
  }
  return available.find((tier) => tier.id === current)?.name ?? current;
}

export function formatRuntimeStatus(input: {
  state: PublicAppState;
  workSession: WorkSessionRecord;
  provider: AgentProvider;
  options: CodexRuntimeOptions;
}): string {
  const overrides = input.workSession.runtimeOverrides;
  const options = input.options;
  const provider = input.provider;
  const defaultModel = options.defaults.model ?? null;
  const selectedModel = overrides?.model ?? null;
  const activeModel = options.models.find((model) => model.slug === (selectedModel ?? defaultModel)) ?? null;
  const inheritedEffort = options.defaults.reasoningEffort ?? activeModel?.defaultReasoningLevel ?? "model default";
  const effort = provider === "ollama" || provider === "antigravity-cli"
    ? "not supported"
    : valueOrInherit(overrides?.reasoningEffort ?? null, inheritedEffort);
  const timeoutDefault = options.defaults.timeoutMs !== null && options.defaults.timeoutMs !== undefined
    ? `${Math.round(options.defaults.timeoutMs / 1000)}s`
    : "configured default";
  const lines = [
    `<b>Runtime</b>`,
    `Session: ${escapeHtml(sessionLabel(input.state, input.workSession))}`,
    `Provider: <code>${escapeHtml(provider)}</code> (${providerLabel(provider)})`,
    `Model: <code>${escapeHtml(valueOrInherit(selectedModel, modelLabel(options, defaultModel)))}</code>`,
    `Thinking: <code>${escapeHtml(effort)}</code>`,
    `Speed: <code>${escapeHtml(serviceTierLabel(options, overrides, provider))}</code>`,
    `Timeout: <code>${escapeHtml(valueOrInherit(overrides?.timeoutMs !== null && overrides?.timeoutMs !== undefined ? `${Math.round(overrides.timeoutMs / 1000)}s` : null, timeoutDefault))}</code>`,
  ];
  if (provider === "codex-cli") {
    const networkDefault = options.defaults.networkAccess === null || options.defaults.networkAccess === undefined
      ? "sandbox default"
      : options.defaults.networkAccess ? "on" : "off";
    lines.push(`Sandbox: <code>${escapeHtml(valueOrInherit(overrides?.sandboxMode ?? null, options.defaults.sandboxMode ?? "configured default"))}</code>`);
    lines.push(`Network: <code>${escapeHtml(valueOrInherit(overrides?.networkAccess ?? null, networkDefault))}</code>`);
  }
  if (provider === "ollama") {
    lines.push(`Temperature: <code>${escapeHtml(valueOrInherit(overrides?.temperature ?? null, "configured default"))}</code>`);
    lines.push(`Context: <code>${escapeHtml(valueOrInherit(overrides?.numCtx ?? null, "model default"))}</code>`);
  }
  if (options.error !== undefined && options.error !== null && options.error.length > 0) {
    lines.push(`Catalog: ${escapeHtml(options.error)}`);
  }
  lines.push("");
  lines.push("Commands: <code>/provider</code>, <code>/model</code>, <code>/think</code>, <code>/speed</code>, <code>/timeout</code>, <code>/runtime models</code>, <code>/runtime reset</code>");
  return clampTelegramText(lines.join("\n"));
}

export function formatEventNotification(state: PublicAppState, event: EventRecord): string {
  const session = event.workSessionId === null ? null : state.workSessions.find((candidate) => candidate.id === event.workSessionId) ?? null;
  const label = session === null ? "app" : sessionLabel(state, session);
  const title = friendlyEventTitle(event);
  const message = typeof event.payload.message === "string"
    ? event.payload.message
    : typeof event.payload.summary === "string"
      ? event.payload.summary
      : typeof event.payload.reason === "string"
        ? event.payload.reason
        : "";
  const detail = friendlyEventDetail(event, message);
  return clampTelegramText([
    `<b>${escapeHtml(title)}</b>`,
    `Session: ${escapeHtml(label)}`,
    detail.length > 0 ? escapeHtml(detail) : "",
  ].filter(Boolean).join("\n"));
}

function payloadText(event: EventRecord, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value : "";
}

function friendlyEventTitle(event: EventRecord): string {
  switch (event.eventName) {
    case "chat.message.received":
      return "Reading your request";
    case "intent.classified":
      return payloadText(event, "deliveryKind") === "research" ? "Starting research" : "Drafting the plan";
    case "plan.created":
      return "Plan drafted";
    case "approval.requested":
      return "Approval requested";
    case "task.started":
      return "Working on a task";
    case "task.completed":
      return "Task complete";
    case "task.failed":
      return "Task failed";
    case "task.timeout.needs_decision":
      return "Task needs a decision";
    case "verification.started":
      return "Running verification";
    case "verification.passed":
      return "Verification passed";
    case "verification.failed":
      return "Verification failed";
    case "preview.starting":
      return "Starting preview";
    case "preview.ready":
      return "Preview ready";
    case "preview.failed":
      return "Preview failed";
    case "snapshot.completed":
      return "Preview screenshot captured";
    case "snapshot.failed":
      return "Preview screenshot failed";
    case "handoff.created":
      return "Handoff created";
    case "session.finished":
      return "Session finished";
    case "session.blocked":
      return "Session blocked";
    case "session.failed":
      return "Session failed";
    case "session.canceled":
      return "Session canceled";
    default:
      return event.eventName;
  }
}

function friendlyEventDetail(event: EventRecord, fallback: string): string {
  switch (event.eventName) {
    case "chat.message.received": {
      const content = payloadText(event, "content").replace(/\s+/g, " ").trim();
      return content.length > 0 ? `Received: ${content.slice(0, 180)}` : "Received your message.";
    }
    case "intent.classified": {
      const intent = payloadText(event, "intent");
      const deliveryKind = payloadText(event, "deliveryKind");
      return [intent.length > 0 ? `Intent: ${intent}` : "", deliveryKind.length > 0 ? `Mode: ${deliveryKind}` : ""].filter(Boolean).join(" · ");
    }
    case "plan.created":
    case "task.started":
    case "task.completed": {
      const title = payloadText(event, "title");
      return title.length > 0 ? title : fallback;
    }
    case "preview.ready": {
      const url = payloadText(event, "url");
      return url.length > 0 ? url : fallback;
    }
    case "snapshot.completed": {
      const artifactId = payloadText(event, "screenshotArtifactId");
      return artifactId.length > 0 ? `Screenshot artifact: ${artifactId.slice(0, 8)}` : "Snapshot evidence captured.";
    }
    default:
      return fallback;
  }
}
