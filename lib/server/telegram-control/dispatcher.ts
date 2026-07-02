import { getConfig } from "@/lib/server/config";
import { getDatabaseSnapshot, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { armPreviewIdleStopForWorkSession, startPreviewForWorkSession, stopPreview } from "@/lib/server/preview-manager";
import { createProjectBundle, uniqueGeneratedProjectSlug } from "@/lib/server/projects";
import { abortWorkSessionOperations } from "@/lib/server/runtime/operation-registry";
import { abortWorkSessionProcesses } from "@/lib/server/runtime/process-registry";
import { effectiveProviderForSession, getRuntimeOptionsForProvider, patchWorkSessionRuntime, resetWorkSessionRuntime, selectableProviders, setWorkSessionProvider } from "@/lib/server/work-session-runtime-control";
import { approveOrRejectApproval, forceHandoff, handleUserMessage, repairPreviewFailure, scheduleControllerAdvance } from "@/lib/server/workflow-controller";
import { claimTelegramUpdateId, clearPairingAttempts, createTelegramCallbackNonce, callbackNonceMatches, createAuditId, mutateTelegramControlState, pairingLockoutUntil, registerPairingFailure, verifyPairingCode } from "@/lib/server/telegram-control/state";
import { chatIsAllowed, findAuthorizedPrincipal, hasRole, requireMentionForGroup } from "@/lib/server/telegram-control/security";
import { escapeHtml, formatApproval, formatRuntimeStatus, formatSessionStatus } from "@/lib/server/telegram-control/format";
import { standardServiceTier } from "@/lib/shared/runtime-overrides";
import type {
  AgentProvider,
  ApprovalRecord,
  CodexRuntimeOptions,
  Identifier,
  PreviewServerRecord,
  PublicAppState,
  RuntimeOverrides,
  TaskRecord,
  WorkSessionRecord,
} from "@/lib/shared/types";
import type {
  TelegramBotEffect,
  TelegramControlResponse,
  TelegramInboundCallback,
  TelegramInboundMessage,
  TelegramInboundUpdate,
  TelegramPrincipal,
} from "@/lib/server/telegram-control/types";

interface DispatchContext {
  state: PublicAppState;
  principal: TelegramPrincipal;
  chatId: string;
  userId: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function message(chatId: string, text: string, buttons?: TelegramBotEffect["buttons"]): TelegramBotEffect {
  return { type: "message", chatId, text, parseMode: "HTML", buttons };
}

function answer(callbackQueryId: string, text: string): TelegramBotEffect {
  return { type: "answerCallback", callbackQueryId, text };
}

function commandName(raw: string): string {
  const [first = ""] = raw.trim().split(/\s+/, 1);
  return first.replace(/@[\w_]+$/, "").toLowerCase();
}

function commandArgs(raw: string): string {
  const trimmed = raw.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace < 0 ? "" : trimmed.slice(firstSpace).trim();
}

function isTerminalPreviewIdle(session: WorkSessionRecord): boolean {
  return ["completed", "blocked", "failed", "canceled", "handoff_needed"].includes(session.currentState);
}

function sessionsFor(state: PublicAppState): WorkSessionRecord[] {
  return [...state.workSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function latestPlan(state: PublicAppState, workSessionId: Identifier) {
  return state.plans.filter((plan) => plan.workSessionId === workSessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

function tasksFor(state: PublicAppState, planId: Identifier | null): TaskRecord[] {
  if (planId === null) return [];
  return state.tasks.filter((task) => task.planId === planId).sort((a, b) => a.ordinal - b.ordinal);
}

function latestVerification(state: PublicAppState, workSessionId: Identifier) {
  return state.verificationRuns.filter((run) => run.workSessionId === workSessionId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

function latestPreview(state: PublicAppState, workSessionId: Identifier): PreviewServerRecord | null {
  return state.previewServers.filter((preview) => preview.workSessionId === workSessionId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null;
}

function pendingApprovals(state: PublicAppState, workSessionId?: Identifier): ApprovalRecord[] {
  return state.approvals
    .filter((approval) => approval.status === "pending" && (workSessionId === undefined || approval.workSessionId === workSessionId))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function runtimeChangeAllowedState(session: WorkSessionRecord): boolean {
  return !["planning", "executing", "queued", "verifying"].includes(session.currentState);
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

function parseProviderArg(raw: string): AgentProvider | null {
  const value = raw.trim().toLowerCase();
  if (value === "codex" || value === "codex-cli") return "codex-cli";
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "agy" || value === "antigravity" || value === "antigravity-cli") return "antigravity-cli";
  if (value === "ollama" || value === "local") return "ollama";
  return null;
}

function parseInherit(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "inherit" || normalized === "default" || normalized === "reset" || normalized === "clear";
}

function modelBySelector(options: CodexRuntimeOptions, selector: string): string | null | undefined {
  const trimmed = selector.trim();
  if (parseInherit(trimmed)) {
    return null;
  }
  const ordinal = Number(trimmed);
  if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= options.models.length) {
    return options.models[ordinal - 1]?.slug;
  }
  return options.models.find((model) => model.slug === trimmed || model.displayName.toLowerCase() === trimmed.toLowerCase())?.slug ?? trimmed;
}

function tierBySelector(options: CodexRuntimeOptions, selector: string): string | null | undefined {
  const trimmed = selector.trim();
  const normalized = trimmed.toLowerCase();
  if (parseInherit(trimmed)) {
    return null;
  }
  if (normalized === "standard") {
    return standardServiceTier;
  }
  const tiers = options.models.flatMap((model) => model.serviceTiers ?? []);
  if (normalized === "fast") {
    return tiers.find((tier) => /fast|priority/i.test(`${tier.id} ${tier.name}`))?.id;
  }
  return tiers.find((tier) => tier.id === trimmed || tier.name.toLowerCase() === normalized)?.id ?? trimmed;
}

function runtimeOptionsModelList(options: CodexRuntimeOptions): string {
  if (options.models.length === 0) {
    return options.error !== null && options.error.length > 0
      ? `No models available. ${escapeHtml(options.error)}`
      : "No models available from this provider catalog.";
  }
  const lines = options.models.slice(0, 25).map((model, index) => {
    const efforts = model.supportedReasoningLevels.map((level) => level.effort).join(", ");
    const tiers = (model.serviceTiers ?? []).map((tier) => tier.name).join(", ");
    return `${index + 1}. <code>${escapeHtml(model.slug)}</code> ${escapeHtml(model.displayName)}${efforts.length > 0 ? `\n   thinking: ${escapeHtml(efforts)}` : ""}${tiers.length > 0 ? `\n   speed: ${escapeHtml(tiers)}` : ""}`;
  });
  const suffix = options.models.length > 25 ? `\n...and ${options.models.length - 25} more.` : "";
  return `${lines.join("\n")}${suffix}`;
}

async function audit(input: {
  principal: TelegramPrincipal | null;
  telegramUserId?: string | null;
  chatId: string | null;
  workSessionId: Identifier | null;
  command: string;
  ok: boolean;
  summary: string;
}): Promise<void> {
  await mutateTelegramControlState((state) => {
    state.auditLog.push({
      id: createAuditId(),
      telegramUserId: input.principal?.telegramUserId ?? input.telegramUserId ?? "",
      telegramChatId: input.chatId ?? "",
      workSessionId: input.workSessionId,
      command: input.command,
      ok: input.ok,
      summary: input.summary.slice(0, 500),
      createdAt: nowIso(),
    });
  });
}

async function boundSessionId(chatId: string, userId: string): Promise<Identifier | null> {
  const state = await mutateTelegramControlState((store) => {
    return store.chatBindings.find((binding) => binding.telegramChatId === chatId && binding.telegramUserId === userId)?.workSessionId ?? null;
  });
  return state;
}

async function setBinding(chatId: string, userId: string, workSessionId: Identifier): Promise<void> {
  await mutateTelegramControlState((state) => {
    const existing = state.chatBindings.find((binding) => binding.telegramChatId === chatId && binding.telegramUserId === userId);
    if (existing === undefined) {
      state.chatBindings.push({ telegramChatId: chatId, telegramUserId: userId, workSessionId, createdAt: nowIso(), updatedAt: nowIso() });
    } else {
      existing.workSessionId = workSessionId;
      existing.updatedAt = nowIso();
    }
  });
}

async function resolveSelectedSession(ctx: Pick<DispatchContext, "state" | "chatId" | "userId">): Promise<WorkSessionRecord | null> {
  const bound = await boundSessionId(ctx.chatId, ctx.userId);
  if (bound !== null) {
    const session = ctx.state.workSessions.find((candidate) => candidate.id === bound);
    if (session !== undefined) {
      return session;
    }
  }
  return sessionsFor(ctx.state)[0] ?? null;
}

function parseSessionSelector(selector: string, state: PublicAppState): WorkSessionRecord | null {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const sessions = sessionsFor(state);
  const ordinal = Number(trimmed);
  if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= sessions.length) {
    return sessions[ordinal - 1] ?? null;
  }
  return sessions.find((session) => session.id.startsWith(trimmed)) ?? null;
}

async function handlePair(update: TelegramInboundMessage): Promise<TelegramControlResponse> {
  const code = commandArgs(update.text);
  if (update.fromId === null || code.length === 0) {
    return { ok: false, effects: [message(update.chatId, "Usage: <code>/pair CODE</code>")] };
  }
  const userId = update.fromId;
  const { outcome, role } = await mutateTelegramControlState((state): { outcome: "paired" | "invalid" | "locked"; role: TelegramPrincipal["role"] } => {
    if (pairingLockoutUntil(state, userId) !== null) {
      return { outcome: "locked", role: "operator" };
    }
    const challenge = state.pairingChallenges.find((candidate) => candidate.usedAt === null && Date.parse(candidate.expiresAt) > Date.now() && verifyPairingCode(candidate, code));
    if (challenge === undefined) {
      registerPairingFailure(state, userId);
      return { outcome: "invalid", role: "operator" };
    }
    challenge.usedAt = nowIso();
    const grantedRole = challenge.role;
    const existing = state.principals.find((principal) => principal.telegramUserId === userId);
    if (existing === undefined) {
      state.principals.push({
        telegramUserId: userId,
        role: grantedRole,
        firstName: update.firstName ?? null,
        username: update.username ?? null,
        createdAt: nowIso(),
        revokedAt: null,
      });
    } else {
      existing.role = grantedRole;
      existing.firstName = update.firstName ?? existing.firstName;
      existing.username = update.username ?? existing.username;
      existing.revokedAt = null;
    }
    clearPairingAttempts(state, userId);
    return { outcome: "paired", role: grantedRole };
  });
  const text = outcome === "paired"
    ? `Paired as <code>${role}</code>. Use <code>/sessions</code> next.`
    : outcome === "locked"
      ? "Too many pairing attempts. Try again later."
      : "Pairing failed. The code may be invalid or expired.";
  await audit({ principal: null, chatId: update.chatId, workSessionId: null, command: "/pair", ok: outcome === "paired", summary: outcome === "paired" ? `paired as ${role}` : outcome === "locked" ? "pairing locked out" : "invalid pairing code" });
  return { ok: outcome === "paired", effects: [message(update.chatId, text)] };
}

async function withAuthorizedContext(update: TelegramInboundUpdate): Promise<{ ctx: DispatchContext | null; response?: TelegramControlResponse }> {
  const chatId = update.kind === "message" ? update.chatId : update.chatId;
  const userId = update.kind === "message" ? update.fromId : update.fromId;
  if (chatId === null || userId === null) {
    return { ctx: null, response: { ok: false, effects: [] } };
  }
  const store = await mutateTelegramControlState((state) => state);
  const principal = findAuthorizedPrincipal(store, userId);
  if (!chatIsAllowed(update)) {
    await audit({ principal, chatId, workSessionId: null, command: update.kind, ok: false, summary: "chat not allowed" });
    return { ctx: null, response: { ok: false, effects: [message(chatId, "This Telegram chat is not allowed for local control.")] } };
  }
  if (principal === null) {
    await audit({ principal: null, telegramUserId: userId, chatId, workSessionId: null, command: update.kind, ok: false, summary: "unauthorized user" });
    return { ctx: null, response: { ok: false, effects: [message(chatId, "Unauthorized. Pair this account locally before using Telegram control.")] } };
  }
  const state = await getDatabaseSnapshot();
  return { ctx: { state, principal, chatId, userId } };
}

async function handleSessions(ctx: DispatchContext): Promise<TelegramControlResponse> {
  const sessions = sessionsFor(ctx.state);
  if (sessions.length === 0) {
    return { ok: true, effects: [message(ctx.chatId, "No work sessions exist.")] };
  }
  const lines = sessions.slice(0, 10).map((session, index) => {
    const chat = ctx.state.chatSessions.find((candidate) => candidate.id === session.chatSessionId);
    return `${index + 1}. <code>${shortId(session.id)}</code> ${escapeHtml(chat?.title ?? session.id)} - <code>${escapeHtml(session.currentState)}</code>`;
  });
  return { ok: true, effects: [message(ctx.chatId, `${lines.join("\n")}\n\nUse <code>/use N</code> to bind this Telegram chat.`)] };
}

async function handleNewChat(ctx: DispatchContext, args: string): Promise<TelegramControlResponse> {
  if (!hasRole(ctx.principal, "operator")) {
    return { ok: false, effects: [message(ctx.chatId, "Operator role required to create a new chat.")] };
  }
  const title = args.trim().replace(/\s+/g, " ").slice(0, 80) || `Telegram Chat ${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const slug = await uniqueGeneratedProjectSlug(title);
  const created = await createProjectBundle({ name: title, slug });
  await setBinding(ctx.chatId, ctx.userId, created.workSession.id);
  await audit({
    principal: ctx.principal,
    chatId: ctx.chatId,
    workSessionId: created.workSession.id,
    command: "/new",
    ok: true,
    summary: `created ${created.project.slug}`,
  });
  return {
    ok: true,
    effects: [message(ctx.chatId, [
      `Created new chat: <b>${escapeHtml(created.chatSession.title)}</b>`,
      `Work session: <code>${shortId(created.workSession.id)}</code>`,
      `Project: <code>${escapeHtml(created.project.slug)}</code>`,
      "",
      "This Telegram chat is now bound to it. Send your first request when ready.",
    ].join("\n"))],
  };
}

async function handleUse(ctx: DispatchContext, args: string): Promise<TelegramControlResponse> {
  const session = parseSessionSelector(args, ctx.state);
  if (session === null) {
    return { ok: false, effects: [message(ctx.chatId, "Session not found. Use <code>/sessions</code>.")] };
  }
  await setBinding(ctx.chatId, ctx.userId, session.id);
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: "/use", ok: true, summary: "session bound" });
  return { ok: true, effects: [message(ctx.chatId, `Bound to <code>${shortId(session.id)}</code>.`)] };
}

async function handleStatus(ctx: DispatchContext): Promise<TelegramControlResponse> {
  const session = await resolveSelectedSession(ctx);
  if (session === null) {
    return { ok: false, effects: [message(ctx.chatId, "No selected work session. Use <code>/sessions</code>.")] };
  }
  const plan = latestPlan(ctx.state, session.id);
  return {
    ok: true,
    effects: [message(ctx.chatId, formatSessionStatus({
      state: ctx.state,
      workSession: session,
      plan,
      tasks: tasksFor(ctx.state, plan?.id ?? null),
      approval: pendingApprovals(ctx.state, session.id)[0] ?? null,
      verification: latestVerification(ctx.state, session.id),
      preview: latestPreview(ctx.state, session.id),
    }))],
  };
}

async function selectedRuntimeContext(ctx: DispatchContext): Promise<{
  session: WorkSessionRecord | null;
  provider: AgentProvider | null;
  options: CodexRuntimeOptions | null;
}> {
  const session = await resolveSelectedSession(ctx);
  if (session === null) {
    return { session: null, provider: null, options: null };
  }
  const provider = effectiveProviderForSession(session);
  const options = await getRuntimeOptionsForProvider(provider);
  return { session, provider, options };
}

async function handleRuntime(ctx: DispatchContext, args: string): Promise<TelegramControlResponse> {
  const action = args.trim().toLowerCase();
  const { session, provider, options } = await selectedRuntimeContext(ctx);
  if (session === null || provider === null || options === null) {
    return { ok: false, effects: [message(ctx.chatId, "No selected work session. Use <code>/sessions</code>.")] };
  }
  if (action === "models" || action === "model") {
    return { ok: true, effects: [message(ctx.chatId, `<b>${escapeHtml(providerLabel(provider))} models</b>\n${runtimeOptionsModelList(options)}`)] };
  }
  if (action === "refresh") {
    const refreshed = await getRuntimeOptionsForProvider(provider, { forceRefresh: true });
    return { ok: true, effects: [message(ctx.chatId, `<b>${escapeHtml(providerLabel(provider))} models refreshed</b>\n${runtimeOptionsModelList(refreshed)}`)] };
  }
  if (action === "reset") {
    if (!hasRole(ctx.principal, "operator")) {
      return { ok: false, effects: [message(ctx.chatId, "Operator role required.")] };
    }
    if (!runtimeChangeAllowedState(session)) {
      return { ok: false, effects: [message(ctx.chatId, `Runtime changes are blocked while the session is <code>${escapeHtml(session.currentState)}</code>. Pause or wait for the current run to finish.`)] };
    }
    const result = await resetWorkSessionRuntime(session.id);
    await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: "/runtime reset", ok: true, summary: "runtime overrides reset" });
    const nextOptions = await getRuntimeOptionsForProvider(result.provider);
    return { ok: true, effects: [message(ctx.chatId, `${formatRuntimeStatus({ state: ctx.state, workSession: result.workSession, provider: result.provider, options: nextOptions })}${result.validationNote !== null ? `\n\n${escapeHtml(result.validationNote)}` : ""}`)] };
  }
  if (action.length > 0) {
    return { ok: false, effects: [message(ctx.chatId, "Usage: <code>/runtime</code>, <code>/runtime models</code>, <code>/runtime refresh</code>, or <code>/runtime reset</code>.")] };
  }
  return { ok: true, effects: [message(ctx.chatId, formatRuntimeStatus({ state: ctx.state, workSession: session, provider, options }))] };
}

async function handleProvider(ctx: DispatchContext, args: string): Promise<TelegramControlResponse> {
  const value = args.trim();
  const session = await resolveSelectedSession(ctx);
  if (session === null) {
    return { ok: false, effects: [message(ctx.chatId, "No selected work session. Use <code>/sessions</code>.")] };
  }
  if (value.length === 0) {
    const current = effectiveProviderForSession(session);
    return { ok: true, effects: [message(ctx.chatId, [
      `Current provider: <code>${escapeHtml(current)}</code> (${escapeHtml(providerLabel(current))})`,
      `Available: ${selectableProviders.map((provider) => `<code>${provider}</code>`).join(", ")}`,
      "Usage: <code>/provider codex</code>, <code>/provider claude</code>, <code>/provider agy</code>, or <code>/provider ollama</code>.",
    ].join("\n"))] };
  }
  if (!hasRole(ctx.principal, "operator")) {
    return { ok: false, effects: [message(ctx.chatId, "Operator role required.")] };
  }
  if (!runtimeChangeAllowedState(session)) {
    return { ok: false, effects: [message(ctx.chatId, `Provider changes are blocked while the session is <code>${escapeHtml(session.currentState)}</code>. Pause or wait for the current run to finish.`)] };
  }
  const provider = parseProviderArg(value);
  if (provider === null) {
    return { ok: false, effects: [message(ctx.chatId, "Unknown provider. Use <code>codex</code>, <code>claude</code>, <code>agy</code>, or <code>ollama</code>.")] };
  }
  const updated = await setWorkSessionProvider(session.id, provider);
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: "/provider", ok: true, summary: `provider set to ${provider}` });
  const options = await getRuntimeOptionsForProvider(provider);
  return { ok: true, effects: [message(ctx.chatId, formatRuntimeStatus({ state: ctx.state, workSession: updated, provider, options }))] };
}

async function handleRuntimePatchCommand(
  ctx: DispatchContext,
  command: string,
  args: string,
  makePatch: (input: { session: WorkSessionRecord; provider: AgentProvider; options: CodexRuntimeOptions; args: string }) => RuntimeOverrides | Partial<RuntimeOverrides> | string,
): Promise<TelegramControlResponse> {
  if (!hasRole(ctx.principal, "operator")) {
    return { ok: false, effects: [message(ctx.chatId, "Operator role required.")] };
  }
  const { session, provider, options } = await selectedRuntimeContext(ctx);
  if (session === null || provider === null || options === null) {
    return { ok: false, effects: [message(ctx.chatId, "No selected work session. Use <code>/sessions</code>.")] };
  }
  if (!runtimeChangeAllowedState(session)) {
    return { ok: false, effects: [message(ctx.chatId, `Runtime changes are blocked while the session is <code>${escapeHtml(session.currentState)}</code>. Pause or wait for the current run to finish.`)] };
  }
  const patch = makePatch({ session, provider, options, args });
  if (typeof patch === "string") {
    return { ok: false, effects: [message(ctx.chatId, patch)] };
  }
  const result = await patchWorkSessionRuntime(session.id, patch);
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command, ok: true, summary: `${command} updated` });
  const nextOptions = await getRuntimeOptionsForProvider(result.provider);
  return {
    ok: true,
    effects: [message(ctx.chatId, `${formatRuntimeStatus({ state: ctx.state, workSession: result.workSession, provider: result.provider, options: nextOptions })}${result.validationNote !== null ? `\n\n${escapeHtml(result.validationNote)}` : ""}`)],
  };
}

async function handleModel(ctx: DispatchContext, args: string): Promise<TelegramControlResponse> {
  if (args.trim().length === 0 || args.trim().toLowerCase() === "list") {
    const { provider, options } = await selectedRuntimeContext(ctx);
    if (provider === null || options === null) {
      return { ok: false, effects: [message(ctx.chatId, "No selected work session. Use <code>/sessions</code>.")] };
    }
    return { ok: true, effects: [message(ctx.chatId, `<b>${escapeHtml(providerLabel(provider))} models</b>\n${runtimeOptionsModelList(options)}\n\nUse <code>/model N</code> or <code>/model model-slug</code>.`)] };
  }
  return handleRuntimePatchCommand(ctx, "/model", args, ({ options, args: raw }) => {
    const model = modelBySelector(options, raw);
    if (model === undefined) {
      return "Model not found. Use <code>/model list</code> first.";
    }
    return { model };
  });
}

async function handleThink(ctx: DispatchContext, args: string): Promise<TelegramControlResponse> {
  return handleRuntimePatchCommand(ctx, "/think", args, ({ provider, options, args: raw }) => {
    const value = raw.trim();
    if (value.length === 0) {
      return "Usage: <code>/think inherit</code>, <code>/think low</code>, <code>/think medium</code>, <code>/think high</code>, or <code>/think xhigh</code>.";
    }
    if (provider === "ollama" || provider === "antigravity-cli") {
      return `${escapeHtml(providerLabel(provider))} does not expose app-owned thinking-depth control.`;
    }
    if (parseInherit(value)) {
      return { reasoningEffort: null };
    }
    const activeEfforts = new Set(options.models.flatMap((model) => model.supportedReasoningLevels.map((level) => level.effort)));
    if (activeEfforts.size > 0 && !activeEfforts.has(value)) {
      return `Thinking depth <code>${escapeHtml(value)}</code> is not in the current provider catalog. Use <code>/runtime models</code>.`;
    }
    return { reasoningEffort: value };
  });
}

async function handleSpeed(ctx: DispatchContext, args: string): Promise<TelegramControlResponse> {
  return handleRuntimePatchCommand(ctx, "/speed", args, ({ provider, options, args: raw }) => {
    const value = raw.trim();
    if (value.length === 0) {
      return "Usage: <code>/speed inherit</code>, <code>/speed standard</code>, <code>/speed fast</code>, or <code>/speed tier-id</code>.";
    }
    if (provider !== "codex-cli" && provider !== "claude-code") {
      return `${escapeHtml(providerLabel(provider))} does not expose app-owned speed-tier control.`;
    }
    const tier = tierBySelector(options, value);
    if (tier === undefined) {
      return "No fast speed tier is available for the current provider/model.";
    }
    return { serviceTier: tier };
  });
}

async function handleTimeout(ctx: DispatchContext, args: string): Promise<TelegramControlResponse> {
  return handleRuntimePatchCommand(ctx, "/timeout", args, ({ args: raw }) => {
    const value = raw.trim();
    if (value.length === 0) {
      return "Usage: <code>/timeout inherit</code> or <code>/timeout 300</code>.";
    }
    if (parseInherit(value)) {
      return { timeoutMs: null };
    }
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 10) {
      return "Timeout must be a number of seconds, at least 10.";
    }
    return { timeoutMs: Math.round(seconds * 1000) };
  });
}

async function approvalButtons(ctx: DispatchContext, approval: ApprovalRecord): Promise<TelegramBotEffect["buttons"]> {
  const approveNonce = await createTelegramCallbackNonce({ telegramUserId: ctx.userId, telegramChatId: ctx.chatId, action: "approve", targetId: approval.id });
  const rejectNonce = await createTelegramCallbackNonce({ telegramUserId: ctx.userId, telegramChatId: ctx.chatId, action: "reject", targetId: approval.id });
  return [[
    { text: "Approve", callbackData: `tc:a:${approval.id}:${approveNonce}` },
    { text: "Reject", callbackData: `tc:r:${approval.id}:${rejectNonce}` },
  ]];
}

async function handleApprovals(ctx: DispatchContext): Promise<TelegramControlResponse> {
  const approvals = pendingApprovals(ctx.state);
  if (approvals.length === 0) {
    return { ok: true, effects: [message(ctx.chatId, "No pending approvals.")] };
  }
  const effects: TelegramBotEffect[] = [];
  for (const approval of approvals.slice(0, 5)) {
    effects.push(message(ctx.chatId, formatApproval(ctx.state, approval), await approvalButtons(ctx, approval)));
  }
  return { ok: true, effects };
}

async function resolveApprovalCommand(ctx: DispatchContext, args: string, status: "approved" | "rejected"): Promise<TelegramControlResponse> {
  if (!hasRole(ctx.principal, "operator")) {
    return { ok: false, effects: [message(ctx.chatId, "Operator role required.")] };
  }
  const approvals = pendingApprovals(ctx.state);
  const [selector = "", ...noteParts] = args.split(/\s+/);
  const ordinal = Number(selector);
  const approval = Number.isInteger(ordinal) ? approvals[ordinal - 1] : approvals.find((candidate) => candidate.id.startsWith(selector));
  if (approval === undefined) {
    return { ok: false, effects: [message(ctx.chatId, "Approval not found. Use <code>/approvals</code>.")] };
  }
  const result = await approveOrRejectApproval({ approvalId: approval.id, status, note: noteParts.join(" ").trim() || undefined }, { advance: status === "approved" ? "background" : "none" });
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: approval.workSessionId, command: status, ok: true, summary: `approval ${status}` });
  return { ok: true, effects: [message(ctx.chatId, `Approval ${escapeHtml(status)}. State: <code>${escapeHtml(result.state)}</code>.`)] };
}

async function abortWorkSessionFromTelegram(ctx: DispatchContext, session: WorkSessionRecord): Promise<TelegramControlResponse> {
  const processes = abortWorkSessionProcesses(session.id, "Telegram requested abort.");
  const operations = abortWorkSessionOperations(session.id, "Telegram requested abort.");
  await mutateDatabase((db) => {
    const record = db.workSessions.find((candidate) => candidate.id === session.id);
    if (record !== undefined && ["planning", "executing", "queued", "verifying"].includes(record.currentState)) {
      record.currentState = "canceled";
      record.paused = false;
      record.awaitingStep = false;
      record.nextActionLabel = null;
      updateWorkSessionTimestamp(record);
    }
  });
  await emitEvent({
    workSessionId: session.id,
    eventName: "session.canceled",
    aggregateType: "work_session",
    aggregateId: session.id,
    priority: "high",
    payload: { reason: "Abort requested from Telegram.", message: "Session canceled by Telegram control." },
  });
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: "/abort", ok: true, summary: "aborted" });
  return { ok: true, effects: [message(ctx.chatId, `Abort requested for ${processes} process(es) and ${operations} operation(s).`)] };
}

async function handleControl(ctx: DispatchContext, action: "pause" | "resume" | "step" | "abort"): Promise<TelegramControlResponse> {
  const session = await resolveSelectedSession(ctx);
  if (session === null) {
    return { ok: false, effects: [message(ctx.chatId, "No selected work session.")] };
  }
  if (!hasRole(ctx.principal, "operator")) {
    return { ok: false, effects: [message(ctx.chatId, "Operator role required.")] };
  }

  if (action === "pause") {
    const stopped = abortWorkSessionOperations(session.id, "Telegram requested pause.");
    await mutateDatabase((db) => {
      const record = db.workSessions.find((candidate) => candidate.id === session.id);
      if (record !== undefined) {
        record.paused = true;
        updateWorkSessionTimestamp(record);
      }
    });
    await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: "/pause", ok: true, summary: "paused" });
    return { ok: true, effects: [message(ctx.chatId, `Paused. Stopped ${stopped} controller operation(s).`)] };
  }

  if (action === "resume") {
    await mutateDatabase((db) => {
      const record = db.workSessions.find((candidate) => candidate.id === session.id);
      if (record !== undefined) {
        record.paused = false;
        updateWorkSessionTimestamp(record);
      }
    });
    scheduleControllerAdvance(session.id, "telegram-resume");
    await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: "/resume", ok: true, summary: "resumed" });
    return { ok: true, effects: [message(ctx.chatId, "Resumed.")] };
  }

  if (action === "step") {
    await mutateDatabase((db) => {
      const record = db.workSessions.find((candidate) => candidate.id === session.id);
      if (record !== undefined) {
        record.paused = false;
        updateWorkSessionTimestamp(record);
      }
    });
    scheduleControllerAdvance(session.id, "telegram-step", { trigger: "step" });
    await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: "/step", ok: true, summary: "step scheduled" });
    return { ok: true, effects: [message(ctx.chatId, "Step scheduled.")] };
  }

  const nonce = await createTelegramCallbackNonce({ telegramUserId: ctx.userId, telegramChatId: ctx.chatId, action: "abort", targetId: session.id, ttlMinutes: 5 });
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: "/abort", ok: true, summary: "abort confirmation requested" });
  return {
    ok: true,
    effects: [message(ctx.chatId, [
      "<b>Confirm abort</b>",
      `Session: <code>${shortId(session.id)}</code>`,
      "This cancels running provider/controller work for the selected session.",
    ].join("\n"), [[
      { text: "Confirm abort", callbackData: `tc:ab:${session.id}:${nonce}` },
    ]])],
  };
}

async function handlePreview(ctx: DispatchContext, args: string): Promise<TelegramControlResponse> {
  if (!hasRole(ctx.principal, "operator")) {
    return { ok: false, effects: [message(ctx.chatId, "Operator role required.")] };
  }
  const session = await resolveSelectedSession(ctx);
  if (session === null) {
    return { ok: false, effects: [message(ctx.chatId, "No selected work session.")] };
  }
  const action = args.trim().toLowerCase() || "status";
  const current = latestPreview(ctx.state, session.id);
  let preview: PreviewServerRecord | null = current;
  if (action === "start" || action === "restart") {
    preview = await startPreviewForWorkSession(session, { policy: action === "restart" ? "hard_restart" : "refresh_existing_or_start" });
    if (isTerminalPreviewIdle(session)) {
      await armPreviewIdleStopForWorkSession(session.id, "manual-preview-action");
    }
  } else if (action === "stop") {
    if (current === null) {
      return { ok: false, effects: [message(ctx.chatId, "No preview to stop.")] };
    }
    preview = await stopPreview(current.id, "manual");
  } else if (action === "repair") {
    if (current === null) {
      return { ok: false, effects: [message(ctx.chatId, "No preview to repair.")] };
    }
    await repairPreviewFailure({ workSessionId: session.id, previewId: current.id });
  } else if (action !== "status") {
    return { ok: false, effects: [message(ctx.chatId, "Usage: <code>/preview [start|restart|stop|repair]</code>")] };
  }
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: `/preview ${action}`, ok: true, summary: "preview command" });
  return { ok: true, effects: [message(ctx.chatId, preview === null ? "No preview." : `Preview: <code>${escapeHtml(preview.status)}</code>\n${escapeHtml(preview.url)}`)] };
}

async function handlePlainText(ctx: DispatchContext, text: string): Promise<TelegramControlResponse> {
  if (!hasRole(ctx.principal, "operator")) {
    return { ok: false, effects: [message(ctx.chatId, "Operator role required to send work-session messages.")] };
  }
  const session = await resolveSelectedSession(ctx);
  if (session === null) {
    return { ok: false, effects: [message(ctx.chatId, "No selected work session. Use <code>/sessions</code> and <code>/use N</code>.")] };
  }
  const maxChars = getConfig().telegramControlMaxTextChars;
  const result = await handleUserMessage({
    content: text.slice(0, maxChars),
    projectId: session.projectId,
    chatSessionId: session.chatSessionId,
  });
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: "message", ok: true, summary: `message routed: ${result.steps.join(",")}` });
  return { ok: true, effects: [message(ctx.chatId, `Message accepted. State: <code>${escapeHtml(result.state)}</code>.`)] };
}

async function handleHandoff(ctx: DispatchContext): Promise<TelegramControlResponse> {
  if (!hasRole(ctx.principal, "operator")) {
    return { ok: false, effects: [message(ctx.chatId, "Operator role required.")] };
  }
  const session = await resolveSelectedSession(ctx);
  if (session === null) {
    return { ok: false, effects: [message(ctx.chatId, "No selected work session.")] };
  }
  const result = await forceHandoff(session.id);
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: session.id, command: "/handoff", ok: true, summary: "handoff" });
  return { ok: true, effects: [message(ctx.chatId, `Handoff created. State: <code>${escapeHtml(result.state)}</code>.`)] };
}

async function handleRevoke(ctx: DispatchContext, args: string): Promise<TelegramControlResponse> {
  if (!hasRole(ctx.principal, "admin")) {
    return { ok: false, effects: [message(ctx.chatId, "Admin role required to revoke access.")] };
  }
  const target = args.trim().split(/\s+/)[0] ?? "";
  if (!/^\d+$/.test(target)) {
    return { ok: false, effects: [message(ctx.chatId, "Usage: <code>/revoke TELEGRAM_USER_ID</code> (numeric id).")] };
  }
  await mutateTelegramControlState((state) => {
    const existing = state.principals.find((principal) => principal.telegramUserId === target);
    if (existing === undefined) {
      state.principals.push({ telegramUserId: target, role: "viewer", firstName: null, username: null, createdAt: nowIso(), revokedAt: nowIso() });
    } else {
      existing.revokedAt = nowIso();
    }
    state.chatBindings = state.chatBindings.filter((binding) => binding.telegramUserId !== target);
  });
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: null, command: "/revoke", ok: true, summary: `revoked ${target}` });
  return { ok: true, effects: [message(ctx.chatId, `Revoked Telegram user <code>${escapeHtml(target)}</code>.`)] };
}

async function handleCommand(update: TelegramInboundMessage, ctx: DispatchContext): Promise<TelegramControlResponse> {
  const name = commandName(update.text);
  const args = commandArgs(update.text);
  switch (name) {
    case "/start":
    case "/help":
      return {
        ok: true,
        effects: [message(ctx.chatId, [
          "<b>Local Telegram Control</b>",
          "<code>/sessions</code>, <code>/use N</code>, <code>/status</code>",
          "<code>/new Title</code> creates and binds a fresh generated chat",
          "<code>/approvals</code>, <code>/approve N</code>, <code>/reject N note</code>",
          "<code>/pause</code>, <code>/resume</code>, <code>/step</code>, <code>/abort</code>",
          "<code>/runtime</code>, <code>/provider</code>, <code>/model</code>, <code>/think</code>, <code>/speed</code>, <code>/timeout</code>",
          "<code>/preview start</code>, <code>/handoff</code>",
          "<code>/revoke USER_ID</code> (admin) removes a Telegram user's access",
          "Plain text is sent to the selected work session as chat or steering.",
        ].join("\n"))],
      };
    case "/whoami":
      return { ok: true, effects: [message(ctx.chatId, `Telegram user: <code>${escapeHtml(ctx.userId)}</code>\nRole: <code>${ctx.principal.role}</code>`)] };
    case "/sessions":
      return handleSessions(ctx);
    case "/new":
    case "/newchat":
      return handleNewChat(ctx, args);
    case "/use":
      return handleUse(ctx, args);
    case "/status":
      return handleStatus(ctx);
    case "/runtime":
      return handleRuntime(ctx, args);
    case "/provider":
      return handleProvider(ctx, args);
    case "/model":
      return handleModel(ctx, args);
    case "/think":
      return handleThink(ctx, args);
    case "/speed":
      return handleSpeed(ctx, args);
    case "/timeout":
      return handleTimeout(ctx, args);
    case "/approvals":
      return handleApprovals(ctx);
    case "/approve":
      return resolveApprovalCommand(ctx, args, "approved");
    case "/reject":
      return resolveApprovalCommand(ctx, args, "rejected");
    case "/pause":
      return handleControl(ctx, "pause");
    case "/resume":
      return handleControl(ctx, "resume");
    case "/step":
      return handleControl(ctx, "step");
    case "/abort":
      return handleControl(ctx, "abort");
    case "/preview":
      return handlePreview(ctx, args);
    case "/handoff":
      return handleHandoff(ctx);
    case "/revoke":
      return handleRevoke(ctx, args);
    default:
      return { ok: false, effects: [message(ctx.chatId, "Unknown command. Use <code>/help</code>.")] };
  }
}

async function consumeCallback(update: TelegramInboundCallback): Promise<{ action: "approve" | "reject" | "abort"; targetId: string } | null> {
  const parts = update.data.split(":");
  if (parts.length !== 4 || parts[0] !== "tc") {
    return null;
  }
  const action = parts[1] === "a" ? "approve" : parts[1] === "r" ? "reject" : parts[1] === "ab" ? "abort" : null;
  if (action === null) {
    return null;
  }
  const targetId = parts[2] ?? "";
  const nonce = parts[3] ?? "";
  let matched = false;
  await mutateTelegramControlState((state) => {
    const record = state.callbackNonces.find((candidate) =>
      candidate.telegramUserId === update.fromId &&
      candidate.telegramChatId === update.chatId &&
      candidate.targetId === targetId &&
      candidate.action === action &&
      candidate.usedAt === null &&
      Date.parse(candidate.expiresAt) > Date.now() &&
      callbackNonceMatches(candidate, nonce)
    );
    if (record !== undefined) {
      record.usedAt = nowIso();
      matched = true;
    }
  });
  return matched ? { action, targetId } : null;
}

async function handleCallback(update: TelegramInboundCallback): Promise<TelegramControlResponse> {
  const { ctx, response } = await withAuthorizedContext(update);
  if (ctx === null) {
    return response ?? { ok: false, effects: [] };
  }
  if (!hasRole(ctx.principal, "operator")) {
    return { ok: false, effects: [answer(update.callbackQueryId, "Operator role required.")] };
  }
  const consumed = await consumeCallback(update);
  if (consumed === null) {
    return { ok: false, effects: [answer(update.callbackQueryId, "Expired or invalid button.")] };
  }
  if (consumed.action === "abort") {
    const snapshot = await getDatabaseSnapshot();
    const session = snapshot.workSessions.find((candidate) => candidate.id === consumed.targetId);
    if (session === undefined) {
      return { ok: false, effects: [answer(update.callbackQueryId, "Work session no longer exists.")] };
    }
    const result = await abortWorkSessionFromTelegram(ctx, session);
    return {
      ...result,
      effects: [
        answer(update.callbackQueryId, "Abort requested."),
        ...result.effects,
      ],
    };
  }
  const status = consumed.action === "approve" ? "approved" : "rejected";
  const snapshot = await getDatabaseSnapshot();
  const approval = snapshot.approvals.find((candidate) => candidate.id === consumed.targetId);
  if (approval === undefined || approval.status !== "pending") {
    return { ok: false, effects: [answer(update.callbackQueryId, "Approval is no longer pending.")] };
  }
  const result = await approveOrRejectApproval({ approvalId: approval.id, status }, { advance: status === "approved" ? "background" : "none" });
  await audit({ principal: ctx.principal, chatId: ctx.chatId, workSessionId: approval.workSessionId, command: `callback:${status}`, ok: true, summary: "approval callback" });
  return {
    ok: true,
    effects: [
      answer(update.callbackQueryId, `Approval ${status}.`),
      message(ctx.chatId, `Approval ${escapeHtml(status)}. State: <code>${escapeHtml(result.state)}</code>.`),
    ],
  };
}

export async function dispatchTelegramUpdate(update: TelegramInboundUpdate): Promise<TelegramControlResponse> {
  const config = getConfig();
  if (!config.telegramControlEnabled) {
    return { ok: false, effects: [], error: "Telegram control is disabled." };
  }
  if (!(await claimTelegramUpdateId(update.updateId))) {
    return { ok: true, effects: [] };
  }
  if (update.kind === "callback") {
    return handleCallback(update);
  }
  if (update.text.trim().length === 0) {
    return { ok: true, effects: [] };
  }
  if (!chatIsAllowed(update)) {
    return { ok: true, effects: [] };
  }
  if (commandName(update.text) === "/pair") {
    return handlePair(update);
  }
  if (requireMentionForGroup(update)) {
    return { ok: true, effects: [] };
  }
  const { ctx, response } = await withAuthorizedContext(update);
  if (ctx === null) {
    return response ?? { ok: false, effects: [] };
  }
  const result = update.text.trim().startsWith("/") ? await handleCommand(update, ctx) : await handlePlainText(ctx, update.text.trim());
  await audit({
    principal: ctx.principal,
    chatId: ctx.chatId,
    workSessionId: (await resolveSelectedSession(ctx))?.id ?? null,
    command: commandName(update.text) || "message",
    ok: result.ok,
    summary: result.error ?? "dispatched",
  });
  return result;
}
