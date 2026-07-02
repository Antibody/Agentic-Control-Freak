"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApiResult,
  ApprovalRecord,
  ArtifactRecord,
  EventRecord,
  HandoffRecord,
  PlanJson,
  PlanRecord,
  PreviewServerRecord,
  ProjectMemoryCategory,
  ProjectMemoryRecord,
  ProjectMemoryScope,
  ProjectMemoryStatus,
  PublicAppState,
  PythonRunParams,
  RRunParams,
  RuntimeOverrides,
  SkillRecord,
  TaskRecord,
  UserMemoryRecord,
  UserMemoryStatus,
  VerificationRunRecord,
  WorkSessionRecord,
} from "@/lib/shared/types";
import { maxAttemptsPerTask, maxRepairAttemptsPerSession, maxVerificationRepairsPerSession } from "@/lib/shared/loop-bounds";
import { projectWorkSessionStatus } from "@/lib/shared/ui-projections";
import { buildTimeline, computePhases } from "@/lib/shared/timeline";
import { createActiveHistoryFilter } from "@/lib/shared/history";
import { ThemeToggle } from "@/components/ThemeToggle";
import { PhaseRail } from "@/components/PhaseRail";
import { SelectMenu, type SelectMenuOption } from "@/components/SelectMenu";
import { TimelineStream } from "@/components/TimelineStream";
import { PreviewPane } from "@/components/PreviewPane";
import { MlPreviewPane } from "@/components/ml/MlPreviewPane";
import { ChangedFilesPane } from "@/components/ChangedFilesPane";
import { ReportsPane } from "@/components/ReportsPane";
import { DetailDrawer, type DrawerView } from "@/components/DetailDrawer";
import { logClientProcess } from "@/lib/client/logging";
import { emptyRuntimeOverrides, isRuntimeOverridesEmpty } from "@/lib/shared/runtime-overrides";

interface ControllerResult {
  workSessionId: string;
  chatSessionId: string;
  state: string;
  steps: string[];
}

interface CreateProjectResult {
  project: PublicAppState["projects"][number];
  runtimeProfile: PublicAppState["runtimeProfiles"][number];
  chatSession: PublicAppState["chatSessions"][number];
  workSession: WorkSessionRecord;
}

interface ForkWorkSessionResult {
  projectId: string;
  runtimeProfileId: string;
  chatSessionId: string;
  workSessionId: string;
  forkedFromWorkSessionId: string;
  forkedFromCheckpointId: string | null;
  forkedFromHandoffId: string | null;
  forkedFromPlanId: string | null;
  baselineCheckpointId: string | null;
}

type StateResult = ApiResult<PublicAppState>;
type ControllerApiResult = ApiResult<ControllerResult>;
type CreateProjectApiResult = ApiResult<CreateProjectResult>;
type ForkWorkSessionApiResult = ApiResult<ForkWorkSessionResult>;
type PreviewApiResult = ApiResult<PreviewServerRecord>;
type GithubStatusApiResult = ApiResult<GithubAuthStatus>;
type GithubDeviceStartApiResult = ApiResult<GithubDeviceStartResult>;
type GithubDevicePollApiResult = ApiResult<GithubDevicePollResult>;
type GithubExportPrepareApiResult = ApiResult<GithubExportPrepareResult>;
type GithubExportApiResult = ApiResult<PublicAppState["githubExports"][number]>;
type SkillApiResult = ApiResult<SkillRecord>;

interface ForkWorkSessionOptions {
  checkpointId?: string | null;
  handoffId?: string | null;
  planId?: string | null;
}

interface ForkInProgress {
  sourceWorkSessionId: string;
  checkpointId: string | null;
  handoffId: string | null;
  planId: string | null;
}

interface WorkspaceCandidate {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isWritable: boolean;
  isEmpty: boolean;
  detectedStack: string;
  riskLevel: "none" | "low" | "medium" | "high";
  riskReasons: string[];
  requiresConfirmation: boolean;
}

interface FolderPickerResult {
  canceled: boolean;
  candidate: WorkspaceCandidate | null;
  error: string | null;
  fallbackRequired: boolean;
}

interface WorkspaceSelectionResult {
  candidate: WorkspaceCandidate;
  project: PublicAppState["projects"][number];
  workSession: WorkSessionRecord;
}

interface ImportDialogState {
  source: "local" | "git";
  localPath: string;
  repoUrl: string;
  branch: string;
  busy: boolean;
  error: string | null;
  risk: WorkspaceCandidate | null;
  login: GithubDeviceStartResult | null;
  loginStatus: string | null;
}

interface ImportProjectResultData {
  created: { workSession: WorkSessionRecord } | null;
  requiresConfirmation: boolean;
  candidate: WorkspaceCandidate | null;
}

type ComposerAttachmentKind = "image" | "pdf" | "document" | "spreadsheet" | "presentation";

interface ComposerAttachment {
  id: string;
  file: File;
  kind: ComposerAttachmentKind;
  previewUrl: string | null;
}

type FolderPickerApiResult = ApiResult<FolderPickerResult>;
type WorkspaceCandidateApiResult = ApiResult<{ candidate: WorkspaceCandidate }>;
type WorkspaceSelectionApiResult = ApiResult<WorkspaceSelectionResult>;
type ImportProjectApiResult = ApiResult<ImportProjectResultData>;

interface GithubAccountStatus {
  login: string;
  id: number;
  avatarUrl: string | null;
  htmlUrl: string;
  scopes: string[];
  source: "oauth" | "env";
  updatedAt: string;
}

interface GithubAuthStatus {
  configured: boolean;
  clientId: string | null;
  account: GithubAccountStatus | null;
  requiredConfig: string | null;
}

interface GithubDeviceStartResult {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface GithubDevicePollResult {
  status: "pending" | "slow_down" | "expired" | "complete";
  account?: GithubAccountStatus;
  message?: string;
}

interface GithubExportPrepareResult {
  account: GithubAccountStatus | null;
  defaultOwner: string | null;
  defaultRepoName: string;
  defaultBranch: string;
  sourceMode: "current_workspace" | "checkpoint";
  currentCheckpointId: string | null;
  manifest: {
    root: string;
    files: Array<{ path: string; byteCount: number; executable: boolean }>;
    ignored: Array<{ path: string; reason: string }>;
    fileCount: number;
    byteCount: number;
    hasWorkflowFiles: boolean;
    warnings: string[];
  };
}

type GithubExportDialogState =
  | { kind: "closed" }
  | { kind: "loading" }
  | {
      kind: "ready";
      prepare: GithubExportPrepareResult;
      owner: string;
      repoName: string;
      branch: string;
      visibility: "public" | "private";
      sourceMode: "current_workspace" | "checkpoint";
      updateExisting: boolean;
      replaceContents: boolean;
      login: GithubDeviceStartResult | null;
      loginStatus: string | null;
      exporting: boolean;
    };

const emptyState: PublicAppState = {
  users: [],
  projects: [],
  runtimeProfiles: [],
  chatSessions: [],
  chatMessages: [],
  workSessions: [],
  plans: [],
  tasks: [],
  agentRuns: [],
  checkpoints: [],
  verificationRuns: [],
  approvals: [],
  steeringMessages: [],
  handoffs: [],
  artifacts: [],
  previewServers: [],
  experimentRuns: [],
  githubExports: [],
  playbooks: [],
  skills: [],
  skillActivations: [],
  userMemories: [],
  projectMemories: [],
  commandReceipts: [],
  eventLog: [],
};

interface ChatHistoryItem {
  id: string;
  title: string;
  subtitle: string;
  status: string;
  tone: "neutral" | "success" | "warning" | "danger";
  isWorking: boolean;
  hasUnreadWork: boolean;
  updatedAt: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isStateResult(value: unknown): value is StateResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isControllerApiResult(value: unknown): value is ControllerApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isCreateProjectApiResult(value: unknown): value is CreateProjectApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isImportProjectApiResult(value: unknown): value is ImportProjectApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isForkWorkSessionApiResult(value: unknown): value is ForkWorkSessionApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isPreviewApiResult(value: unknown): value is PreviewApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isGithubStatusApiResult(value: unknown): value is GithubStatusApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isGithubDeviceStartApiResult(value: unknown): value is GithubDeviceStartApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isGithubDevicePollApiResult(value: unknown): value is GithubDevicePollApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isGithubExportPrepareApiResult(value: unknown): value is GithubExportPrepareApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isGithubExportApiResult(value: unknown): value is GithubExportApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isSkillApiResult(value: unknown): value is SkillApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isFolderPickerApiResult(value: unknown): value is FolderPickerApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isWorkspaceCandidateApiResult(value: unknown): value is WorkspaceCandidateApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isWorkspaceSelectionApiResult(value: unknown): value is WorkspaceSelectionApiResult {
  return isObject(value) && typeof value.ok === "boolean";
}

function isEventRecord(value: unknown): value is EventRecord {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.eventName === "string" &&
    typeof value.createdAt === "string"
  );
}

function composerAttachmentKind(file: File): ComposerAttachmentKind | null {
  switch (file.type) {
    case "image/png":
    case "image/jpeg":
    case "image/webp":
      return "image";
    case "application/pdf":
      return "pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "document";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "text/csv":
      return "spreadsheet";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return "presentation";
    default:
      break;
  }
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".webp":
      return "image";
    case ".pdf":
      return "pdf";
    case ".docx":
      return "document";
    case ".xlsx":
    case ".csv":
      return "spreadsheet";
    case ".pptx":
      return "presentation";
    default:
      return null;
  }
}

function composerAttachmentLabel(kind: ComposerAttachmentKind): string {
  switch (kind) {
    case "image":
      return "IMG";
    case "pdf":
      return "PDF";
    case "document":
      return "DOC";
    case "spreadsheet":
      return "XLS";
    case "presentation":
      return "PPT";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function readJson(url: string, init?: RequestInit): Promise<unknown> {
  const startedAt = performance.now();
  logClientProcess("info", "api.request.start", {
    url,
    method: init?.method ?? "GET",
    hasBody: init?.body !== undefined,
  });
  const isFormData = init?.body instanceof FormData;
  const response = await fetch(url, {
    ...init,
    headers: isFormData
      ? init?.headers
      : {
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
  });
  const contentType = response.headers.get("content-type") ?? "";
  const rawBody = await response.text();
  logClientProcess(response.ok ? "info" : "warn", "api.response.received", {
    url,
    method: init?.method ?? "GET",
    status: response.status,
    ok: response.ok,
    contentType,
    bytes: rawBody.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  let body: unknown = null;
  if (rawBody.trim().length > 0 && contentType.toLowerCase().includes("application/json")) {
    try {
      body = JSON.parse(rawBody) as unknown;
    } catch {
      throw new Error(`Request to ${url} returned invalid JSON with HTTP ${response.status}.`);
    }
  } else if (rawBody.trim().length > 0 && !contentType.toLowerCase().includes("application/json")) {
    const preview = rawBody.replace(/\s+/g, " ").trim().slice(0, 120);
    throw new Error(`Request to ${url} returned HTTP ${response.status} with ${contentType || "unknown content type"} instead of JSON. ${preview}`);
  }
  if (!response.ok) {
    if (isObject(body) && typeof body.error === "string") {
      throw new Error(body.error);
    }
    throw new Error(`Request failed with HTTP ${response.status}.`);
  }
  logClientProcess("info", "api.request.completed", {
    url,
    method: init?.method ?? "GET",
    status: response.status,
    elapsedMs: Math.round(performance.now() - startedAt),
  });
  return body;
}

function idempotentPostInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify(body),
  };
}

const RUNTIME_PREFS_KEY = "cdl.runtimePrefs";

interface RuntimePrefs {
  provider: "codex-cli" | "claude-code" | "antigravity-cli" | "ollama";
  overrides: RuntimeOverrides | null;
}

function sanitizeRuntimeOverridesForProvider(provider: RuntimePrefs["provider"], overrides: RuntimeOverrides | null): RuntimeOverrides | null {
  if (overrides === null) {
    return null;
  }
  const sanitized: RuntimeOverrides = {
    ...emptyRuntimeOverrides(),
    model: overrides.model ?? null,
    reasoningEffort: overrides.reasoningEffort ?? null,
    serviceTier: overrides.serviceTier ?? null,
    sandboxMode: overrides.sandboxMode ?? null,
    networkAccess: overrides.networkAccess ?? null,
    codexTransportMode: overrides.codexTransportMode ?? null,
    timeoutMs: overrides.timeoutMs ?? null,
    temperature: overrides.temperature ?? null,
    numCtx: overrides.numCtx ?? null,
    ultracode: overrides.ultracode ?? null,
  };
  if (provider === "ollama") {
    sanitized.reasoningEffort = null;
    sanitized.serviceTier = null;
    sanitized.sandboxMode = null;
    sanitized.networkAccess = null;
    sanitized.codexTransportMode = null;
    sanitized.ultracode = null;
  } else if (provider === "claude-code") {
    sanitized.sandboxMode = null;
    sanitized.networkAccess = null;
    sanitized.codexTransportMode = null;
    sanitized.temperature = null;
    sanitized.numCtx = null;
  } else if (provider === "antigravity-cli") {
    sanitized.reasoningEffort = null;
    sanitized.serviceTier = null;
    sanitized.sandboxMode = null;
    sanitized.networkAccess = null;
    sanitized.codexTransportMode = null;
    sanitized.temperature = null;
    sanitized.numCtx = null;
    sanitized.ultracode = null;
  } else {
    sanitized.temperature = null;
    sanitized.numCtx = null;
    sanitized.ultracode = null;
  }
  return isRuntimeOverridesEmpty(sanitized) ? null : sanitized;
}

function loadRuntimePrefs(): RuntimePrefs | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(RUNTIME_PREFS_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed) || (parsed.provider !== "codex-cli" && parsed.provider !== "claude-code" && parsed.provider !== "antigravity-cli" && parsed.provider !== "ollama")) {
      return null;
    }
    const provider = parsed.provider;
    const overrides = isObject(parsed.overrides)
      ? sanitizeRuntimeOverridesForProvider(provider, parsed.overrides as unknown as RuntimeOverrides)
      : null;
    return { provider, overrides };
  } catch {
    return null;
  }
}

function saveRuntimePrefs(prefs: RuntimePrefs): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const sanitized: RuntimePrefs = {
      provider: prefs.provider,
      overrides: sanitizeRuntimeOverridesForProvider(prefs.provider, prefs.overrides),
    };
    window.localStorage.setItem(RUNTIME_PREFS_KEY, JSON.stringify(sanitized));
  } catch {
  }
}

function latestVerification(items: VerificationRunRecord[]): VerificationRunRecord | null {
  const sorted = [...items].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sorted[0] ?? null;
}

function latestWorkSession(items: WorkSessionRecord[]): WorkSessionRecord | null {
  const sorted = [...items].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return sorted[0] ?? null;
}

function isAutoRunnableState(state: WorkSessionRecord["currentState"]): boolean {
  return state === "planning" || state === "queued" || state === "executing" || state === "verifying";
}

function trimLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function isGenericChatTitle(title: string): boolean {
  return title === "Closed Dev Loop Chat" || /^Project \d+ Chat$/.test(title);
}

function latestPlanForWorkSession(state: PublicAppState, workSessionId: string): PlanRecord | null {
  const sorted = state.plans
    .filter((plan) => plan.workSessionId === workSessionId)
    .sort((a, b) => b.version - a.version);
  return sorted[0] ?? null;
}

function messagesForChatSession(state: PublicAppState, chatSessionId: string): PublicAppState["chatMessages"] {
  return state.chatMessages
    .filter((message) => message.chatSessionId === chatSessionId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function mostRecentTimestamp(...values: Array<string | undefined>): string {
  const timestamps = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((entry) => !Number.isNaN(entry.time))
    .sort((a, b) => b.time - a.time);
  return timestamps[0]?.value ?? new Date(0).toISOString();
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

const unreadWorkStorageKey = "closed-dev-loop-unread-work-sessions";

function readUnreadWorkSessionIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(unreadWorkStorageKey);
    if (raw === null) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string" && value.trim().length > 0));
  } catch {
    return new Set();
  }
}

function writeUnreadWorkSessionIds(ids: Set<string>): void {
  if (ids.size === 0) {
    window.localStorage.removeItem(unreadWorkStorageKey);
    return;
  }
  window.localStorage.setItem(unreadWorkStorageKey, JSON.stringify([...ids]));
}

const previewWidthStorageKey = "cdl.previewWidth";
const MIN_PREVIEW_W = 340;
const MAX_PREVIEW_W = 900;
const DEFAULT_PREVIEW_W = 520;
const CHAT_FLOOR_W = 420;
const RESIZER_OVERHEAD = 20;

function clampPreviewWidth(px: number, max = MAX_PREVIEW_W): number {
  return Math.max(MIN_PREVIEW_W, Math.min(max, px));
}

function readPreviewWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(previewWidthStorageKey);
    if (raw === null) return null;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value)) return null;
    return clampPreviewWidth(value);
  } catch {
    return null;
  }
}

function writePreviewWidth(px: number): void {
  try {
    window.localStorage.setItem(previewWidthStorageKey, String(Math.round(px)));
  } catch {
  }
}

function buildChatHistoryItems(state: PublicAppState, unreadWorkSessionIds: Set<string>): ChatHistoryItem[] {
  return state.workSessions
    .map((session) => {
      const chatSession = state.chatSessions.find((candidate) => candidate.id === session.chatSessionId);
      const project = state.projects.find((candidate) => candidate.id === session.projectId);
      const messages = messagesForChatSession(state, session.chatSessionId);
      const firstUserMessage = messages.find((message) => message.role === "user");
      const inHistory = createActiveHistoryFilter(session, state.checkpoints);
      const activeMessages = messages.filter((message) => inHistory(message.createdAt));
      const latestMessage = activeMessages[activeMessages.length - 1] ?? null;
      const latestPlan = latestPlanForWorkSession(state, session.id);
      const sessionApprovals = approvalsForWorkSession(state, session);
      const projected = projectWorkSessionStatus(session, sessionApprovals);
      const chatTitle = chatSession?.title.trim() ?? "";
      const titleSource =
        chatTitle.length > 0 && !isGenericChatTitle(chatTitle)
          ? chatTitle
          : firstUserMessage?.content ?? latestPlan?.title ?? session.lastUserMessage ?? project?.name ?? "Untitled chat";
      const subtitleSource =
        latestMessage?.content ?? latestPlan?.goal ?? session.lastUserMessage ?? project?.localRepoPath ?? "No messages yet.";

      return {
        id: session.id,
        title: trimLine(titleSource, 54),
        subtitle: trimLine(subtitleSource, 78),
        status: projected.label,
        tone: projected.tone,
        isWorking: isAutoRunnableState(session.currentState),
        hasUnreadWork: unreadWorkSessionIds.has(session.id),
        updatedAt: mostRecentTimestamp(chatSession?.updatedAt, session.updatedAt, latestMessage?.createdAt),
      };
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function getActiveWorkSession(state: PublicAppState, activeWorkSessionId: string | null): WorkSessionRecord | null {
  if (activeWorkSessionId !== null) {
    const selected = state.workSessions.find((session) => session.id === activeWorkSessionId);
    return selected ?? null;
  }
  return latestWorkSession(state.workSessions);
}

function approvalsForWorkSession(state: PublicAppState, workSession: WorkSessionRecord | null): ApprovalRecord[] {
  if (workSession === null) return [];
  return state.approvals
    .filter((approval) => approval.workSessionId === workSession.id)
    .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime());
}

function eventsForWorkSession(state: PublicAppState, workSession: WorkSessionRecord | null): EventRecord[] {
  if (workSession === null) return [];
  return state.eventLog
    .filter((event) => event.workSessionId === workSession.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 200);
}

function artifactsForWorkSession(state: PublicAppState, workSession: WorkSessionRecord | null): ArtifactRecord[] {
  if (workSession === null) return [];
  return state.artifacts
    .filter((artifact) => artifact.workSessionId === workSession.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function previewsForWorkSession(state: PublicAppState, workSession: WorkSessionRecord | null): PreviewServerRecord[] {
  if (workSession === null) return [];
  return state.previewServers
    .filter((preview) => preview.workSessionId === workSession.id)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

function pendingPlanApprovalFor(approvals: ApprovalRecord[]): ApprovalRecord | null {
  return (
    approvals.find((approval) => approval.approvalKind === "plan" && approval.status === "pending") ?? null
  );
}

function pendingSteeringForWorkSession(state: PublicAppState, workSession: WorkSessionRecord | null): PublicAppState["steeringMessages"] {
  if (workSession === null) return [];
  return state.steeringMessages
    .filter((message) => message.workSessionId === workSession.id && message.status === "pending")
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function planIsEditable(state: PublicAppState, plan: PlanRecord, pendingPlanApproval: ApprovalRecord | null): boolean {
  if (plan.status !== "draft") return false;
  if (pendingPlanApproval === null) return false;
  const approvalPlanId = pendingPlanApproval.payload.planId;
  if (typeof approvalPlanId === "string" && approvalPlanId !== plan.id) return false;
  const planTasks = state.tasks.filter((task) => task.planId === plan.id);
  return !planTasks.some((task) => task.status !== "todo");
}

export function ChatApp(): React.ReactElement {
  const [state, setState] = useState<PublicAppState>(emptyState);
  const [activeWorkSessionId, setActiveWorkSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([]);
  const [uploadMenuOpen, setUploadMenuOpen] = useState(false);
  const allUploadAccept = "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp,application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,text/csv,.csv,application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx";
  const [uploadAccept, setUploadAccept] = useState(allUploadAccept);
  const composerAttachmentsRef = useRef<ComposerAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [forkInProgress, setForkInProgress] = useState<ForkInProgress | null>(null);
  const [unreadWorkSessionIds, setUnreadWorkSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadWorkStorageLoaded, setUnreadWorkStorageLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyCollapsed, setHistoryCollapsed] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [drawerView, setDrawerView] = useState<DrawerView>({ kind: "none" });
  const [rightPanel, setRightPanel] = useState<{ kind: "preview" } | { kind: "changed-files"; handoff: HandoffRecord } | { kind: "reports" }>({ kind: "preview" });
  const [workspaceCandidate, setWorkspaceCandidate] = useState<WorkspaceCandidate | null>(null);
  const [importDialog, setImportDialog] = useState<ImportDialogState | null>(null);
  const [githubStatus, setGithubStatus] = useState<GithubAuthStatus | null>(null);
  const [githubDialog, setGithubDialog] = useState<GithubExportDialogState>({ kind: "closed" });
  const refreshTimeoutRef = useRef<number | null>(null);
  const previousWorkingBySessionRef = useRef<Map<string, boolean>>(new Map());
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number>(DEFAULT_PREVIEW_W);
  const [resizingPreview, setResizingPreview] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);

  const workSession = useMemo(() => getActiveWorkSession(state, activeWorkSessionId), [activeWorkSessionId, state]);
  const workSessionId = workSession?.id ?? null;
  const researchMode = workSession?.deliveryKind === "research";
  const isMlSession = workSession?.stackDecision?.stack === "python-ml";
  const effectiveProvider = useMemo<"codex-cli" | "claude-code" | "antigravity-cli" | "ollama">(() => {
    if (workSession === null) return "codex-cli";
    const fromProfile = state.runtimeProfiles.find((profile) => profile.id === workSession.runtimeProfileId)?.provider;
    const resolved = workSession.agentProvider ?? fromProfile ?? "codex-cli";
    return resolved === "ollama" ? "ollama" : resolved === "claude-code" ? "claude-code" : resolved === "antigravity-cli" ? "antigravity-cli" : "codex-cli";
  }, [state.runtimeProfiles, workSession]);
  const runningAgentForSession = useMemo(
    () =>
      workSession === null
        ? null
        : state.agentRuns.find((run) => run.workSessionId === workSession.id && (run.status === "running" || run.status === "waiting_approval")) ?? null,
    [state.agentRuns, workSession],
  );
  const latestCodexTransport = useMemo<"exec" | "app-server" | null>(() => {
    if (workSession === null) return null;
    const latest = state.agentRuns
      .filter((run) => run.workSessionId === workSession.id && run.runtimeKind === "codex" && run.codexTransport != null)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
    return latest?.codexTransport ?? null;
  }, [state.agentRuns, workSession]);
  const steeringMode = workSession !== null && runningAgentForSession !== null && (workSession.currentState === "executing" || workSession.currentState === "queued");
  const previews = useMemo(() => previewsForWorkSession(state, workSession), [state, workSession]);
  const appServable = (workSession?.previewFirstServableAt ?? null) !== null;
  const publishablePreviews = useMemo(
    () => previews.filter((preview) => preview.mode !== "probe" || appServable),
    [previews, appServable],
  );
  const latestPreview = publishablePreviews[0] ?? null;
  const previewPendingFirstServe = latestPreview === null && previews.length > 0;
  const approvals = useMemo(() => approvalsForWorkSession(state, workSession), [state, workSession]);
  const projectedStatus = useMemo(() => projectWorkSessionStatus(workSession, approvals), [approvals, workSession]);
  const events = useMemo(() => eventsForWorkSession(state, workSession), [state, workSession]);
  const artifacts = useMemo(() => artifactsForWorkSession(state, workSession), [state, workSession]);
  const verificationRunsForSession = useMemo(
    () => (workSession === null ? [] : state.verificationRuns.filter((run) => run.workSessionId === workSession.id)),
    [state.verificationRuns, workSession],
  );
  const verification = useMemo(() => latestVerification(verificationRunsForSession), [verificationRunsForSession]);
  const phases = useMemo(() => computePhases(state, workSession), [state, workSession]);
  const timeline = useMemo(() => buildTimeline({ state, workSession }), [state, workSession]);
  const pendingPlanApproval = useMemo(() => pendingPlanApprovalFor(approvals), [approvals]);
  const pendingSteering = useMemo(() => pendingSteeringForWorkSession(state, workSession), [state, workSession]);
  const checkpointsForSession = useMemo(
    () => (workSession === null ? [] : state.checkpoints.filter((checkpoint) => checkpoint.workSessionId === workSession.id)),
    [state.checkpoints, workSession],
  );
  const tasksForSession = useMemo(() => {
    if (workSession === null) return [];
    const planIds = new Set(state.plans.filter((plan) => plan.workSessionId === workSession.id).map((plan) => plan.id));
    return state.tasks.filter((task) => planIds.has(task.planId));
  }, [state.plans, state.tasks, workSession]);
  const loopChip = useMemo(() => deriveLoopChip(workSession, tasksForSession), [workSession, tasksForSession]);
  const executingTask = useMemo(
    () => (runningAgentForSession === null ? null : tasksForSession.find((task) => task.status === "in_progress") ?? null),
    [runningAgentForSession, tasksForSession],
  );
  const currentCheckpoint = useMemo(
    () => workSession?.checkpointRef === null || workSession === null
      ? null
      : checkpointsForSession.find((checkpoint) => checkpoint.id === workSession.checkpointRef) ?? null,
    [checkpointsForSession, workSession],
  );
  const canUndoLast = currentCheckpoint?.previousCheckpointId !== null && currentCheckpoint?.previousCheckpointId !== undefined;
  const canOpenCheckpointHistory = checkpointsForSession.length > 0;
  const githubExportsForSession = useMemo(
    () => (workSession === null ? [] : state.githubExports.filter((record) => record.workSessionId === workSession.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))),
    [state.githubExports, workSession],
  );
  const latestGithubExport = githubExportsForSession[0] ?? null;
  const latestCompletedGithubExport = githubExportsForSession.find((record) => record.status === "completed") ?? null;
  const chatHistoryItems = useMemo(() => buildChatHistoryItems(state, unreadWorkSessionIds), [state, unreadWorkSessionIds]);
  const filteredChatHistoryItems = useMemo(() => {
    const query = historySearch.trim().toLowerCase();
    if (query.length === 0) return chatHistoryItems;
    return chatHistoryItems.filter((item) =>
      `${item.title} ${item.subtitle} ${item.status}`.toLowerCase().includes(query),
    );
  }, [chatHistoryItems, historySearch]);
  const forkingHistoryWorkSessionId =
    forkInProgress !== null && forkInProgress.handoffId === null && forkInProgress.checkpointId === null && forkInProgress.planId === null
      ? forkInProgress.sourceWorkSessionId
      : null;

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    composerAttachmentsRef.current = composerAttachments;
  }, [composerAttachments]);

  useEffect(() => {
    const stored = readUnreadWorkSessionIds();
    setUnreadWorkSessionIds((current) => {
      if (current.size === 0) return stored;
      const next = new Set(current);
      for (const id of stored) {
        next.add(id);
      }
      return next;
    });
    setUnreadWorkStorageLoaded(true);
  }, []);

  useEffect(() => {
    if (!unreadWorkStorageLoaded) return;
    writeUnreadWorkSessionIds(unreadWorkSessionIds);
  }, [unreadWorkSessionIds, unreadWorkStorageLoaded]);

  useEffect(() => {
    return () => {
      for (const attachment of composerAttachmentsRef.current) {
        if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
      }
    };
  }, []);

  const addComposerAttachments = useCallback((files: FileList | File[]) => {
    const accepted = Array.from(files)
      .map((file) => ({ file, kind: composerAttachmentKind(file) }))
      .filter((entry): entry is { file: File; kind: ComposerAttachmentKind } => entry.kind !== null);
    if (accepted.length === 0) {
      setError("Supported uploads: PNG, JPEG, WebP, PDF, DOCX, XLSX, CSV, and PPTX.");
      return;
    }
    setComposerAttachments((current) => {
      const slots = Math.max(0, 8 - current.length);
      const nextFiles = accepted.slice(0, slots);
      if (accepted.length > slots) {
        setError("Attach at most 8 files per message.");
      }
      return [
        ...current,
        ...nextFiles.map(({ file, kind }) => ({
          id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${file.name}`,
          file,
          kind,
          previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
        })),
      ];
    });
  }, []);

  const removeComposerAttachment = useCallback((id: string) => {
    setComposerAttachments((current) => {
      const removed = current.find((attachment) => attachment.id === id);
      if (removed?.previewUrl !== null && removed?.previewUrl !== undefined) {
        URL.revokeObjectURL(removed.previewUrl);
      }
      return current.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const refresh = useCallback(async (): Promise<PublicAppState> => {
    logClientProcess("info", "state.refresh.start", { workSessionId });
    const body = await readJson("/api/app-state", { method: "GET" });
    if (!isStateResult(body) || !body.ok || body.data === undefined) {
      throw new Error("Invalid app-state API response.");
    }
    setState(body.data);
    logClientProcess("info", "state.refresh.completed", {
      workSessionId,
      projects: body.data.projects.length,
      workSessions: body.data.workSessions.length,
      events: body.data.eventLog.length,
      artifacts: body.data.artifacts.length,
      previews: body.data.previewServers.length,
    });
    return body.data;
  }, [workSessionId]);

  const refreshGithubStatus = useCallback(async (): Promise<GithubAuthStatus | null> => {
    const body = await readJson("/api/github/status", { method: "GET" });
    if (!isGithubStatusApiResult(body) || !body.ok || body.data === undefined) {
      throw new Error("Invalid GitHub status API response.");
    }
    setGithubStatus(body.data);
    return body.data;
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimeoutRef.current !== null) {
      window.clearTimeout(refreshTimeoutRef.current);
    }
    logClientProcess("info", "state.refresh.scheduled", { workSessionId, delayMs: 120 });
    refreshTimeoutRef.current = window.setTimeout(() => {
      refreshTimeoutRef.current = null;
      void refresh().catch((refreshError: unknown) => {
        logClientProcess("warn", "state.refresh.failed", {
          workSessionId,
          message: refreshError instanceof Error ? refreshError.message : "unknown refresh error",
        });
      });
    }, 120);
  }, [refresh, workSessionId]);

  useEffect(() => {
    logClientProcess("info", "app.initial_load.start");
    void refresh()
      .then(() => {
        void refreshGithubStatus().catch((statusError: unknown) => {
          logClientProcess("warn", "github.status.failed", {
            message: statusError instanceof Error ? statusError.message : "unknown GitHub status error",
          });
        });
        logClientProcess("info", "app.initial_load.completed");
        focusComposer();
      })
      .catch((refreshError: unknown) => {
        const message = refreshError instanceof Error ? refreshError.message : "Unable to load app state.";
        logClientProcess("error", "app.initial_load.failed", { message });
        setError(message);
      });
  }, [focusComposer, refresh, refreshGithubStatus]);

  useEffect(() => {
    if (!busy && drawerView.kind === "none") {
      focusComposer();
    }
  }, [busy, drawerView.kind, focusComposer, workSessionId]);

  useEffect(() => {
    const stored = window.localStorage.getItem("closed-dev-loop-active-work-session");
    if (stored !== null && stored.trim().length > 0) {
      logClientProcess("info", "state.active_session.restored", { workSessionId: stored });
      setActiveWorkSessionId(stored);
    }
    setHistoryCollapsed(window.localStorage.getItem("closed-dev-loop-history-collapsed") === "true");
    const storedPreviewWidth = readPreviewWidth();
    if (storedPreviewWidth !== null) setPreviewWidth(storedPreviewWidth);
  }, []);

  useEffect(() => {
    if (workSessionId !== null) {
      window.localStorage.setItem("closed-dev-loop-active-work-session", workSessionId);
    } else {
      window.localStorage.removeItem("closed-dev-loop-active-work-session");
    }
  }, [workSessionId]);

  useEffect(() => {
    const nextWorkingBySession = new Map<string, boolean>();
    const completedWhileClosed: string[] = [];

    for (const session of state.workSessions) {
      const isWorking = isAutoRunnableState(session.currentState);
      if (previousWorkingBySessionRef.current.get(session.id) === true && !isWorking && session.id !== workSessionId) {
        completedWhileClosed.push(session.id);
      }
      nextWorkingBySession.set(session.id, isWorking);
    }

    previousWorkingBySessionRef.current = nextWorkingBySession;
    if (completedWhileClosed.length === 0) return;

    setUnreadWorkSessionIds((current) => {
      const next = new Set(current);
      let changed = false;
      for (const id of completedWhileClosed) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [state.workSessions, workSessionId]);

  useEffect(() => {
    const visibleSessionIds = new Set(state.workSessions.map((session) => session.id));
    setUnreadWorkSessionIds((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (id === workSessionId) {
          changed = true;
        } else if (visibleSessionIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [state.workSessions, workSessionId]);

  useEffect(() => {
    if (
      activeWorkSessionId !== null &&
      state.workSessions.length > 0 &&
      !state.workSessions.some((session) => session.id === activeWorkSessionId)
    ) {
      logClientProcess("warn", "state.active_session.missing", { workSessionId: activeWorkSessionId });
      setActiveWorkSessionId(null);
    }
  }, [activeWorkSessionId, state.workSessions]);

  useEffect(() => {
    if (rightPanel.kind !== "changed-files") return;
    if (
      workSession === null ||
      rightPanel.handoff.workSessionId !== workSession.id ||
      !state.handoffs.some((handoff) => handoff.id === rightPanel.handoff.id && handoff.workSessionId === workSession.id)
    ) {
      setRightPanel({ kind: "preview" });
    }
  }, [rightPanel, state.handoffs, workSession]);

  useEffect(() => {
    window.localStorage.setItem("closed-dev-loop-history-collapsed", String(historyCollapsed));
  }, [historyCollapsed]);

  useEffect(() => {
    if (!resizingPreview) return undefined;
    document.body.classList.add("pane-resizing");
    return () => {
      document.body.classList.remove("pane-resizing");
    };
  }, [resizingPreview]);

  const maxPreviewWidth = useCallback((): number => {
    const gridWidth = gridRef.current?.getBoundingClientRect().width ?? 0;
    if (gridWidth <= 0) return MAX_PREVIEW_W;
    return Math.max(MIN_PREVIEW_W, Math.min(MAX_PREVIEW_W, gridWidth - CHAT_FLOOR_W - RESIZER_OVERHEAD));
  }, []);

  const startPreviewResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = previewWidth;
      setResizingPreview(true);
      let latest = startWidth;
      const onMove = (moveEvent: MouseEvent): void => {
        latest = clampPreviewWidth(startWidth - (moveEvent.clientX - startX), maxPreviewWidth());
        setPreviewWidth(latest);
      };
      const onUp = (): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        setResizingPreview(false);
        writePreviewWidth(latest);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [previewWidth, maxPreviewWidth],
  );

  const nudgePreviewResize = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const delta = event.key === "ArrowLeft" ? 16 : event.key === "ArrowRight" ? -16 : 0;
      if (delta === 0) return;
      event.preventDefault();
      setPreviewWidth((current) => {
        const next = clampPreviewWidth(current + delta, maxPreviewWidth());
        writePreviewWidth(next);
        return next;
      });
    },
    [maxPreviewWidth],
  );

  useEffect(() => {
    if (workSessionId === null) return undefined;
    logClientProcess("info", "events.stream.open", { workSessionId });
    const source = new EventSource(`/api/events/stream?workSessionId=${encodeURIComponent(workSessionId)}`);
    source.addEventListener("event", (message) => {
      try {
        const parsed = JSON.parse(message.data) as unknown;
        if (!isEventRecord(parsed)) return;
        logClientProcess("info", "events.stream.event", {
          workSessionId,
          eventId: parsed.id,
          eventName: parsed.eventName,
          priority: parsed.priority,
          aggregateType: parsed.aggregateType,
          aggregateId: parsed.aggregateId,
          context: parsed.context,
          payloadKeys: Object.keys(parsed.payload ?? {}),
          reason: typeof parsed.payload.reason === "string" ? parsed.payload.reason : null,
          message: typeof parsed.payload.message === "string" ? parsed.payload.message : null,
          status: typeof parsed.payload.status === "string" ? parsed.payload.status : null,
        });
        setState((current) => {
          if (current.eventLog.some((event) => event.id === parsed.id)) return current;
          return { ...current, eventLog: [...current.eventLog, parsed] };
        });
        if (parsed.eventName === "github.export.completed") {
          setError(null);
        }
        scheduleRefresh();
      } catch {
        logClientProcess("warn", "events.stream.parse_failed", { workSessionId });
        scheduleRefresh();
      }
    });
    source.onerror = () => {
      logClientProcess("warn", "events.stream.error", { workSessionId });
    };
    return () => {
      logClientProcess("info", "events.stream.close", { workSessionId });
      source.close();
    };
  }, [scheduleRefresh, workSessionId]);

  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current !== null) {
        window.clearTimeout(refreshTimeoutRef.current);
      }
    };
  }, []);

  const submitMessage = useCallback(async () => {
    const content = draft.trim();
    const submitAsSteering = steeringMode;
    if ((content.length === 0 && composerAttachments.length === 0) || (busy && !submitAsSteering)) return;
    if (!submitAsSteering) setBusy(true);
    setError(null);
    logClientProcess("info", "chat.submit.start", {
      workSessionId: workSession?.id ?? null,
      projectId: workSession?.projectId ?? null,
      chars: content.length,
      submitAsSteering,
    });
    try {
      const body = await readJson("/api/chat", {
        method: "POST",
        body: composerAttachments.length > 0
          ? (() => {
              const form = new FormData();
              form.set("content", content);
              if (workSession?.projectId !== undefined) form.set("projectId", workSession.projectId);
              if (workSession?.chatSessionId !== undefined) form.set("chatSessionId", workSession.chatSessionId);
              for (const attachment of composerAttachments) {
                form.append("attachments[]", attachment.file, attachment.file.name);
              }
              return form;
            })()
          : JSON.stringify({
              content,
              projectId: workSession?.projectId,
              chatSessionId: workSession?.chatSessionId,
            }),
      });
      if (!isControllerApiResult(body)) throw new Error("Invalid chat API response.");
      if (!body.ok) throw new Error(body.error ?? "Chat API returned an error.");
      setDraft("");
      setComposerAttachments((current) => {
        for (const attachment of current) {
          if (attachment.previewUrl !== null) URL.revokeObjectURL(attachment.previewUrl);
        }
        return [];
      });
      await refresh();
      focusComposer();
      logClientProcess("info", "chat.submit.completed", {
        workSessionId: workSession?.id ?? null,
        state: body.data?.state ?? null,
        steps: body.data?.steps ?? [],
      });
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Message submission failed.";
      logClientProcess("error", "chat.submit.failed", { workSessionId: workSession?.id ?? null, message });
      setError(message);
    } finally {
      if (!submitAsSteering) setBusy(false);
    }
  }, [busy, composerAttachments, draft, focusComposer, refresh, steeringMode, workSession]);

  const tick = useCallback(async () => {
    if (workSession === null || busy) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "controller.tick.start", { workSessionId: workSession.id, state: workSession.currentState });
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/tick`, idempotentPostInit({ action: "manual-tick" }));
      if (!isControllerApiResult(body)) throw new Error("Invalid tick API response.");
      if (!body.ok) throw new Error(body.error ?? "Tick API returned an error.");
      await refresh();
      logClientProcess("info", "controller.tick.completed", {
        workSessionId: workSession.id,
        state: body.data?.state ?? null,
        steps: body.data?.steps ?? [],
      });
    } catch (tickError) {
      const message = tickError instanceof Error ? tickError.message : "Controller tick failed.";
      logClientProcess("error", "controller.tick.failed", { workSessionId: workSession.id, message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, workSession]);

  const autoTickInFlightRef = useRef(false);
  const runAutoTick = useCallback(async () => {
    if (workSession === null || autoTickInFlightRef.current) return;
    autoTickInFlightRef.current = true;
    logClientProcess("info", "controller.auto_tick.start", { workSessionId: workSession.id, state: workSession.currentState });
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/tick`, idempotentPostInit({ action: "manual-tick" }));
      if (!isControllerApiResult(body)) throw new Error("Invalid tick API response.");
      if (!body.ok) throw new Error(body.error ?? "Tick API returned an error.");
      await refresh();
      logClientProcess("info", "controller.auto_tick.completed", {
        workSessionId: workSession.id,
        state: body.data?.state ?? null,
        steps: body.data?.steps ?? [],
      });
    } catch (tickError) {
      const message = tickError instanceof Error ? tickError.message : "Controller tick failed.";
      logClientProcess("error", "controller.auto_tick.failed", { workSessionId: workSession.id, message });
      setError(message);
    } finally {
      autoTickInFlightRef.current = false;
    }
  }, [refresh, workSession]);

  const hasPendingApproval = useMemo(() => approvals.some((approval) => approval.status === "pending"), [approvals]);

  useEffect(() => {
    if (workSession === null || busy || error !== null || hasPendingApproval || !isAutoRunnableState(workSession.currentState)) {
      return undefined;
    }
    if (workSession.paused || workSession.awaitingStep || workSession.autonomyLevel === "manual") {
      logClientProcess("info", "controller.auto_tick.skipped", {
        workSessionId: workSession.id,
        paused: workSession.paused,
        awaitingStep: workSession.awaitingStep,
        autonomyLevel: workSession.autonomyLevel,
      });
      return undefined;
    }
    logClientProcess("info", "controller.auto_tick.scheduled", {
      workSessionId: workSession.id,
      state: workSession.currentState,
      delayMs: 750,
    });
    const timer = window.setTimeout(() => {
      void runAutoTick();
    }, 750);
    return () => window.clearTimeout(timer);
  }, [busy, error, hasPendingApproval, runAutoTick, workSession]);

  const reloadPreviewAfterRollback = useCallback(
    async (previewWasLive: boolean, context: string): Promise<void> => {
      if (!previewWasLive || workSession === null) return;
      try {
        const previewBody = await readJson(
          `/api/work-sessions/${workSession.id}/preview`,
          idempotentPostInit({ action: "start" }),
        );
        if (!isPreviewApiResult(previewBody) || !previewBody.ok) {
          logClientProcess("warn", "rollback.preview_reload_failed", {
            workSessionId: workSession.id,
            context,
            message: isPreviewApiResult(previewBody) ? previewBody.error ?? "" : "invalid preview response",
          });
        }
        await refresh();
      } catch (previewError) {
        logClientProcess("warn", "rollback.preview_reload_failed", {
          workSessionId: workSession.id,
          context,
          message: previewError instanceof Error ? previewError.message : "preview reload failed",
        });
      }
    },
    [refresh, workSession],
  );

  const previewIsLive = useCallback(
    (): boolean => latestPreview !== null && (latestPreview.status === "ready" || latestPreview.status === "starting"),
    [latestPreview],
  );

  const sendControl = useCallback(
    async (action: "pause" | "resume" | "step" | "abort" | "undo-last" | "apply-steering-now" | "cancel-steering" | "set-autonomy", level?: WorkSessionRecord["autonomyLevel"]) => {
      if (workSession === null) return;
      const isInterrupt = action === "abort" || action === "pause" || action === "apply-steering-now";
      if (busy && !isInterrupt) return;
      if (!isInterrupt) setBusy(true);
      const isRollback = action === "undo-last";
      const previewWasLive = isRollback && previewIsLive();
      if (isRollback) setRestoring(true);
      setError(null);
      logClientProcess("info", "control.action.start", {
        workSessionId: workSession.id,
        action,
        level: level ?? null,
        interrupt: isInterrupt,
      });
      try {
        const body = await readJson(`/api/work-sessions/${workSession.id}/control`, {
          method: "POST",
          body: JSON.stringify(level === undefined ? { action } : { action, level }),
        });
        if (!isObject(body) || body.ok !== true) {
          throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Control action failed.");
        }
        await refresh();
        if (isRollback) {
          await reloadPreviewAfterRollback(previewWasLive, "undo-last");
        }
        logClientProcess("info", "control.action.completed", { workSessionId: workSession.id, action, level: level ?? null });
      } catch (controlError) {
        const message = controlError instanceof Error ? controlError.message : "Control action failed.";
        logClientProcess("error", "control.action.failed", { workSessionId: workSession.id, action, message });
        setError(message);
      } finally {
        if (isRollback) setRestoring(false);
        if (!isInterrupt) setBusy(false);
      }
    },
    [busy, previewIsLive, refresh, reloadPreviewAfterRollback, workSession],
  );

  const setPlanMode = useCallback(
    async (enabled: boolean) => {
      if (workSession === null || busy || pendingPlanApproval !== null) return;
      setBusy(true);
      setError(null);
      logClientProcess("info", "plan_mode.set.start", {
        workSessionId: workSession.id,
        enabled,
      });
      try {
        const body = await readJson(`/api/work-sessions/${workSession.id}/control`, {
          method: "POST",
          body: JSON.stringify({ action: "set-plan-mode", enabled }),
        });
        if (!isObject(body) || body.ok !== true) {
          throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Plan mode update failed.");
        }
        await refresh();
        logClientProcess("info", "plan_mode.set.completed", { workSessionId: workSession.id, enabled });
      } catch (planModeError) {
        const message = planModeError instanceof Error ? planModeError.message : "Plan mode update failed.";
        logClientProcess("error", "plan_mode.set.failed", { workSessionId: workSession.id, enabled, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, pendingPlanApproval, refresh, workSession],
  );

  const saveRuntime = useCallback(
    async (provider: "codex-cli" | "claude-code" | "antigravity-cli" | "ollama", overrides: RuntimeOverrides | null, steeringNote: string) => {
      if (workSession === null || busy) return;
      setBusy(true);
      setError(null);
      logClientProcess("info", "runtime.save.start", {
        workSessionId: workSession.id,
        provider,
        hasOverrides: overrides !== null,
        steeringChars: steeringNote.length,
      });
      try {
        await readJson(`/api/work-sessions/${workSession.id}/control`, {
          method: "POST",
          body: JSON.stringify({ action: "set-provider", provider }),
        });
        await readJson(`/api/work-sessions/${workSession.id}/control`, {
          method: "POST",
          body: JSON.stringify({ action: "set-runtime", runtime: overrides ?? {} }),
        });
        await readJson(`/api/work-sessions/${workSession.id}/control`, {
          method: "POST",
          body: JSON.stringify({ action: "set-steering", note: steeringNote }),
        });
        saveRuntimePrefs({ provider, overrides });
        setDrawerView({ kind: "none" });
        await refresh();
        logClientProcess("info", "runtime.save.completed", { workSessionId: workSession.id });
      } catch (runtimeError) {
        const message = runtimeError instanceof Error ? runtimeError.message : "Saving runtime settings failed.";
        logClientProcess("error", "runtime.save.failed", { workSessionId: workSession.id, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, workSession],
  );

  const openRuntimeDrawer = useCallback(() => {
    if (workSession !== null) {
      logClientProcess("info", "drawer.open", { kind: "runtime", workSessionId: workSession.id });
      setDrawerView({ kind: "runtime", workSession, lastCodexTransport: latestCodexTransport });
    }
  }, [latestCodexTransport, workSession]);

  const refreshSkills = useCallback(async () => {
    logClientProcess("info", "skills.refresh.start", { workSessionId: workSession?.id ?? null });
    const body = await readJson("/api/skills", {
      method: "POST",
      body: JSON.stringify({ workSessionId: workSession?.id ?? null }),
    });
    if (!isObject(body) || body.ok !== true) {
      throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Skill refresh failed.");
    }
    const nextState = await refresh();
    setDrawerView((current) => current.kind === "skills" ? { ...current, skills: nextState.skills } : current);
    logClientProcess("info", "skills.refresh.completed", { workSessionId: workSession?.id ?? null });
  }, [refresh, workSession?.id]);

  const openSkillsDrawer = useCallback(() => {
    logClientProcess("info", "drawer.open", { kind: "skills", workSessionId: workSession?.id ?? null });
    setDrawerView({ kind: "skills", skills: state.skills, workSession });
    void refreshSkills().catch((skillsError) => {
      setError(skillsError instanceof Error ? skillsError.message : "Skill refresh failed.");
    });
  }, [refreshSkills, state.skills, workSession]);

  const refreshMemoryDrawer = useCallback(async (): Promise<void> => {
    if (workSession === null) return;
    const [userBody, projectBody] = await Promise.all([
      readJson("/api/user-memory", { cache: "no-store" }),
      readJson(`/api/work-sessions/${workSession.id}/project-memory`, { cache: "no-store" }),
    ]);
    if (!isObject(userBody) || userBody.ok !== true || !isObject(userBody.data) || !Array.isArray(userBody.data.memories)) {
      throw new Error(isObject(userBody) && typeof userBody.error === "string" ? userBody.error : "User memory refresh failed.");
    }
    if (!isObject(projectBody) || projectBody.ok !== true || !isObject(projectBody.data) || !Array.isArray(projectBody.data.memories)) {
      throw new Error(isObject(projectBody) && typeof projectBody.error === "string" ? projectBody.error : "Project memory refresh failed.");
    }
    const userMemories = userBody.data.memories as UserMemoryRecord[];
    const projectMemories = projectBody.data.memories as ProjectMemoryRecord[];
    setDrawerView((current) => current.kind === "memory" ? { ...current, userMemories, projectMemories } : current);
    await refresh();
  }, [refresh, workSession]);

  const openMemoryDrawer = useCallback(() => {
    if (workSession === null) return;
    logClientProcess("info", "drawer.open", { kind: "memory", workSessionId: workSession.id });
    const initialProjectMemories = state.projectMemories.filter((memory) => memory.projectId === workSession.projectId);
    setDrawerView({ kind: "memory", userMemories: state.userMemories, projectMemories: initialProjectMemories, workSession });
    void refreshMemoryDrawer().catch((memoryError) => {
      setError(memoryError instanceof Error ? memoryError.message : "Project memory load failed.");
    });
  }, [refreshMemoryDrawer, state.projectMemories, state.userMemories, workSession]);

  const createUserMemory = useCallback(async (input: { content: string; status: UserMemoryStatus; pinned: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const body = await readJson("/api/user-memory", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!isObject(body) || body.ok !== true) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "User memory creation failed.");
      }
      await refreshMemoryDrawer();
    } catch (memoryError) {
      const message = memoryError instanceof Error ? memoryError.message : "User memory creation failed.";
      setError(message);
      throw memoryError;
    } finally {
      setBusy(false);
    }
  }, [refreshMemoryDrawer]);

  const updateUserMemory = useCallback(async (memoryId: string, patch: Partial<Pick<UserMemoryRecord, "content" | "status" | "pinned">>) => {
    setBusy(true);
    setError(null);
    try {
      const body = await readJson(`/api/user-memory/${encodeURIComponent(memoryId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!isObject(body) || body.ok !== true) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "User memory update failed.");
      }
      await refreshMemoryDrawer();
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : "User memory update failed.");
    } finally {
      setBusy(false);
    }
  }, [refreshMemoryDrawer]);

  const deleteUserMemory = useCallback(async (memoryId: string) => {
    setBusy(true);
    setError(null);
    try {
      const body = await readJson(`/api/user-memory/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
      if (!isObject(body) || body.ok !== true) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "User memory deletion failed.");
      }
      await refreshMemoryDrawer();
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : "User memory deletion failed.");
    } finally {
      setBusy(false);
    }
  }, [refreshMemoryDrawer]);

  const createProjectMemory = useCallback(async (input: { content: string; category: ProjectMemoryCategory; scope: ProjectMemoryScope; status: ProjectMemoryStatus; pinned: boolean }) => {
    if (workSession === null) return;
    setBusy(true);
    setError(null);
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/project-memory`, {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!isObject(body) || body.ok !== true) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Project memory creation failed.");
      }
      await refreshMemoryDrawer();
    } catch (memoryError) {
      const message = memoryError instanceof Error ? memoryError.message : "Project memory creation failed.";
      setError(message);
      throw memoryError;
    } finally {
      setBusy(false);
    }
  }, [refreshMemoryDrawer, workSession]);

  const updateProjectMemory = useCallback(async (memoryId: string, patch: Partial<Pick<ProjectMemoryRecord, "content" | "category" | "scope" | "status" | "pinned">>) => {
    if (workSession === null) return;
    setBusy(true);
    setError(null);
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/project-memory/${encodeURIComponent(memoryId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!isObject(body) || body.ok !== true) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Project memory update failed.");
      }
      await refreshMemoryDrawer();
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : "Project memory update failed.");
    } finally {
      setBusy(false);
    }
  }, [refreshMemoryDrawer, workSession]);

  const deleteProjectMemory = useCallback(async (memoryId: string) => {
    if (workSession === null) return;
    setBusy(true);
    setError(null);
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/project-memory/${encodeURIComponent(memoryId)}`, { method: "DELETE" });
      if (!isObject(body) || body.ok !== true) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Project memory deletion failed.");
      }
      await refreshMemoryDrawer();
    } catch (memoryError) {
      setError(memoryError instanceof Error ? memoryError.message : "Project memory deletion failed.");
    } finally {
      setBusy(false);
    }
  }, [refreshMemoryDrawer, workSession]);

  const updateSkill = useCallback(async (skillId: string, patch: { enabled?: boolean; allowImplicit?: boolean; trusted?: boolean }) => {
    setBusy(true);
    setError(null);
    logClientProcess("info", "skills.update.start", { skillId, patch });
    try {
      const body = await readJson(`/api/skills/${encodeURIComponent(skillId)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (!isSkillApiResult(body) || !body.ok) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Skill update failed.");
      }
      const nextState = await refresh();
      setDrawerView((current) => current.kind === "skills" ? { ...current, skills: nextState.skills } : current);
      logClientProcess("info", "skills.update.completed", { skillId });
    } catch (skillError) {
      const message = skillError instanceof Error ? skillError.message : "Skill update failed.";
      logClientProcess("error", "skills.update.failed", { skillId, message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const deleteSkill = useCallback(async (skillId: string) => {
    setBusy(true);
    setError(null);
    logClientProcess("info", "skills.delete.start", { skillId });
    try {
      const body = await readJson(`/api/skills/${encodeURIComponent(skillId)}`, {
        method: "DELETE",
      });
      if (!isObject(body) || body.ok !== true) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Skill deletion failed.");
      }
      const nextState = await refresh();
      setDrawerView((current) => current.kind === "skills" ? { ...current, skills: nextState.skills } : current);
      logClientProcess("info", "skills.delete.completed", { skillId });
    } catch (skillError) {
      const message = skillError instanceof Error ? skillError.message : "Skill deletion failed.";
      logClientProcess("error", "skills.delete.failed", { skillId, message });
      setError(message);
      throw skillError;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const createSkill = useCallback(async (input: { name: string; description: string; body: string; allowImplicit: boolean }) => {
    setBusy(true);
    setError(null);
    logClientProcess("info", "skills.create.start", { name: input.name });
    try {
      const body = await readJson("/api/skills", {
        method: "POST",
        body: JSON.stringify({ action: "create", ...input }),
      });
      if (!isObject(body) || body.ok !== true) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Skill creation failed.");
      }
      const nextState = await refresh();
      setDrawerView((current) => current.kind === "skills" ? { ...current, skills: nextState.skills } : current);
      logClientProcess("info", "skills.create.completed", { name: input.name });
    } catch (skillError) {
      const message = skillError instanceof Error ? skillError.message : "Skill creation failed.";
      logClientProcess("error", "skills.create.failed", { name: input.name, message });
      setError(message);
      throw skillError;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const importSkillFiles = useCallback(async (files: FileList | File[]) => {
    const selected = Array.from(files);
    if (selected.length === 0) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "skills.import_files.start", { fileCount: selected.length });
    try {
      const form = new FormData();
      for (const file of selected) {
        form.append("files[]", file, file.name);
      }
      const body = await readJson("/api/skills", {
        method: "POST",
        body: form,
      });
      if (!isObject(body) || body.ok !== true) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Skill import failed.");
      }
      const nextState = await refresh();
      setDrawerView((current) => current.kind === "skills" ? { ...current, skills: nextState.skills } : current);
      logClientProcess("info", "skills.import_files.completed", { fileCount: selected.length });
    } catch (skillError) {
      const message = skillError instanceof Error ? skillError.message : "Skill import failed.";
      logClientProcess("error", "skills.import_files.failed", { fileCount: selected.length, message });
      setError(message);
      throw skillError;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const startNativeReview = useCallback(async () => {
    if (workSession === null || busy) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "codex_review.start", { workSessionId: workSession.id });
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/codex-review`, {
        method: "POST",
        body: JSON.stringify({ target: "uncommittedChanges", delivery: "detached" }),
      });
      if (!isObject(body) || body.ok !== true) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Native Codex review failed.");
      }
      await refresh();
      logClientProcess("info", "codex_review.completed", { workSessionId: workSession.id });
    } catch (reviewError) {
      const message = reviewError instanceof Error ? reviewError.message : "Native Codex review failed.";
      logClientProcess("error", "codex_review.failed", { workSessionId: workSession.id, message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, workSession]);

  const setProvider = useCallback(
    async (provider: "codex-cli" | "claude-code" | "antigravity-cli" | "ollama") => {
      if (workSession === null || busy) return;
      setBusy(true);
      setError(null);
      logClientProcess("info", "provider.set.start", { workSessionId: workSession.id, provider });
      try {
        await readJson(`/api/work-sessions/${workSession.id}/control`, {
          method: "POST",
          body: JSON.stringify({ action: "set-provider", provider }),
        });
        const existing = loadRuntimePrefs();
        const carriedOverrides = existing?.overrides ?? null;
        const nextOverrides = carriedOverrides === null ? null : { ...carriedOverrides, model: null, reasoningEffort: null, serviceTier: null };
        saveRuntimePrefs({ provider, overrides: nextOverrides });
        await refresh();
        logClientProcess("info", "provider.set.completed", { workSessionId: workSession.id, provider });
      } catch (providerError) {
        const message = providerError instanceof Error ? providerError.message : "Setting provider failed.";
        logClientProcess("error", "provider.set.failed", { workSessionId: workSession.id, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, workSession],
  );

  const seededSessionsRef = useRef<Set<string>>(new Set());

  const applyRuntimePrefsToSession = useCallback(
    async (sessionId: string, prefs: RuntimePrefs) => {
      try {
        await readJson(`/api/work-sessions/${sessionId}/control`, {
          method: "POST",
          body: JSON.stringify({ action: "set-provider", provider: prefs.provider }),
        });
        if (prefs.overrides !== null) {
          await readJson(`/api/work-sessions/${sessionId}/control`, {
            method: "POST",
            body: JSON.stringify({ action: "set-runtime", runtime: prefs.overrides }),
          });
        }
        await refresh();
        logClientProcess("info", "runtime.prefs.seeded", { workSessionId: sessionId, provider: prefs.provider });
      } catch (seedError) {
        logClientProcess("error", "runtime.prefs.seed_failed", {
          workSessionId: sessionId,
          message: seedError instanceof Error ? seedError.message : "Seeding runtime prefs failed.",
        });
      }
    },
    [refresh],
  );

  useEffect(() => {
    if (workSession === null || workSession.currentState !== "intake") {
      return;
    }
    if (workSession.agentProvider !== null || workSession.runtimeOverrides !== null) {
      return;
    }
    if (seededSessionsRef.current.has(workSession.id)) {
      return;
    }
    const prefs = loadRuntimePrefs();
    if (prefs === null) {
      return;
    }
    seededSessionsRef.current.add(workSession.id);
    void applyRuntimePrefsToSession(workSession.id, prefs);
  }, [workSession, applyRuntimePrefsToSession]);

  const resolveApproval = useCallback(
    async (approvalId: string, status: "approved" | "rejected") => {
      setBusy(true);
      setError(null);
      logClientProcess("info", "approval.resolve.start", { approvalId, status });
      try {
        const body = await readJson(`/api/approvals/${approvalId}`, {
          method: "POST",
          body: JSON.stringify({ status }),
        });
        if (!isControllerApiResult(body)) throw new Error("Invalid approval API response.");
        if (!body.ok) throw new Error(body.error ?? "Approval API returned an error.");
        await refresh();
        logClientProcess("info", "approval.resolve.completed", { approvalId, status, state: body.data?.state ?? null });
      } catch (approvalError) {
        const message = approvalError instanceof Error ? approvalError.message : "Approval update failed.";
        logClientProcess("error", "approval.resolve.failed", { approvalId, status, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const resetDemo = useCallback(async () => {
    if (busy) return;
    const confirmation = window.prompt(
      'This deletes the local database, including all sidebar projects and chat history. Type "delete database" to continue.',
    );
    if (confirmation !== "delete database") {
      logClientProcess("info", "demo.reset.canceled");
      setError("Reset canceled. The database was not changed.");
      focusComposer();
      return;
    }
    setBusy(true);
    setError(null);
    logClientProcess("warn", "demo.reset.start");
    try {
      await readJson("/api/demo/reset", {
        method: "POST",
        body: JSON.stringify({ confirmation }),
      });
      await refresh();
      focusComposer();
      logClientProcess("warn", "demo.reset.completed");
    } catch (resetError) {
      const message = resetError instanceof Error ? resetError.message : "Reset failed.";
      logClientProcess("error", "demo.reset.failed", { message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, focusComposer, refresh]);

  const createNewProject = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "project.create.start");
    try {
      const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
      const slug = `project-${stamp}`;
      const body = await readJson("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: `Project ${stamp}`, slug }),
      });
      if (!isCreateProjectApiResult(body)) throw new Error("Invalid project API response.");
      if (!body.ok || body.data === undefined) throw new Error(body.error ?? "Project API returned an error.");
      setDraft("");
      const nextState = await refresh();
      if (!nextState.workSessions.some((session) => session.id === body.data?.workSession.id)) {
        throw new Error("Project was created, but the new work session was not found in refreshed app state.");
      }
      setActiveWorkSessionId(body.data.workSession.id);
      focusComposer();
      logClientProcess("info", "project.create.completed", {
        projectId: body.data.project.id,
        workSessionId: body.data.workSession.id,
        slug,
      });
    } catch (projectError) {
      const message = projectError instanceof Error ? projectError.message : "New project creation failed.";
      logClientProcess("error", "project.create.failed", { message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, focusComposer, refresh]);

  const applyWorkspaceCandidate = useCallback(
    async (candidate: WorkspaceCandidate, confirmedRisk: boolean) => {
      if (workSession === null) return;
      setBusy(true);
      setError(null);
      logClientProcess("info", "workspace.select.start", {
        workSessionId: workSession.id,
        path: candidate.path,
        riskLevel: candidate.riskLevel,
        confirmedRisk,
      });
      try {
        const body = await readJson("/api/workspace/select-folder", {
          method: "POST",
          body: JSON.stringify({
            workSessionId: workSession.id,
            path: candidate.path,
            confirmedRisk,
          }),
        });
        if (!isWorkspaceSelectionApiResult(body)) throw new Error("Invalid workspace selection API response.");
        if (!body.ok || body.data === undefined) throw new Error(body.error ?? "Workspace selection failed.");
        setWorkspaceCandidate(null);
        setActiveWorkSessionId(body.data.workSession.id);
        await refresh();
        focusComposer();
        logClientProcess("info", "workspace.select.completed", {
          workSessionId: body.data.workSession.id,
          path: body.data.candidate.path,
        });
      } catch (selectionError) {
        const message = selectionError instanceof Error ? selectionError.message : "Workspace selection failed.";
        logClientProcess("error", "workspace.select.failed", { workSessionId: workSession.id, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [focusComposer, refresh, workSession],
  );

  const handleWorkspaceCandidate = useCallback(
    async (candidate: WorkspaceCandidate) => {
      if (candidate.requiresConfirmation) {
        setWorkspaceCandidate(candidate);
        return;
      }
      await applyWorkspaceCandidate(candidate, false);
    },
    [applyWorkspaceCandidate],
  );

  const openWorkspace = useCallback(async () => {
    if (busy || workSession === null) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "workspace.open_folder.start", { workSessionId: workSession.id });
    try {
      const body = await readJson("/api/workspace/open-folder", { method: "POST" });
      if (!isFolderPickerApiResult(body)) throw new Error("Invalid workspace picker API response.");
      if (!body.ok || body.data === undefined) throw new Error(body.error ?? "Workspace picker failed.");
      if (body.data.canceled) {
        logClientProcess("info", "workspace.open_folder.canceled", { workSessionId: workSession.id });
        return;
      }
      if (body.data.candidate !== null) {
        await handleWorkspaceCandidate(body.data.candidate);
        return;
      }
      const manual = window.prompt(body.data.error ?? "Native folder picker is unavailable. Enter an absolute workspace path:");
      if (manual === null || manual.trim().length === 0) {
        return;
      }
      const inspected = await readJson("/api/workspace/select-folder", {
        method: "PUT",
        body: JSON.stringify({ path: manual }),
      });
      if (!isWorkspaceCandidateApiResult(inspected)) throw new Error("Invalid workspace inspection API response.");
      if (!inspected.ok || inspected.data === undefined) throw new Error(inspected.error ?? "Workspace inspection failed.");
      await handleWorkspaceCandidate(inspected.data.candidate);
    } catch (workspaceError) {
      const message = workspaceError instanceof Error ? workspaceError.message : "Open workspace failed.";
      logClientProcess("error", "workspace.open_folder.failed", { workSessionId: workSession.id, message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, handleWorkspaceCandidate, workSession]);

  const openImportDialog = useCallback(() => {
    if (busy) return;
    setError(null);
    void refreshGithubStatus().catch(() => undefined);
    setImportDialog({ source: "local", localPath: "", repoUrl: "", branch: "", busy: false, error: null, risk: null, login: null, loginStatus: null });
  }, [busy, refreshGithubStatus]);

  const browseImportFolder = useCallback(async () => {
    setImportDialog((current) => (current === null ? current : { ...current, busy: true, error: null }));
    try {
      const body = await readJson("/api/workspace/open-folder", { method: "POST" });
      if (!isFolderPickerApiResult(body)) throw new Error("Invalid workspace picker API response.");
      if (!body.ok || body.data === undefined) throw new Error(body.error ?? "Workspace picker failed.");
      if (body.data.canceled) {
        setImportDialog((current) => (current === null ? current : { ...current, busy: false }));
        return;
      }
      if (body.data.candidate !== null) {
        const pickedPath = body.data.candidate.path;
        setImportDialog((current) => (current === null ? current : { ...current, busy: false, localPath: pickedPath, risk: null }));
        return;
      }
      const manual = window.prompt(body.data.error ?? "Native folder picker is unavailable. Enter an absolute folder path:");
      const trimmed = manual === null ? "" : manual.trim();
      setImportDialog((current) => (current === null ? current : { ...current, busy: false, localPath: trimmed.length > 0 ? trimmed : current.localPath, risk: null }));
    } catch (pickError) {
      const message = pickError instanceof Error ? pickError.message : "Folder picker failed.";
      setImportDialog((current) => (current === null ? current : { ...current, busy: false, error: message }));
    }
  }, []);

  const submitImport = useCallback(async (confirmedRisk: boolean) => {
    if (importDialog === null) return;
    let payload: Record<string, unknown>;
    if (importDialog.source === "local") {
      if (importDialog.localPath.trim().length === 0) {
        setImportDialog((current) => (current === null ? current : { ...current, error: "Choose a folder to import." }));
        return;
      }
      payload = { source: "local", localPath: importDialog.localPath.trim(), confirmedRisk };
    } else {
      if (importDialog.repoUrl.trim().length === 0) {
        setImportDialog((current) => (current === null ? current : { ...current, error: "Enter a repository URL." }));
        return;
      }
      payload = { source: "git", repoUrl: importDialog.repoUrl.trim() };
      if (importDialog.branch.trim().length > 0) {
        payload.branch = importDialog.branch.trim();
      }
    }
    setImportDialog((current) => (current === null ? current : { ...current, busy: true, error: null }));
    try {
      const body = await readJson("/api/projects/import", { method: "POST", body: JSON.stringify(payload) });
      if (!isImportProjectApiResult(body)) throw new Error("Invalid import API response.");
      if (!body.ok || body.data === undefined) throw new Error(body.error ?? "Project import failed.");
      if (body.data.requiresConfirmation && body.data.candidate !== null) {
        const candidate = body.data.candidate;
        setImportDialog((current) => (current === null ? current : { ...current, busy: false, risk: candidate }));
        return;
      }
      if (body.data.created === null) {
        throw new Error("Import did not return a project.");
      }
      const newWorkSessionId = body.data.created.workSession.id;
      setImportDialog(null);
      const nextState = await refresh();
      if (nextState.workSessions.some((session) => session.id === newWorkSessionId)) {
        setActiveWorkSessionId(newWorkSessionId);
      }
      focusComposer();
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : "Project import failed.";
      setImportDialog((current) => (current === null ? current : { ...current, busy: false, error: message }));
    }
  }, [importDialog, refresh, focusComposer]);

  const startImportGithubLogin = useCallback(async () => {
    setImportDialog((current) => (current === null ? current : { ...current, loginStatus: "Starting GitHub login…" }));
    try {
      const body = await readJson("/api/github/auth/device/start", {
        method: "POST",
        body: JSON.stringify({ scopes: ["repo", "workflow"] }),
      });
      if (!isGithubDeviceStartApiResult(body) || !body.ok || body.data === undefined) {
        throw new Error("Invalid GitHub login API response.");
      }
      const login = body.data;
      setImportDialog((current) => (current === null ? current : {
        ...current,
        login,
        loginStatus: `Enter code ${login.user_code} at GitHub, then wait for this dialog to connect.`,
      }));
      window.open(login.verification_uri, "_blank", "noopener,noreferrer");
    } catch (loginError) {
      const message = loginError instanceof Error ? loginError.message : "Unable to start GitHub login.";
      setImportDialog((current) => (current === null ? current : { ...current, loginStatus: message }));
    }
  }, []);

  const importLoginDeviceCode = importDialog?.login?.device_code ?? null;
  const importLoginInterval = importDialog?.login?.interval ?? null;
  useEffect(() => {
    if (importLoginDeviceCode === null) {
      return undefined;
    }
    let canceled = false;
    let intervalMs = Math.max(5, importLoginInterval ?? 5) * 1000;
    const poll = async (): Promise<void> => {
      try {
        const body = await readJson("/api/github/auth/device/poll", {
          method: "POST",
          body: JSON.stringify({ deviceCode: importLoginDeviceCode }),
        });
        if (!isGithubDevicePollApiResult(body) || !body.ok || body.data === undefined) {
          throw new Error("Invalid GitHub login poll response.");
        }
        const result = body.data;
        if (result.status === "complete") {
          await refreshGithubStatus().catch(() => null);
          setImportDialog((current) => (current === null ? current : { ...current, login: null, loginStatus: `Connected as ${result.account?.login ?? "GitHub user"}.` }));
          return;
        }
        if (result.status === "expired") {
          setImportDialog((current) => (current === null ? current : { ...current, login: null, loginStatus: result.message ?? "GitHub login expired." }));
          return;
        }
        if (result.status === "slow_down") {
          intervalMs += 5000;
        }
        if (!canceled) {
          window.setTimeout(() => void poll(), intervalMs);
        }
      } catch (pollError) {
        const message = pollError instanceof Error ? pollError.message : "GitHub login polling failed.";
        setImportDialog((current) => (current === null ? current : { ...current, loginStatus: message }));
      }
    };
    const timer = window.setTimeout(() => void poll(), intervalMs);
    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [importLoginDeviceCode, importLoginInterval, refreshGithubStatus]);

  const selectWorkSession = useCallback((workSessionIdToSelect: string) => {
    logClientProcess("info", "state.active_session.selected", { workSessionId: workSessionIdToSelect });
    setActiveWorkSessionId(workSessionIdToSelect);
    setDrawerView({ kind: "none" });
    setError(null);
    focusComposer();
  }, [focusComposer]);

  const renameWorkSession = useCallback(
    async (item: ChatHistoryItem) => {
      if (busy) return;
      const title = window.prompt("Rename chat", item.title);
      if (title === null) {
        focusComposer();
        return;
      }
      const trimmedTitle = title.replace(/\s+/g, " ").trim();
      if (trimmedTitle.length === 0 || trimmedTitle === item.title) {
        focusComposer();
        return;
      }
      setBusy(true);
      setError(null);
      logClientProcess("info", "chat.rename.start", { workSessionId: item.id });
      try {
        await readJson(`/api/work-sessions/${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ title: trimmedTitle }),
        });
        await refresh();
        logClientProcess("info", "chat.rename.completed", { workSessionId: item.id });
      } catch (renameError) {
        const message = renameError instanceof Error ? renameError.message : "Rename failed.";
        logClientProcess("error", "chat.rename.failed", { workSessionId: item.id, message });
        setError(message);
      } finally {
        setBusy(false);
        focusComposer();
      }
    },
    [busy, focusComposer, refresh],
  );

  const deleteWorkSession = useCallback(
    async (item: ChatHistoryItem) => {
      if (busy) return;
      const confirmed = window.confirm(
        `Delete "${item.title}" from the sidebar?\n\nThis removes the saved chat record and history from the local database. The workspace folder is not deleted.`,
      );
      if (!confirmed) {
        focusComposer();
        return;
      }
      setBusy(true);
      setError(null);
      logClientProcess("warn", "chat.delete.start", { workSessionId: item.id });
      try {
        await readJson(`/api/work-sessions/${encodeURIComponent(item.id)}`, { method: "DELETE" });
        if (item.id === workSessionId) {
          setActiveWorkSessionId(null);
        }
        await refresh();
        logClientProcess("warn", "chat.delete.completed", { workSessionId: item.id });
      } catch (deleteError) {
        const message = deleteError instanceof Error ? deleteError.message : "Delete failed.";
        logClientProcess("error", "chat.delete.failed", { workSessionId: item.id, message });
        setError(message);
      } finally {
        setBusy(false);
        focusComposer();
      }
    },
    [busy, focusComposer, refresh, workSessionId],
  );

  const forkWorkSession = useCallback(
    async (sourceWorkSessionId: string, options: ForkWorkSessionOptions = {}) => {
      if (busy) return;
      const checkpointId = options.checkpointId ?? null;
      const handoffId = options.handoffId ?? null;
      const planId = options.planId ?? null;
      setBusy(true);
      setForkInProgress({ sourceWorkSessionId, checkpointId, handoffId, planId });
      setError(null);
      logClientProcess("info", "chat.fork.start", { workSessionId: sourceWorkSessionId, checkpointId, handoffId, planId });
      try {
        const body = await readJson(`/api/work-sessions/${encodeURIComponent(sourceWorkSessionId)}/fork`, {
          method: "POST",
          body: JSON.stringify({ checkpointId, handoffId, planId }),
        });
        if (!isForkWorkSessionApiResult(body) || !body.ok || body.data === undefined) {
          throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Fork failed.");
        }
        setDrawerView({ kind: "none" });
        const nextState = await refresh();
        if (!nextState.workSessions.some((session) => session.id === body.data?.workSessionId)) {
          throw new Error("Fork was created, but the forked session was not found in refreshed app state.");
        }
        setActiveWorkSessionId(body.data.workSessionId);
        focusComposer();
        logClientProcess("info", "chat.fork.completed", {
          sourceWorkSessionId,
          checkpointId,
          handoffId,
          planId,
          forkedWorkSessionId: body.data.workSessionId,
          baselineCheckpointId: body.data.baselineCheckpointId,
        });
      } catch (forkError) {
        const message = forkError instanceof Error ? forkError.message : "Fork failed.";
        logClientProcess("error", "chat.fork.failed", { workSessionId: sourceWorkSessionId, checkpointId, handoffId, planId, message });
        setError(message);
      } finally {
        setForkInProgress(null);
        setBusy(false);
      }
    },
    [busy, focusComposer, refresh],
  );

  const startPreview = useCallback(async () => {
    if (workSession === null || busy) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "preview.start.start", { workSessionId: workSession.id, currentPreviewId: latestPreview?.id ?? null });
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/preview`, idempotentPostInit({ action: "start" }));
      if (!isPreviewApiResult(body)) throw new Error("Invalid preview API response.");
      if (!body.ok || body.data === undefined) throw new Error(body.error ?? "Preview API returned an error.");
      await refresh();
      logClientProcess("info", "preview.start.completed", {
        workSessionId: workSession.id,
        previewId: body.data.id,
        status: body.data.status,
        url: body.data.url,
      });
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "Preview start failed.";
      logClientProcess("error", "preview.start.failed", { workSessionId: workSession.id, message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, latestPreview?.id, refresh, workSession]);

  const hardRestartPreview = useCallback(async () => {
    if (workSession === null || busy) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "preview.hard_restart.start", { workSessionId: workSession.id, currentPreviewId: latestPreview?.id ?? null });
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/preview`, idempotentPostInit({ action: "restart" }));
      if (!isPreviewApiResult(body)) throw new Error("Invalid preview API response.");
      if (!body.ok || body.data === undefined) throw new Error(body.error ?? "Preview API returned an error.");
      await refresh();
      logClientProcess("info", "preview.hard_restart.completed", {
        workSessionId: workSession.id,
        previewId: body.data.id,
        status: body.data.status,
        url: body.data.url,
      });
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "Preview hard restart failed.";
      logClientProcess("error", "preview.hard_restart.failed", { workSessionId: workSession.id, message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, latestPreview?.id, refresh, workSession]);

  const repairCurrentPreview = useCallback(async () => {
    if (workSession === null || latestPreview === null || busy) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "preview.repair.start", { workSessionId: workSession.id, previewId: latestPreview.id, status: latestPreview.status });
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/preview`, idempotentPostInit({ action: "repair", previewId: latestPreview.id }));
      if (!isControllerApiResult(body) || !body.ok) {
        throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Preview repair failed.");
      }
      await refresh();
      logClientProcess("info", "preview.repair.completed", {
        workSessionId: workSession.id,
        previewId: latestPreview.id,
        state: body.data?.state ?? null,
      });
    } catch (repairError) {
      const message = repairError instanceof Error ? repairError.message : "Preview repair failed.";
      logClientProcess("error", "preview.repair.failed", { workSessionId: workSession.id, previewId: latestPreview.id, message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, latestPreview, refresh, workSession]);

  const runPythonPreview = useCallback(
    async (paramsInput: PythonRunParams | RRunParams) => {
      if (workSession === null || busy) return;
      setBusy(true);
      setError(null);
      logClientProcess("info", "preview.python_run.start", {
        workSessionId: workSession.id,
        entrypoint: paramsInput.entrypoint,
        argvCount: paramsInput.argv.length,
        stdinChars: paramsInput.stdin.length,
        envKeyCount: Object.keys(paramsInput.env).length,
        graphics: "matplotlib" in paramsInput ? paramsInput.matplotlib : paramsInput.graphics,
      });
      try {
        const body = await readJson(`/api/work-sessions/${workSession.id}/preview`, idempotentPostInit({ action: "restart", runParams: paramsInput }));
        if (!isPreviewApiResult(body)) throw new Error("Invalid preview API response.");
        if (!body.ok || body.data === undefined) throw new Error(body.error ?? "Preview API returned an error.");
        await refresh();
        logClientProcess("info", "preview.python_run.completed", {
          workSessionId: workSession.id,
          previewId: body.data.id,
          status: body.data.status,
        });
      } catch (runError) {
        const message = runError instanceof Error ? runError.message : "Python run failed.";
        logClientProcess("error", "preview.python_run.failed", { workSessionId: workSession.id, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, workSession],
  );

  const stopCurrentPreview = useCallback(async () => {
    if (workSession === null || latestPreview === null || busy) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "preview.stop.start", { workSessionId: workSession.id, previewId: latestPreview.id });
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/preview`, idempotentPostInit({ action: "stop", previewId: latestPreview.id }));
      if (!isPreviewApiResult(body)) throw new Error("Invalid preview API response.");
      if (!body.ok) throw new Error(body.error ?? "Preview API returned an error.");
      await refresh();
      logClientProcess("info", "preview.stop.completed", { workSessionId: workSession.id, previewId: latestPreview.id });
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "Preview stop failed.";
      logClientProcess("error", "preview.stop.failed", { workSessionId: workSession.id, previewId: latestPreview.id, message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, latestPreview, refresh, workSession]);

  const openCurrentPreview = useCallback(async () => {
    if (workSession === null || busy) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "preview.open.start", {
      workSessionId: workSession.id,
      currentPreviewId: latestPreview?.id ?? null,
      currentPreviewStatus: latestPreview?.status ?? null,
    });
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/preview`, idempotentPostInit({ action: "open" }));
      if (!isPreviewApiResult(body)) throw new Error("Invalid preview API response.");
      if (!body.ok || body.data === undefined) throw new Error(body.error ?? "Preview API returned an error.");
      await refresh();
      if (body.data.status !== "ready" || body.data.url.trim().length === 0) {
        throw new Error(`Preview is not ready to open. Current status: ${body.data.status}.`);
      }
      logClientProcess("info", "preview.open.completed", {
        workSessionId: body.data.workSessionId,
        previewId: body.data.id,
        url: body.data.url,
      });
      window.open(body.data.url, "_blank", "noopener,noreferrer");
    } catch (previewError) {
      const message = previewError instanceof Error ? previewError.message : "Preview open failed.";
      logClientProcess("error", "preview.open.failed", { workSessionId: workSession.id, message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, latestPreview?.id, latestPreview?.status, refresh, workSession]);

  const createHandoff = useCallback(async () => {
    if (workSession === null || busy) return;
    setBusy(true);
    setError(null);
    logClientProcess("info", "handoff.create.start", { workSessionId: workSession.id });
    try {
      const body = await readJson(`/api/work-sessions/${workSession.id}/handoff`, { method: "POST" });
      if (!isControllerApiResult(body)) throw new Error("Invalid handoff API response.");
      if (!body.ok) throw new Error(body.error ?? "Handoff API returned an error.");
      await refresh();
      logClientProcess("info", "handoff.create.completed", { workSessionId: workSession.id, state: body.data?.state ?? null });
    } catch (handoffError) {
      const message = handoffError instanceof Error ? handoffError.message : "Handoff failed.";
      logClientProcess("error", "handoff.create.failed", { workSessionId: workSession.id, message });
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [busy, refresh, workSession]);

  const openPlanDetail = useCallback(
    (plan: PlanRecord) => {
      logClientProcess("info", "drawer.open", { kind: "plan", planId: plan.id, mode: "view" });
      setDrawerView({ kind: "plan", plan, canEdit: planIsEditable(state, plan, pendingPlanApproval), mode: "view" });
    },
    [state, pendingPlanApproval],
  );
  const editPlan = useCallback(
    (plan: PlanRecord) => {
      logClientProcess("info", "drawer.open", { kind: "plan", planId: plan.id, mode: "edit" });
      setDrawerView({ kind: "plan", plan, canEdit: planIsEditable(state, plan, pendingPlanApproval), mode: "edit" });
    },
    [state, pendingPlanApproval],
  );
  const savePlanAndRun = useCallback(
    async (planId: string, planJson: PlanJson) => {
      if (workSession === null || busy) return;
      setBusy(true);
      setError(null);
      logClientProcess("info", "plan.save.start", {
        workSessionId: workSession.id,
        planId,
        taskCount: planJson.tasks.length,
        verificationCommandCount: planJson.verificationCommands.length,
      });
      try {
        const body = await readJson(`/api/work-sessions/${workSession.id}/plan`, {
          method: "POST",
          body: JSON.stringify({ planId, planJson }),
        });
        if (!isControllerApiResult(body)) throw new Error("Invalid plan edit API response.");
        if (!body.ok) throw new Error(body.error ?? "Plan edit API returned an error.");
        setDrawerView({ kind: "none" });
        await refresh();
        logClientProcess("info", "plan.save.completed", { workSessionId: workSession.id, planId, state: body.data?.state ?? null });
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : "Saving the edited plan failed.";
        logClientProcess("error", "plan.save.failed", { workSessionId: workSession.id, planId, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, workSession],
  );
  const setPlanStackAction = useCallback(
    async (planId: string, stack: string) => {
      if (workSession === null || busy) return;
      setBusy(true);
      setError(null);
      logClientProcess("info", "plan.stack.set.start", { workSessionId: workSession.id, planId, stack });
      try {
        const body = await readJson(`/api/work-sessions/${workSession.id}/plan`, {
          method: "POST",
          body: JSON.stringify({ planId, action: "set-stack", stack }),
        });
        if (!isObject(body) || body.ok !== true) {
          throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Changing the stack failed.");
        }
        await refresh();
        logClientProcess("info", "plan.stack.set.completed", { workSessionId: workSession.id, planId, stack });
      } catch (stackError) {
        const message = stackError instanceof Error ? stackError.message : "Changing the stack failed.";
        logClientProcess("error", "plan.stack.set.failed", { workSessionId: workSession.id, planId, stack, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, workSession],
  );
  const rerunTaskAction = useCallback(
    async (taskId: string, note: string | null) => {
      if (workSession === null || busy) return;
      setBusy(true);
      setError(null);
      logClientProcess("info", "task.rerun.start", { workSessionId: workSession.id, taskId, noteChars: note?.length ?? 0 });
      try {
        const body = await readJson(`/api/work-sessions/${workSession.id}/tasks/${taskId}`, {
          method: "POST",
          body: JSON.stringify({ action: "rerun", note: note ?? "" }),
        });
        if (!isControllerApiResult(body) || !body.ok) {
          throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Re-run failed.");
        }
        await refresh();
        logClientProcess("info", "task.rerun.completed", { workSessionId: workSession.id, taskId });
      } catch (rerunError) {
        const message = rerunError instanceof Error ? rerunError.message : "Re-run failed.";
        logClientProcess("error", "task.rerun.failed", { workSessionId: workSession.id, taskId, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, workSession],
  );

  const skipTaskAction = useCallback(
    async (taskId: string) => {
      if (workSession === null || busy) return;
      setBusy(true);
      setError(null);
      logClientProcess("info", "task.skip.start", { workSessionId: workSession.id, taskId });
      try {
        const body = await readJson(`/api/work-sessions/${workSession.id}/tasks/${taskId}`, {
          method: "POST",
          body: JSON.stringify({ action: "skip" }),
        });
        if (!isControllerApiResult(body) || !body.ok) {
          throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Skip failed.");
        }
        await refresh();
        logClientProcess("info", "task.skip.completed", { workSessionId: workSession.id, taskId });
      } catch (skipError) {
        const message = skipError instanceof Error ? skipError.message : "Skip failed.";
        logClientProcess("error", "task.skip.failed", { workSessionId: workSession.id, taskId, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, workSession],
  );

  const openVerificationDetail = useCallback(
    (run: VerificationRunRecord) => {
      logClientProcess("info", "drawer.open", { kind: "verification", verificationRunId: run.id, status: run.status });
      setDrawerView({ kind: "verification", run });
    },
    [],
  );

  const continueTaskAction = useCallback(
    async (taskId: string) => {
      if (workSession === null || busy) return;
      setBusy(true);
      setError(null);
      logClientProcess("info", "task.timeout_continue.start", { workSessionId: workSession.id, taskId });
      try {
        const body = await readJson(`/api/work-sessions/${workSession.id}/tasks/${taskId}`, {
          method: "POST",
          body: JSON.stringify({ action: "continue-timeout" }),
        });
        if (!isControllerApiResult(body) || !body.ok) {
          throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Continue failed.");
        }
        await refresh();
        logClientProcess("info", "task.timeout_continue.completed", { workSessionId: workSession.id, taskId, state: body.data?.state ?? null });
      } catch (continueError) {
        const message = continueError instanceof Error ? continueError.message : "Continue failed.";
        logClientProcess("error", "task.timeout_continue.failed", { workSessionId: workSession.id, taskId, message });
        setError(message);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, workSession],
  );
  const openHandoffDetail = useCallback(
    (handoff: HandoffRecord) => {
      logClientProcess("info", "drawer.open", { kind: "handoff", handoffId: handoff.id, workSessionId: handoff.workSessionId });
      setDrawerView({ kind: "handoff", handoff, workspacePath: workSession?.activeWorktreePath ?? null });
    },
    [workSession?.activeWorktreePath],
  );
  const openHandoffChanges = useCallback((handoff: HandoffRecord) => {
    logClientProcess("info", "right_panel.open", { kind: "changed-files", handoffId: handoff.id, workSessionId: handoff.workSessionId });
    setRightPanel({ kind: "changed-files", handoff });
  }, []);
  const showPreviewPanel = useCallback(() => {
    logClientProcess("info", "right_panel.open", { kind: "preview", workSessionId });
    setRightPanel({ kind: "preview" });
  }, [workSessionId]);
  const showReportsPanel = useCallback(() => {
    logClientProcess("info", "right_panel.open", { kind: "reports", workSessionId });
    setRightPanel({ kind: "reports" });
  }, [workSessionId]);
  const openEventsDrawer = useCallback(() => {
    logClientProcess("info", "drawer.open", { kind: "events", count: events.length, workSessionId });
    setDrawerView({ kind: "events", events });
  }, [events, workSessionId]);
  const openArtifactsDrawer = useCallback(() => {
    logClientProcess("info", "drawer.open", {
      kind: "artifacts",
      count: artifacts.length,
      screenshotCount: artifacts.filter((artifact) => artifact.artifactKind === "screenshot").length,
      workSessionId,
    });
    setDrawerView({ kind: "artifacts", artifacts });
  }, [artifacts, workSessionId]);
  const openCheckpointHistory = useCallback(() => {
    logClientProcess("info", "drawer.open", { kind: "checkpoints", count: checkpointsForSession.length, workSessionId });
    setDrawerView({
      kind: "checkpoints",
      checkpoints: checkpointsForSession,
      currentCheckpointId: workSession?.checkpointRef ?? null,
      tasks: tasksForSession,
    });
  }, [checkpointsForSession, tasksForSession, workSession?.checkpointRef, workSessionId]);
  const restoreCheckpointAction = useCallback(
    async (checkpointId: string) => {
      if (workSession === null || busy) return;
      const previewWasLive = previewIsLive();
      setBusy(true);
      setRestoring(true);
      setError(null);
      logClientProcess("info", "checkpoint.restore.start", { workSessionId: workSession.id, checkpointId });
      try {
        const body = await readJson(`/api/work-sessions/${workSession.id}/control`, {
          method: "POST",
          body: JSON.stringify({ action: "restore-checkpoint", checkpointId }),
        });
        if (!isObject(body) || body.ok !== true) {
          throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Checkpoint restore failed.");
        }
        await refresh();
        setDrawerView({ kind: "none" });
        await reloadPreviewAfterRollback(previewWasLive, "restore-checkpoint");
        logClientProcess("info", "checkpoint.restore.completed", { workSessionId: workSession.id, checkpointId });
      } catch (restoreError) {
        const message = restoreError instanceof Error ? restoreError.message : "Checkpoint restore failed.";
        logClientProcess("error", "checkpoint.restore.failed", { workSessionId: workSession.id, checkpointId, message });
        setError(message);
      } finally {
        setRestoring(false);
        setBusy(false);
      }
    },
    [busy, previewIsLive, refresh, reloadPreviewAfterRollback, workSession],
  );

  const surgicalRevertCheckpointAction = useCallback(
    async (checkpointId: string) => {
      if (workSession === null || busy) return;
      const previewWasLive = previewIsLive();
      setBusy(true);
      setRestoring(true);
      setError(null);
      logClientProcess("info", "checkpoint.surgical_revert.start", { workSessionId: workSession.id, checkpointId });
      try {
        const body = await readJson(`/api/work-sessions/${workSession.id}/control`, {
          method: "POST",
          body: JSON.stringify({ action: "surgical-revert-checkpoint", checkpointId }),
        });
        if (!isObject(body) || body.ok !== true) {
          throw new Error(isObject(body) && typeof body.error === "string" ? body.error : "Surgical checkpoint revert failed.");
        }
        await refresh();
        setDrawerView({ kind: "none" });
        await reloadPreviewAfterRollback(previewWasLive, "surgical-revert-checkpoint");
        logClientProcess("info", "checkpoint.surgical_revert.completed", { workSessionId: workSession.id, checkpointId });
      } catch (revertError) {
        const message = revertError instanceof Error ? revertError.message : "Surgical checkpoint revert failed.";
        logClientProcess("error", "checkpoint.surgical_revert.failed", { workSessionId: workSession.id, checkpointId, message });
        setError(message);
      } finally {
        setRestoring(false);
        setBusy(false);
      }
    },
    [busy, previewIsLive, refresh, reloadPreviewAfterRollback, workSession],
  );

  const forkCheckpointAction = useCallback(
    async (checkpointId: string) => {
      if (workSession === null) return;
      await forkWorkSession(workSession.id, { checkpointId });
    },
    [forkWorkSession, workSession],
  );

  const openGithubExport = useCallback(async () => {
    if (workSession === null) return;
    setError(null);
    setGithubDialog({ kind: "loading" });
    try {
      const status = await refreshGithubStatus().catch(() => githubStatus);
      const body = await readJson(`/api/work-sessions/${encodeURIComponent(workSession.id)}/github-export/prepare`, {
        method: "POST",
        body: JSON.stringify({ sourceMode: "current_workspace" }),
      });
      if (!isGithubExportPrepareApiResult(body) || !body.ok || body.data === undefined) {
        throw new Error("Invalid GitHub export prepare API response.");
      }
      const prepare = body.data;
      const priorExport = latestCompletedGithubExport;
      setGithubDialog({
        kind: "ready",
        prepare,
        owner: priorExport?.repoOwner ?? prepare.defaultOwner ?? status?.account?.login ?? "",
        repoName: priorExport?.repoName ?? prepare.defaultRepoName,
        branch: priorExport?.branch ?? (prepare.defaultBranch || "main"),
        visibility: priorExport?.visibility ?? "private",
        sourceMode: "current_workspace",
        updateExisting: priorExport !== null,
        replaceContents: false,
        login: null,
        loginStatus: null,
        exporting: false,
      });
    } catch (dialogError) {
      const message = dialogError instanceof Error ? dialogError.message : "Unable to prepare GitHub export.";
      setError(message);
      setGithubDialog({ kind: "closed" });
    }
  }, [githubStatus, latestCompletedGithubExport, refreshGithubStatus, workSession]);

  const updateGithubDialog = useCallback((apply: (current: Extract<GithubExportDialogState, { kind: "ready" }>) => Extract<GithubExportDialogState, { kind: "ready" }>) => {
    setGithubDialog((current) => current.kind === "ready" ? apply(current) : current);
  }, []);

  const startGithubLogin = useCallback(async () => {
    if (workSession === null) return;
    try {
      const body = await readJson("/api/github/auth/device/start", {
        method: "POST",
        body: JSON.stringify({ scopes: ["repo", "workflow"], workSessionId: workSession.id }),
      });
      if (!isGithubDeviceStartApiResult(body) || !body.ok || body.data === undefined) {
        throw new Error("Invalid GitHub login API response.");
      }
      const login = body.data;
      updateGithubDialog((current) => ({
        ...current,
        login,
        loginStatus: `Enter code ${login.user_code} at GitHub, then wait for this dialog to connect.`,
      }));
      window.open(login.verification_uri, "_blank", "noopener,noreferrer");
    } catch (loginError) {
      const message = loginError instanceof Error ? loginError.message : "Unable to start GitHub login.";
      updateGithubDialog((current) => ({ ...current, loginStatus: message }));
    }
  }, [updateGithubDialog, workSession]);

  useEffect(() => {
    if (githubDialog.kind !== "ready" || githubDialog.login === null || workSession === null) {
      return undefined;
    }
    let canceled = false;
    let intervalMs = Math.max(5, githubDialog.login.interval) * 1000;
    const poll = async (): Promise<void> => {
      try {
        const body = await readJson("/api/github/auth/device/poll", {
          method: "POST",
          body: JSON.stringify({ deviceCode: githubDialog.login?.device_code, workSessionId: workSession.id }),
        });
        if (!isGithubDevicePollApiResult(body) || !body.ok || body.data === undefined) {
          throw new Error("Invalid GitHub login poll response.");
        }
        const result = body.data;
        if (result.status === "complete") {
          await refreshGithubStatus();
          updateGithubDialog((current) => ({
            ...current,
            prepare: { ...current.prepare, account: result.account ?? current.prepare.account, defaultOwner: result.account?.login ?? current.prepare.defaultOwner },
            owner: result.account?.login ?? current.owner,
            login: null,
            loginStatus: `Connected as ${result.account?.login ?? "GitHub user"}.`,
          }));
          return;
        }
        if (result.status === "expired") {
          updateGithubDialog((current) => ({ ...current, login: null, loginStatus: result.message ?? "GitHub login expired." }));
          return;
        }
        if (result.status === "slow_down") {
          intervalMs += 5000;
        }
        if (!canceled) {
          window.setTimeout(poll, intervalMs);
        }
      } catch (pollError) {
        const message = pollError instanceof Error ? pollError.message : "GitHub login polling failed.";
        updateGithubDialog((current) => ({ ...current, loginStatus: message }));
      }
    };
    const timeout = window.setTimeout(poll, intervalMs);
    return () => {
      canceled = true;
      window.clearTimeout(timeout);
    };
  }, [githubDialog, refreshGithubStatus, updateGithubDialog, workSession]);

  const submitGithubExport = useCallback(async () => {
    if (workSession === null || githubDialog.kind !== "ready") return;
    updateGithubDialog((current) => ({ ...current, exporting: true, loginStatus: null }));
    try {
      const body = await readJson(`/api/work-sessions/${encodeURIComponent(workSession.id)}/github-export`, idempotentPostInit({
        owner: githubDialog.owner,
        repoName: githubDialog.repoName,
        branch: githubDialog.branch,
        visibility: githubDialog.visibility,
        sourceMode: githubDialog.sourceMode,
        checkpointId: githubDialog.sourceMode === "checkpoint" ? githubDialog.prepare.currentCheckpointId : null,
        updateExisting: githubDialog.updateExisting,
        writeMode: githubDialog.updateExisting && githubDialog.replaceContents ? "replace" : "additive",
      }));
      if (!isGithubExportApiResult(body) || !body.ok || body.data === undefined) {
        throw new Error("Invalid GitHub export API response.");
      }
      setError(null);
      await refresh();
      setGithubDialog({ kind: "closed" });
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : "GitHub export failed.";
      updateGithubDialog((current) => ({ ...current, exporting: false, loginStatus: message }));
      setError(message);
      await refresh().catch(() => undefined);
    }
  }, [githubDialog, refresh, updateGithubDialog, workSession]);

  const handleComposerKey = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void submitMessage();
      }
    },
    [submitMessage],
  );

  const handleComposerPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
      if (files.length === 0) return;
      event.preventDefault();
      addComposerAttachments(files);
    },
    [addComposerAttachments],
  );

  const handleFileSelection = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (event.target.files !== null) {
        addComposerAttachments(event.target.files);
      }
      setUploadMenuOpen(false);
      event.target.value = "";
    },
    [addComposerAttachments],
  );

  const openUploadPicker = useCallback((accept: string) => {
    setUploadAccept(accept);
    setUploadMenuOpen(false);
    window.requestAnimationFrame(() => fileInputRef.current?.click());
  }, []);

  return (
    <main className="app">
      <header className="app-header">
        <div className="brand">
          <BrandMark />
          <div>
            <h1>Agentic Control Freak</h1>
            <p className="brand-sub">Chat-driven planning, execution, verification, and handoff.</p>
          </div>
        </div>
        <div className="app-header-rail">
          <PhaseRail phases={phases} />
        </div>
        <div className="app-header-actions">
          <ThemeToggle />
        </div>
      </header>

      <div className="app-body">
        <ChatHistorySidebar
          items={filteredChatHistoryItems}
          activeWorkSessionId={workSession?.id ?? null}
          busy={busy}
          forkingWorkSessionId={forkingHistoryWorkSessionId}
          collapsed={historyCollapsed}
          searchQuery={historySearch}
          onCreateNewProject={createNewProject}
          onImportProject={openImportDialog}
          onSelectWorkSession={selectWorkSession}
          onForkWorkSession={(item) => void forkWorkSession(item.id)}
          onRenameWorkSession={renameWorkSession}
          onDeleteWorkSession={deleteWorkSession}
          onToggleCollapsed={() => setHistoryCollapsed((collapsed) => !collapsed)}
          onSearchQueryChange={setHistorySearch}
        />

        <section className="workbench">
          <div className="workbench-toolbar" aria-label="Workspace and run controls">
            <div className="workspace-current">
              <span className="workspace-label">Workspace</span>
              <code className="workspace-path" title={workSession?.activeWorktreePath ?? "No workspace selected"}>{workSession?.activeWorktreePath ?? "No workspace selected"}</code>
              <CopyPathButton path={workSession?.activeWorktreePath ?? null} disabled={busy || workSession === null} />
              <button type="button" className="ghost small icon-button" disabled={busy || workSession === null} onClick={() => void openWorkspace()} title="Change workspace" aria-label="Change workspace">
                <ToolbarIcon kind="workspace" />
              </button>
              <button type="button" className="ghost small icon-button" disabled={busy || workSession === null} onClick={() => void openGithubExport()} title="Export to GitHub" aria-label="Export to GitHub">
                <ToolbarIcon kind="upload" />
              </button>
              {latestGithubExport?.status === "completed" ? (
                <a className="workspace-link workspace-icon-link" href={latestGithubExport.htmlUrl} target="_blank" rel="noreferrer" title="Open GitHub repository" aria-label="Open GitHub repository">
                  <ToolbarIcon kind="github" />
                </a>
              ) : null}
            </div>
            <div className="toolbar-controls">
              <RunControls workSession={workSession} busy={busy} provider={effectiveProvider} pendingSteeringCount={pendingSteering.length} canUndoLast={canUndoLast} canOpenCheckpointHistory={canOpenCheckpointHistory} loopChip={loopChip} onControl={sendControl} onSetProvider={setProvider} onOpenRuntime={openRuntimeDrawer} onOpenMemory={openMemoryDrawer} onOpenSkills={openSkillsDrawer} onOpenCheckpointHistory={openCheckpointHistory} />
            </div>
          </div>

          {error !== null ? (
            <div className="banner-error" role="alert">
              <strong>Something went wrong.</strong>
              <span>{error}</span>
              <button type="button" className="ghost small" onClick={() => setError(null)}>Dismiss</button>
            </div>
          ) : null}

          <div
            ref={gridRef}
            className={`app-grid${researchMode ? " app-grid-research" : ""}`}
            style={researchMode ? undefined : ({ "--preview-col": `${previewWidth}px` } as React.CSSProperties)}
          >
            <section className="chat-column">
              <TimelineStream
                items={timeline.items}
                activity={timeline.activity}
                emptyHint="Describe a feature, bugfix, refactor, or research request. Research requests produce chat summaries and report artifacts."
                workspacePath={workSession?.activeWorktreePath ?? null}
                busy={busy}
                forkingHandoffId={forkInProgress?.handoffId ?? null}
                forkingPlanId={forkInProgress?.planId ?? null}
                pendingPlanApproval={pendingPlanApproval}
                canUndoLast={canUndoLast}
                canOpenCheckpointHistory={canOpenCheckpointHistory}
                stackDecision={workSession?.stackDecision ?? null}
                onSetPlanStack={setPlanStackAction}
                onResolveApproval={resolveApproval}
                onForkCurrent={() => {
                  if (workSession === null) return Promise.resolve();
                  return forkWorkSession(workSession.id);
                }}
                onForkHandoff={(handoffId) => {
                  if (workSession === null) return Promise.resolve();
                  return forkWorkSession(workSession.id, { handoffId });
                }}
                onForkPlan={(planId) => {
                  if (workSession === null) return Promise.resolve();
                  return forkWorkSession(workSession.id, { planId });
                }}
                onUndoLast={() => sendControl("undo-last")}
                onOpenCheckpointHistory={openCheckpointHistory}
                onOpenPlanDetail={openPlanDetail}
                onEditPlan={editPlan}
                onRerunTask={rerunTaskAction}
                onContinueTask={continueTaskAction}
                onSkipTask={skipTaskAction}
                onOpenVerificationDetail={openVerificationDetail}
                onOpenHandoffDetail={openHandoffDetail}
                onOpenHandoffChanges={openHandoffChanges}
                onOpenRunLogs={openArtifactsDrawer}
                onStartPreview={startPreview}
                onHardRestartPreview={hardRestartPreview}
                onRepairPreview={repairCurrentPreview}
                onStopPreview={stopCurrentPreview}
                onOpenPreview={openCurrentPreview}
              />
              <div className={`composer${steeringMode ? " composer-steering" : ""}`}>
                {steeringMode ? (
                  <div className="composer-mode" role="status">
                    <span className="composer-mode-dot" aria-hidden />
                    <span>You can send the steering message to the model, if you wish</span>
                  </div>
                ) : null}
                {composerAttachments.length > 0 ? (
                  <div className="composer-attachments" aria-label="Pending attachments">
                    {composerAttachments.map((attachment) => (
                      <div key={attachment.id} className="composer-attachment">
                        {attachment.previewUrl !== null ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={attachment.previewUrl} alt={attachment.file.name} />
                        ) : (
                          <span className="composer-attachment-file" aria-hidden>{composerAttachmentLabel(attachment.kind)}</span>
                        )}
                        <span title={attachment.file.name}>{attachment.file.name}</span>
                        <button
                          type="button"
                          className="composer-attachment-remove"
                          onClick={() => removeComposerAttachment(attachment.id)}
                          aria-label={`Remove ${attachment.file.name}`}
                        >
                          &times;
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <textarea
                  ref={composerRef}
                  autoFocus
                  rows={3}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleComposerKey}
                  onPaste={handleComposerPaste}
                  placeholder={steeringMode
                    ? "Send steering for the running Codex task... (Ctrl+Enter)"
                    : "Describe the feature, bugfix, refactor, research, or verification request... (Ctrl+Enter to send)"}
                />
                <div className="composer-actions">
                  <div className="composer-slash" role="group" aria-label="Slash commands">
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={uploadAccept}
                      multiple
                      className="composer-file-input"
                      onChange={handleFileSelection}
                    />
                    <div className="composer-upload">
                      <button
                        type="button"
                        className="composer-plus"
                        disabled={(busy && !steeringMode) || composerAttachments.length >= 8}
                        onClick={() => setUploadMenuOpen((open) => !open)}
                        aria-haspopup="menu"
                        aria-expanded={uploadMenuOpen}
                        aria-label="Attach files"
                        title="Attach files"
                      >
                        <span className="composer-plus-icon" aria-hidden />
                      </button>
                      {uploadMenuOpen ? (
                        <div className="composer-upload-menu" role="menu">
                          <button type="button" role="menuitem" onClick={() => openUploadPicker("image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp")}>Image</button>
                          <button type="button" role="menuitem" onClick={() => openUploadPicker("application/pdf,.pdf")}>PDF</button>
                          <button type="button" role="menuitem" onClick={() => openUploadPicker("application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx")}>Document</button>
                          <button type="button" role="menuitem" onClick={() => openUploadPicker("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,text/csv,.csv")}>Spreadsheet</button>
                          <button type="button" role="menuitem" onClick={() => openUploadPicker("application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx")}>Presentation</button>
                          <button type="button" role="menuitem" onClick={() => openUploadPicker(allUploadAccept)}>Any supported file</button>
                        </div>
                      ) : null}
                    </div>
                    {workSession !== null ? (
                      <button
                        type="button"
                        className={`slash-chip composer-plan-mode${workSession.planModeEnabled ? " composer-plan-mode-on" : " composer-plan-mode-off"}`}
                        disabled={busy || pendingPlanApproval !== null}
                        aria-pressed={workSession.planModeEnabled}
                        title={pendingPlanApproval !== null
                          ? "Resolve the pending plan before changing plan mode."
                          : workSession.planModeEnabled
                            ? "Plan mode is on. New implementation requests create an approval plan."
                            : "Plan mode is off. Follow-up implementation requests go directly to the selected provider."}
                        onClick={() => void setPlanMode(!workSession.planModeEnabled)}
                      >
                        {workSession.planModeEnabled ? "Plan on" : "Plan off"}
                      </button>
                    ) : null}
                    <span className="composer-slash-label" aria-hidden>/</span>
                    <button type="button" className="slash-chip" disabled={busy || workSession === null} onClick={tick}>
                      tick
                    </button>
                    <button type="button" className="slash-chip" disabled={busy || workSession === null} onClick={createHandoff}>
                      handoff
                    </button>
                    <button type="button" className="slash-chip" disabled={busy} onClick={openEventsDrawer}>
                      events
                    </button>
                    <button type="button" className="slash-chip" disabled={busy} onClick={openArtifactsDrawer}>
                      artifacts
                    </button>
                    <button type="button" className="slash-chip" disabled={workSession === null} onClick={showReportsPanel}>
                      reports
                    </button>
                    <span className="composer-slash-divider" aria-hidden />
                    <button
                      type="button"
                      className="slash-chip slash-chip-danger"
                      disabled={busy}
                      onClick={resetDemo}
                      title='Deletes the local database. Requires typing "delete database".'
                    >
                      reset
                    </button>
                  </div>
                  <button
                    type="button"
                    className="primary composer-send"
                    disabled={(busy && !steeringMode) || (draft.trim().length === 0 && composerAttachments.length === 0)}
                    onClick={submitMessage}
                  >
                    {steeringMode ? "Send steering" : "Send"}
                  </button>
                </div>
              </div>
            </section>

            {!researchMode ? (
              <div
                className="pane-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize preview panel"
                aria-valuemin={MIN_PREVIEW_W}
                aria-valuemax={MAX_PREVIEW_W}
                aria-valuenow={Math.round(previewWidth)}
                tabIndex={0}
                onMouseDown={startPreviewResize}
                onKeyDown={nudgePreviewResize}
              />
            ) : null}

            {rightPanel.kind === "reports" ? (
              <ReportsPane workSession={workSession} onShowPreview={showPreviewPanel} />
            ) : !researchMode && rightPanel.kind === "changed-files" ? (
              <ChangedFilesPane
                workSession={workSession}
                handoff={rightPanel.handoff}
                onShowPreview={showPreviewPanel}
              />
            ) : !researchMode && isMlSession ? (
              <MlPreviewPane
                workSession={workSession}
                verification={verification}
                status={projectedStatus}
                busy={busy}
                eventLog={state.eventLog}
                experimentRuns={state.experimentRuns}
              />
            ) : !researchMode ? (
              <PreviewPane
                preview={latestPreview}
                workSession={workSession}
                verification={verification}
                status={projectedStatus}
                busy={busy}
                pendingFirstServe={previewPendingFirstServe}
                executingTaskTitle={executingTask?.title ?? null}
                restoring={restoring}
                onStartPreview={startPreview}
                onHardRestartPreview={hardRestartPreview}
                onRepairPreview={repairCurrentPreview}
                onStopPreview={stopCurrentPreview}
                onOpenPreview={openCurrentPreview}
                onRunPython={runPythonPreview}
              />
            ) : null}
          </div>
        </section>
      </div>

      <DetailDrawer
        view={drawerView}
        busy={busy}
        onClose={() => setDrawerView({ kind: "none" })}
        onSavePlanAndRun={savePlanAndRun}
        onSaveRuntime={saveRuntime}
        onRefreshSkills={refreshSkills}
        onUpdateSkill={updateSkill}
        onDeleteSkill={deleteSkill}
        onCreateSkill={createSkill}
        onImportSkillFiles={importSkillFiles}
        onCreateUserMemory={createUserMemory}
        onUpdateUserMemory={updateUserMemory}
        onDeleteUserMemory={deleteUserMemory}
        onCreateProjectMemory={createProjectMemory}
        onUpdateProjectMemory={updateProjectMemory}
        onDeleteProjectMemory={deleteProjectMemory}
        onStartNativeReview={startNativeReview}
        onRestoreCheckpoint={restoreCheckpointAction}
        onSurgicalRevertCheckpoint={surgicalRevertCheckpointAction}
        onForkCheckpoint={forkCheckpointAction}
      />

      {githubDialog.kind !== "closed" ? (
        <div className="modal-backdrop" role="presentation">
          <section className="github-export-dialog" role="dialog" aria-modal="true" aria-labelledby="github-export-title">
            <div className="dialog-heading">
              <div>
                <h2 id="github-export-title">Export to GitHub</h2>
                <p>Publish the active workspace as a real GitHub repository commit.</p>
              </div>
              <button type="button" className="ghost small" disabled={githubDialog.kind === "ready" && githubDialog.exporting} onClick={() => setGithubDialog({ kind: "closed" })}>
                Close
              </button>
            </div>
            {githubDialog.kind === "loading" ? (
              <p className="muted">Scanning workspace and checking GitHub login...</p>
            ) : (
              <>
                <div className="github-account-row">
                  <div>
                    <span className="workspace-label">GitHub account</span>
                    <strong>{githubDialog.prepare.account?.login ?? githubStatus?.account?.login ?? "Not connected"}</strong>
                    {githubStatus?.requiredConfig !== null && githubStatus?.requiredConfig !== undefined ? (
                      <span className="muted">{githubStatus.requiredConfig}</span>
                    ) : null}
                  </div>
                  {githubDialog.prepare.account === null && githubStatus?.account === null ? (
                    <button type="button" className="primary small" disabled={githubStatus?.configured === false || githubDialog.login !== null || githubDialog.exporting} onClick={() => void startGithubLogin()}>
                      Login with GitHub
                    </button>
                  ) : null}
                </div>
                {githubDialog.login !== null ? (
                  <div className="github-device-code" role="status">
                    <span>Code</span>
                    <strong>{githubDialog.login.user_code}</strong>
                    <a href={githubDialog.login.verification_uri} target="_blank" rel="noreferrer">Open GitHub login</a>
                  </div>
                ) : null}
                {githubDialog.loginStatus !== null ? <div className="banner-inline">{githubDialog.loginStatus}</div> : null}
                <div className="github-export-grid">
                  <label>
                    <span>Owner</span>
                    <input value={githubDialog.owner} disabled={githubDialog.exporting} onChange={(event) => updateGithubDialog((current) => ({ ...current, owner: event.target.value }))} />
                  </label>
                  <label>
                    <span>Repository</span>
                    <input value={githubDialog.repoName} disabled={githubDialog.exporting} onChange={(event) => updateGithubDialog((current) => ({ ...current, repoName: event.target.value }))} />
                  </label>
                  <label>
                    <span>Branch</span>
                    <input value={githubDialog.branch} disabled={githubDialog.exporting} onChange={(event) => updateGithubDialog((current) => ({ ...current, branch: event.target.value }))} />
                  </label>
                  <label>
                    <span>Visibility</span>
                    <select value={githubDialog.visibility} disabled={githubDialog.exporting} onChange={(event) => updateGithubDialog((current) => ({ ...current, visibility: event.target.value === "public" ? "public" : "private" }))}>
                      <option value="private">Private</option>
                      <option value="public">Public</option>
                    </select>
                  </label>
                </div>
                {githubDialog.visibility === "public" ? (
                  <div className="banner-inline" role="alert">
                    Public repository: anyone on the internet can read every exported file. Likely-secret files (.env, private keys, credential stores) are excluded automatically, but review the file list below before exporting.
                  </div>
                ) : null}
                <div className="github-export-options">
                  <label>
                    <input
                      type="checkbox"
                      checked={githubDialog.sourceMode === "checkpoint"}
                      disabled={githubDialog.exporting || githubDialog.prepare.currentCheckpointId === null}
                      onChange={(event) => updateGithubDialog((current) => ({ ...current, sourceMode: event.target.checked ? "checkpoint" : "current_workspace" }))}
                    />
                    <span>Export latest checkpoint</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={githubDialog.updateExisting}
                      disabled={githubDialog.exporting}
                      onChange={(event) => updateGithubDialog((current) => ({ ...current, updateExisting: event.target.checked, replaceContents: event.target.checked ? current.replaceContents : false }))}
                    />
                    <span>Update existing repository</span>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={githubDialog.replaceContents}
                      disabled={githubDialog.exporting || !githubDialog.updateExisting}
                      onChange={(event) => updateGithubDialog((current) => ({ ...current, replaceContents: event.target.checked }))}
                    />
                    <span>Replace all repository contents (delete files not in this export)</span>
                  </label>
                </div>
                {githubDialog.updateExisting && githubDialog.replaceContents ? (
                  <div className="banner-inline" role="alert">
                    Destructive: every file currently in {githubDialog.owner.trim().length > 0 ? `${githubDialog.owner}/` : ""}{githubDialog.repoName || "the repository"} on branch {githubDialog.branch || "the target branch"} that is not in this export will be deleted in the new commit. Leave this off to add/update the exported files while keeping everything else.
                  </div>
                ) : null}
                <div className="github-export-summary">
                  <div><strong>{githubDialog.prepare.manifest.fileCount}</strong><span>files</span></div>
                  <div><strong>{formatBytes(githubDialog.prepare.manifest.byteCount)}</strong><span>total</span></div>
                  <div><strong>{githubDialog.prepare.manifest.ignored.length}</strong><span>ignored</span></div>
                </div>
                {githubDialog.prepare.manifest.warnings.length > 0 ? (
                  <ul className="github-export-warnings">
                    {githubDialog.prepare.manifest.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                ) : null}
                <div className="github-export-files">
                  {githubDialog.prepare.manifest.files.slice(0, 12).map((file) => (
                    <div key={file.path}>
                      <code>{file.path}</code>
                      <span>{formatBytes(file.byteCount)}</span>
                    </div>
                  ))}
                  {githubDialog.prepare.manifest.files.length > 12 ? <p className="muted">And {githubDialog.prepare.manifest.files.length - 12} more files.</p> : null}
                </div>
                <div className="workspace-risk-actions">
                  <button type="button" className="ghost" disabled={githubDialog.exporting} onClick={() => setGithubDialog({ kind: "closed" })}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={githubDialog.exporting || (githubDialog.prepare.account === null && githubStatus?.account === null) || githubDialog.owner.trim().length === 0 || githubDialog.repoName.trim().length === 0 || githubDialog.prepare.manifest.fileCount === 0}
                    onClick={() => void submitGithubExport()}
                  >
                    {githubDialog.exporting ? "Exporting..." : "Export repository"}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}

      {workspaceCandidate !== null ? (
        <div className="modal-backdrop" role="presentation">
          <section className="workspace-risk-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-risk-title">
            <h2 id="workspace-risk-title">Confirm Workspace</h2>
            <p>This folder is allowed, but it has risk signals. Future research and build requests will run directly in this folder.</p>
            <code>{workspaceCandidate.path}</code>
            <ul>
              {workspaceCandidate.riskReasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <div className="workspace-risk-actions">
              <button type="button" className="ghost" disabled={busy} onClick={() => setWorkspaceCandidate(null)}>
                Cancel
              </button>
              <button type="button" className="primary" disabled={busy} onClick={() => void applyWorkspaceCandidate(workspaceCandidate, true)}>
                Use this folder
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {importDialog !== null ? (
        <div className="modal-backdrop" role="presentation">
          <section className="workspace-risk-dialog" role="dialog" aria-modal="true" aria-labelledby="import-project-title">
            <h2 id="import-project-title">Import a project</h2>
            <div className="import-source-tabs">
              <button
                type="button"
                className={importDialog.source === "local" ? "primary small" : "ghost small"}
                disabled={importDialog.busy}
                onClick={() => setImportDialog((current) => (current === null ? current : { ...current, source: "local", error: null, risk: null }))}
              >
                Local folder
              </button>
              <button
                type="button"
                className={importDialog.source === "git" ? "primary small" : "ghost small"}
                disabled={importDialog.busy}
                onClick={() => setImportDialog((current) => (current === null ? current : { ...current, source: "git", error: null, risk: null }))}
              >
                Clone a repo
              </button>
            </div>
            {importDialog.source === "local" ? (
              <>
                <p>Point a new project at an existing folder. Coding agents work directly in this folder (reference in place).</p>
                <div className="import-field-row">
                  <input
                    type="text"
                    value={importDialog.localPath}
                    placeholder="Absolute folder path"
                    disabled={importDialog.busy}
                    onChange={(event) => setImportDialog((current) => (current === null ? current : { ...current, localPath: event.target.value, risk: null }))}
                    aria-label="Folder path"
                  />
                  <button type="button" className="ghost small" disabled={importDialog.busy} onClick={() => void browseImportFolder()}>
                    Browse…
                  </button>
                </div>
              </>
            ) : (
              <>
                <p>Clone a public or private repository into a new managed workspace. Private GitHub repositories use your connected GitHub account.</p>
                <input
                  type="text"
                  value={importDialog.repoUrl}
                  placeholder="https://github.com/owner/repo"
                  disabled={importDialog.busy}
                  onChange={(event) => setImportDialog((current) => (current === null ? current : { ...current, repoUrl: event.target.value, risk: null }))}
                  aria-label="Repository URL"
                />
                <input
                  type="text"
                  value={importDialog.branch}
                  placeholder="Branch (optional)"
                  disabled={importDialog.busy}
                  onChange={(event) => setImportDialog((current) => (current === null ? current : { ...current, branch: event.target.value }))}
                  aria-label="Branch"
                />
                <div className="import-github">
                  {githubStatus?.account != null ? (
                    <p className="import-github-status">
                      Connected to GitHub as <strong>{githubStatus.account.login}</strong>. Private repositories use this account.
                    </p>
                  ) : githubStatus?.configured === false ? (
                    <p className="import-github-status">
                      {githubStatus.requiredConfig ?? "Set GITHUB_CLIENT_ID to enable GitHub login."} Public repositories can still be cloned without connecting.
                    </p>
                  ) : (
                    <div className="import-github-connect">
                      <span>Connect GitHub to clone private repositories.</span>
                      <button
                        type="button"
                        className="ghost small"
                        disabled={importDialog.busy || importDialog.login !== null}
                        onClick={() => void startImportGithubLogin()}
                      >
                        Connect GitHub
                      </button>
                    </div>
                  )}
                  {importDialog.login !== null ? (
                    <p className="import-github-code">
                      Code <code>{importDialog.login.user_code}</code> —{" "}
                      <a href={importDialog.login.verification_uri} target="_blank" rel="noreferrer">open GitHub</a>
                    </p>
                  ) : null}
                  {importDialog.loginStatus !== null ? <p className="import-github-status">{importDialog.loginStatus}</p> : null}
                </div>
              </>
            )}
            {importDialog.risk !== null ? (
              <div className="import-risk">
                <p>This folder is allowed but has risk signals:</p>
                <ul>
                  {importDialog.risk.riskReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {importDialog.error !== null ? (
              <p className="import-error" role="alert">{importDialog.error}</p>
            ) : null}
            <div className="workspace-risk-actions">
              <button type="button" className="ghost" disabled={importDialog.busy} onClick={() => setImportDialog(null)}>
                Cancel
              </button>
              {importDialog.risk !== null ? (
                <button type="button" className="primary" disabled={importDialog.busy} onClick={() => void submitImport(true)}>
                  {importDialog.busy ? "Importing…" : "Import anyway"}
                </button>
              ) : (
                <button type="button" className="primary" disabled={importDialog.busy} onClick={() => void submitImport(false)}>
                  {importDialog.busy ? "Importing…" : "Import"}
                </button>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}

const autonomyOptions: Array<{ value: WorkSessionRecord["autonomyLevel"]; label: string; hint: string }> = [
  { value: "manual", label: "Manual", hint: "Pause before every task and verification. Step through each action." },
  { value: "checkpoint", label: "Checkpoint", hint: "Auto-run low-risk tasks; pause before risky tasks and verification." },
  { value: "supervised", label: "Supervised", hint: "Auto-run, but pause on the first verification failure." },
  { value: "full_auto", label: "Full auto", hint: "Run the whole loop without stopping." },
];

const autonomyRank: Record<WorkSessionRecord["autonomyLevel"], number> = {
  manual: 1,
  checkpoint: 2,
  supervised: 3,
  full_auto: 4,
};

function AutonomyGauge({ level }: { level: WorkSessionRecord["autonomyLevel"] }): React.ReactElement {
  const rank = autonomyRank[level];
  return (
    <span className="autonomy-gauge" aria-hidden>
      {[1, 2, 3, 4].map((step) => (
        <span key={step} className={`autonomy-bar${step <= rank ? " autonomy-bar-on" : ""}`} />
      ))}
    </span>
  );
}

function ToolbarIcon({ kind }: { kind: "upload" | "github" | "pause" | "undo" | "history" | "workspace" | "gear" }): React.ReactElement {
  switch (kind) {
    case "workspace":
      return (
        <svg className="toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M3.75 7.5h6.1l2 2h8.4v10.25H3.75Z" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3.75 7.5V5.25h6.4l1.85 2.25" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "gear":
      return (
        <svg className="toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Z" stroke="currentColor" strokeWidth="2" />
          <path d="M19.2 13.4a7.8 7.8 0 0 0 0-2.8l2-1.5-2-3.5-2.4 1a8.6 8.6 0 0 0-2.4-1.4L14 2.6h-4l-.4 2.6a8.6 8.6 0 0 0-2.4 1.4l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 2.8l-2 1.5 2 3.5 2.4-1a8.6 8.6 0 0 0 2.4 1.4l.4 2.6h4l.4-2.6a8.6 8.6 0 0 0 2.4-1.4l2.4 1 2-3.5-2-1.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "upload":
      return (
        <svg className="toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 16V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M7 9l5-5 5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 16v3h14v-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "github":
      return (
        <svg className="toolbar-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 1C5.923 1 1 5.923 1 12c0 4.867 3.149 8.979 7.521 10.436.55.096.756-.233.756-.522 0-.262-.013-1.128-.013-2.049-2.764.509-3.479-.674-3.699-1.292-.124-.317-.66-1.293-1.127-1.554-.385-.207-.936-.715-.014-.729.866-.014 1.485.797 1.691 1.128.99 1.663 2.571 1.196 3.204.907.096-.715.385-1.196.701-1.471-2.448-.275-5.005-1.224-5.005-5.432 0-1.196.426-2.186 1.128-2.956-.111-.275-.496-1.402.11-2.915 0 0 .921-.288 3.024 1.128A10.193 10.193 0 0 1 12 6.32c.936.004 1.884.124 2.764.371 2.104-1.43 3.025-1.128 3.025-1.128.605 1.513.221 2.64.111 2.915.701.77 1.127 1.747 1.127 2.956 0 4.222-2.571 5.157-5.019 5.432.399.344.743 1.004.743 2.035 0 1.471-.014 2.654-.014 3.025 0 .289.206.632.756.522C19.851 20.979 23 16.854 23 12c0-6.077-4.922-11-11-11Z" />
        </svg>
      );
    case "pause":
      return (
        <svg className="toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M9 5v14M15 5v14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
        </svg>
      );
    case "undo":
      return (
        <svg className="toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M9 4 4 9l5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "history":
      return (
        <svg className="toolbar-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M12 8v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 8h4V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.8 8.2A8 8 0 1 1 4 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

const autonomyMenuOptions: SelectMenuOption<WorkSessionRecord["autonomyLevel"]>[] = autonomyOptions.map((option) => ({
  value: option.value,
  label: option.label,
  description: option.hint,
  icon: <AutonomyGauge level={option.value} />,
}));

const providerMenuOptions: SelectMenuOption<"codex-cli" | "claude-code" | "antigravity-cli" | "ollama">[] = [
  { value: "codex-cli", label: "Codex CLI", description: "Run Codex with native app-server execution by default and exec as the legacy fallback." },
  { value: "claude-code", label: "Claude Code", description: "Spawn the local Claude Code agent process for planning and execution." },
  { value: "antigravity-cli", label: "AGY CLI", description: "Spawn the local Google Antigravity agent process for planning and execution." },
  { value: "ollama", label: "Ollama (local)", description: "Run a local Ollama model through the orchestrator-owned agent loop." },
];

function deriveLoopChip(workSession: WorkSessionRecord | null, tasks: TaskRecord[]): { label: string; title: string } | null {
  if (workSession === null || workSession.currentState === "completed") {
    return null;
  }
  const planTasks = workSession.activePlanId === null
    ? tasks
    : tasks.filter((task) => task.planId === workSession.activePlanId);
  const repairTasks = planTasks.filter((task) =>
    typeof task.metadata.repairForTaskId === "string" ||
    typeof task.metadata.repairForVerificationRunId === "string" ||
    typeof task.metadata.repairForPreviewId === "string");
  const activeTask = planTasks.find((task) => task.status === "in_progress")
    ?? planTasks.find((task) => task.status === "todo")
    ?? null;
  const failure = activeTask?.lastFailureSummary ?? repairTasks[repairTasks.length - 1]?.lastFailureSummary ?? null;
  const failureTitle = failure === null ? null : `Last failure: ${failure.slice(0, 300)}`;
  if (repairTasks.length > 0) {
    const verificationRepairCount = repairTasks.filter((task) => typeof task.metadata.repairForVerificationRunId === "string").length;
    const budget = verificationRepairCount > 0 ? maxVerificationRepairsPerSession : maxRepairAttemptsPerSession;
    const count = verificationRepairCount > 0 ? verificationRepairCount : repairTasks.length;
    return {
      label: `Repair ${Math.min(count, budget)}/${budget} · ${workSession.currentState}`,
      title: failureTitle ?? "Repair tasks created in this session vs the enforced repair budget.",
    };
  }
  if (activeTask !== null && activeTask.attemptCount > 1) {
    return {
      label: `Attempt ${Math.min(activeTask.attemptCount, maxAttemptsPerTask)}/${maxAttemptsPerTask} · ${workSession.currentState}`,
      title: failureTitle ?? "Attempts on the current task vs the enforced per-task ceiling.",
    };
  }
  return null;
}

function RunControls({
  workSession,
  busy,
  provider,
  pendingSteeringCount,
  canUndoLast,
  canOpenCheckpointHistory,
  loopChip,
  onControl,
  onSetProvider,
  onOpenRuntime,
  onOpenMemory,
  onOpenSkills,
  onOpenCheckpointHistory,
}: {
  workSession: WorkSessionRecord | null;
  busy: boolean;
  provider: "codex-cli" | "claude-code" | "antigravity-cli" | "ollama";
  pendingSteeringCount: number;
  canUndoLast: boolean;
  canOpenCheckpointHistory: boolean;
  loopChip: { label: string; title: string } | null;
  onControl: (action: "pause" | "resume" | "step" | "abort" | "undo-last" | "apply-steering-now" | "cancel-steering" | "set-autonomy", level?: WorkSessionRecord["autonomyLevel"]) => Promise<void>;
  onSetProvider: (provider: "codex-cli" | "claude-code" | "antigravity-cli" | "ollama") => Promise<void>;
  onOpenRuntime: () => void;
  onOpenMemory: () => void;
  onOpenSkills: () => void;
  onOpenCheckpointHistory: () => void;
}): React.ReactElement | null {
  const [dismissedStepGateToken, setDismissedStepGateToken] = useState<string | null>(null);
  const stepGateToken = workSession !== null && (workSession.awaitingStep || workSession.paused)
    ? `${workSession.id}:${workSession.updatedAt}:${workSession.awaitingStep ? "awaiting" : "paused"}:${workSession.nextActionLabel ?? ""}`
    : null;

  useEffect(() => {
    if (dismissedStepGateToken !== null && stepGateToken !== dismissedStepGateToken) {
      setDismissedStepGateToken(null);
    }
  }, [dismissedStepGateToken, stepGateToken]);

  if (workSession === null) return null;

  const level = workSession.autonomyLevel;
  const isRunning = workSession.currentState === "executing" || workSession.currentState === "verifying";
  const showStep = stepGateToken !== null && dismissedStepGateToken !== stepGateToken;

  const stepOnce = (): void => {
    if (stepGateToken !== null) {
      setDismissedStepGateToken(stepGateToken);
      window.setTimeout(() => {
        setDismissedStepGateToken((current) => (current === stepGateToken ? null : current));
      }, 3500);
    }
    void onControl("step");
  };

  return (
    <div className="run-controls" aria-label="Run controls">
      {loopChip !== null ? (
        <span className="loop-chip" title={loopChip.title}>{loopChip.label}</span>
      ) : null}
      <SelectMenu
        className="provider-menu"
        ariaLabel="Coding provider"
        align="end"
        value={provider}
        options={providerMenuOptions}
        disabled={busy || isRunning}
        onSelect={(next) => void onSetProvider(next)}
      />
      <SelectMenu
        className="autonomy-menu"
        ariaLabel="Autonomy level"
        align="end"
        value={level}
        options={autonomyMenuOptions}
        disabled={busy}
        onSelect={(next) => void onControl("set-autonomy", next)}
      />

      <div className="run-controls-actions">
        {showStep ? (
          <button type="button" className="primary small run-step-button" disabled={busy} onClick={stepOnce} title="Run the next single action">
            <span className="run-step-label">Step</span>
            <svg className="run-step-icon" viewBox="0 0 12 12" aria-hidden>
              <path d="M4 2.5 9 6 4 9.5Z" fill="currentColor" />
            </svg>
          </button>
        ) : null}
        {workSession.paused ? (
          <button type="button" className="ghost small" disabled={busy} onClick={() => void onControl("resume")} title="Resume automatic advancement">
            Resume
          </button>
        ) : (
          <button type="button" className="ghost small icon-button" onClick={() => void onControl("pause")} title="Pause after the current step finishes" aria-label="Pause after the current step finishes">
            <ToolbarIcon kind="pause" />
          </button>
        )}
        {isRunning ? (
          <button type="button" className="danger small" onClick={() => void onControl("abort")} title="Kill the running provider process now">
            Abort
          </button>
        ) : null}
        {!isRunning && canUndoLast ? (
          <button type="button" className="danger-text small icon-button" disabled={busy} onClick={() => void onControl("undo-last")} title="Restore the previous orchestrator checkpoint" aria-label="Undo last checkpoint">
            <ToolbarIcon kind="undo" />
          </button>
        ) : null}
        {canOpenCheckpointHistory ? (
          <button type="button" className="ghost small icon-button" disabled={busy} onClick={onOpenCheckpointHistory} title="View checkpoints and restore to an earlier point" aria-label="Open checkpoint history">
            <ToolbarIcon kind="history" />
          </button>
        ) : null}
        {pendingSteeringCount > 0 ? (
          <>
            <button type="button" className="primary small" onClick={() => void onControl("apply-steering-now")} title="Apply queued steering to the active Codex turn when possible, otherwise restart the current task with the guidance">
              Apply now
            </button>
            <button type="button" className="ghost small" disabled={busy} onClick={() => void onControl("cancel-steering")} title="Cancel pending steering messages">
              Cancel steering
            </button>
          </>
        ) : null}
        <button type="button" className="ghost small runtime-button" disabled={busy} onClick={onOpenRuntime} title="Model, reasoning effort, sandbox, network, timeout, and steering note">
          <ToolbarIcon kind="gear" />
          Runtime
        </button>
        <button type="button" className="ghost small runtime-button" disabled={busy} onClick={onOpenMemory} title="Manage project memory injected across providers">
          Memory
        </button>
        <button type="button" className="ghost small runtime-button" disabled={busy} onClick={onOpenSkills} title="Manage app and workspace skills">
          Skills
        </button>
      </div>

      {workSession.awaitingStep && workSession.nextActionLabel !== null ? (
        <span className="run-controls-waiting" role="status">
          Waiting: {workSession.nextActionLabel}
        </span>
      ) : pendingSteeringCount > 0 ? (
        <span className="run-controls-waiting" role="status">
          {pendingSteeringCount} steering message{pendingSteeringCount === 1 ? "" : "s"} queued
        </span>
      ) : workSession.paused ? (
        <span className="run-controls-waiting" role="status">
          Paused
        </span>
      ) : null}
    </div>
  );
}

function BrandMark(): React.ReactElement {
  return (
    <svg
      className="brand-mark"
      xmlns="http://www.w3.org/2000/svg"
      width="28"
      height="28"
      viewBox="0 0 24 24"
      role="img"
      aria-label="Agentic Control Freak"
    >
      <circle cx="12" cy="12" r="10" fill="var(--brand-mark-bg)" stroke="var(--brand-mark-border)" strokeWidth="1.25" />
      <circle
        className="brand-mark__orbit"
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="var(--brand-mark-accent)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="18 82"
        strokeDashoffset="0"
        pathLength="100"
      />
      <rect
        x="6.75"
        y="7"
        width="10.5"
        height="10"
        rx="2.25"
        fill="var(--brand-mark-surface)"
        stroke="var(--brand-mark-border)"
        strokeWidth="1"
      />
      <path
        d="M9.1 10.1 10.8 12 9.1 13.9"
        fill="none"
        stroke="var(--brand-mark-ink)"
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="brand-mark__cursor"
        d="M12.35 14.05h2.6"
        fill="none"
        stroke="var(--brand-mark-muted)"
        strokeWidth="1.45"
        strokeLinecap="round"
      />
      <path
        d="m12.85 10.65 1.2 1.2 1.4-1.75"
        fill="none"
        stroke="var(--brand-mark-verify)"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="11" y="2.5" width="2" height="2" rx="0.55" fill="var(--brand-mark-accent)" />
      <rect x="19.5" y="11" width="2" height="2" rx="0.55" fill="var(--brand-mark-muted)" />
      <rect x="11" y="19.5" width="2" height="2" rx="0.55" fill="var(--brand-mark-verify)" />
    </svg>
  );
}

function ChatHistorySidebar({
  items,
  activeWorkSessionId,
  busy,
  forkingWorkSessionId,
  collapsed,
  searchQuery,
  onCreateNewProject,
  onImportProject,
  onSelectWorkSession,
  onForkWorkSession,
  onRenameWorkSession,
  onDeleteWorkSession,
  onToggleCollapsed,
  onSearchQueryChange,
}: {
  items: ChatHistoryItem[];
  activeWorkSessionId: string | null;
  busy: boolean;
  forkingWorkSessionId: string | null;
  collapsed: boolean;
  searchQuery: string;
  onCreateNewProject: () => Promise<void>;
  onImportProject: () => void;
  onSelectWorkSession: (workSessionId: string) => void;
  onForkWorkSession: (item: ChatHistoryItem) => void;
  onRenameWorkSession: (item: ChatHistoryItem) => void;
  onDeleteWorkSession: (item: ChatHistoryItem) => void;
  onToggleCollapsed: () => void;
  onSearchQueryChange: (value: string) => void;
}): React.ReactElement {
  return (
    <aside className={`history-sidebar${collapsed ? " history-sidebar-collapsed" : ""}`} aria-label="Chat history">
      <div className="history-sidebar-header">
        <strong className="history-brand">Chats</strong>
        <button
          type="button"
          className="history-icon-btn"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? "Expand chat history" : "Collapse chat history"}
          title={collapsed ? "Expand chat history" : "Collapse chat history"}
        >
          <SidebarToggleIcon collapsed={collapsed} />
        </button>
      </div>
      <div className="history-actions">
        <button
          type="button"
          className="history-action-btn"
          disabled={busy}
          onClick={() => void onCreateNewProject()}
          title="Start a new project"
        >
          <NewChatIcon />
          <span>New project</span>
        </button>
        <button
          type="button"
          className="history-action-btn"
          disabled={busy}
          onClick={onImportProject}
          title="Import an existing folder or clone a repository"
        >
          <ImportIcon />
          <span>Import</span>
        </button>
        {!collapsed ? (
          <label className="history-search-row">
            <SearchIcon />
            <input
              type="search"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
            />
          </label>
        ) : null}
      </div>
      <nav className="history-list" aria-label="Stored chats" aria-hidden={collapsed}>
        {items.length === 0 ? (
          <div className="history-empty">
            <strong>{searchQuery.trim().length > 0 ? "No matches" : "No chats yet"}</strong>
            <span>{searchQuery.trim().length > 0 ? "Try a different search." : "Start a project to create the first stored chat."}</span>
          </div>
        ) : null}
        {items.map((item) => {
          const selected = item.id === activeWorkSessionId;
          const forking = item.id === forkingWorkSessionId;
          const hasUnreadWork = item.hasUnreadWork && !selected;
          const workDotClass = item.isWorking ? " history-item-working" : hasUnreadWork ? " history-item-unread-work" : "";
          const workStateLabel = item.isWorking ? ". Work in progress." : hasUnreadWork ? ". Work finished. Open to review." : "";
          return (
            <div key={item.id} className={`history-item history-item-${item.tone}${workDotClass}${forking ? " history-item-forking" : ""}`}>
              <button
                type="button"
                className="history-item-select"
                aria-current={selected ? "page" : undefined}
                aria-label={`${item.title}. ${item.subtitle}. ${item.status}${workStateLabel}${forking ? ". Fork creation in progress." : ""}.`}
                onClick={() => onSelectWorkSession(item.id)}
                title={`${item.title}\n${item.subtitle}\n${item.status} - ${formatHistoryTime(item.updatedAt)}`}
              >
                <span className="history-item-main">
                  <span className="history-title">{item.title}</span>
                  <span className="history-subtitle">{item.subtitle}</span>
                </span>
                <span className="history-time">{formatHistoryTime(item.updatedAt)}</span>
              </button>
              <span className="history-item-actions">
                <button
                  type="button"
                  className="history-row-action"
                  disabled={busy}
                  onClick={() => onForkWorkSession(item)}
                  aria-label={forking ? `Forking ${item.title}` : `Fork ${item.title}`}
                  title={forking ? "Creating fork..." : "Fork chat"}
                >
                  {forking ? <span className="action-spinner action-spinner-small" aria-hidden /> : <ForkIcon />}
                </button>
                <button
                  type="button"
                  className="history-row-action"
                  disabled={busy}
                  onClick={() => onRenameWorkSession(item)}
                  aria-label={`Rename ${item.title}`}
                  title="Rename chat"
                >
                  <RenameIcon />
                </button>
                <button
                  type="button"
                  className="history-row-action history-row-delete"
                  disabled={busy}
                  onClick={() => onDeleteWorkSession(item)}
                  aria-label={`Delete ${item.title}`}
                  title="Delete chat"
                >
                  <DeleteIcon />
                </button>
              </span>
              {forking ? (
                <span className="history-fork-status" role="status">
                  <span className="action-spinner action-spinner-small" aria-hidden />
                  Forking...
                </span>
              ) : null}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function NewChatIcon(): React.ReactElement {
  return (
    <svg className="history-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 19h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="M14.7 4.9 19.1 9.3 9.2 19.2H4.8v-4.4L14.7 4.9Z" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
      <path d="m13.5 6.1 4.4 4.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon(): React.ReactElement {
  return (
    <svg className="history-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="1.9" />
      <path d="m16 16 4 4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function ImportIcon(): React.ReactElement {
  return (
    <svg className="history-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 3v10" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
      <path d="m7.5 9.5 4.5 4.5 4.5-4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 19h14" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

function RenameIcon(): React.ReactElement {
  return (
    <svg className="history-row-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 20h4.3L19.1 9.2a2.1 2.1 0 0 0 0-3L17.8 4.9a2.1 2.1 0 0 0-3 0L4 15.7V20Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="m13.7 6 4.3 4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function ForkIcon(): React.ReactElement {
  return (
    <svg className="history-row-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 5v4.5A5.5 5.5 0 0 0 11.5 15H18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 5v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m15 12 3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DeleteIcon(): React.ReactElement {
  return (
    <svg className="history-row-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 7h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M9 7V5h6v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 10v8M12 10v8M16 10v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7 7l1 13h8l1-13" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

function SidebarToggleIcon({ collapsed }: { collapsed: boolean }): React.ReactElement {
  return (
    <svg className="history-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="4" width="17" height="16" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d={collapsed ? "M10 4v16" : "M14 4v16"} stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function CopyPathButton({ path, disabled }: { path: string | null; disabled: boolean }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const onCopy = (): void => {
    if (path === null) return;
    void navigator.clipboard
      ?.writeText(path)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard unavailable; ignore */
      });
  };

  return (
    <button
      type="button"
      className={`workspace-copy${copied ? " workspace-copy-done" : ""}`}
      disabled={disabled || path === null}
      onClick={onCopy}
      aria-label={copied ? "Workspace path copied" : "Copy workspace path"}
      title={copied ? "Copied" : "Copy workspace path"}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden>
          <path d="M5 12.5 10 17.5 19 6.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden>
          <rect x="9" y="9" width="11" height="11" rx="2.4" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5 15.5A2 2 0 0 1 4 13.8V5.8A1.8 1.8 0 0 1 5.8 4h8a2 2 0 0 1 1.7 1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}
