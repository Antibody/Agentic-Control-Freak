import { copyFile, mkdir, open, readdir, readFile, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/server/config";
import { chatSummary, eventText } from "@/lib/server/text-bounds";
import type {
  AgentRunRecord,
  AppDatabase,
  ApprovalRecord,
  ArtifactRecord,
  ChatMessageRecord,
  ChatSessionRecord,
  CheckpointRecord,
  CodeChangeRecord,
  CommandReceiptRecord,
  EventRecord,
  EventPriority,
  ExperimentRunRecord,
  GithubExportRecord,
  HandoffRecord,
  Identifier,
  PlanRecord,
  PlaybookRecord,
  PreviewServerRecord,
  ProjectRecord,
  ProjectMemoryRecord,
  PublicAppState,
  RuntimeProfileRecord,
  SkillActivationRecord,
  SkillRecord,
  SteeringMessageRecord,
  TaskRecord,
  ToolRunRecord,
  UserRecord,
  UserMemoryRecord,
  VerificationRunRecord,
  WorkSessionRecord,
} from "@/lib/shared/types";

export type DbMutator<T> = (db: AppDatabase) => T;

let dbLock: Promise<void> = Promise.resolve();
const transientDatabaseWriteErrorCodes = new Set(["EPERM", "EACCES", "EBUSY"]);
const databaseFileLockTimeoutMs = 120000;
const databaseFileLockStaleMs = 120000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : "";
}

function databaseWriteAttemptCount(): number {
  return process.platform === "win32" ? 45 : 10;
}

function databaseWriteRetryDelayMs(attempt: number): number {
  const baseMs = process.platform === "win32" ? 50 : 25;
  const exponential = Math.min(process.platform === "win32" ? 5000 : 2000, Math.round(baseMs * 1.6 ** attempt));
  const jitter = Math.floor(Math.random() * Math.min(75, exponential));
  return exponential + jitter;
}

function databaseLockPath(dbFile: string): string {
  return `${dbFile}.lock`;
}

async function processIsAlive(pid: number): Promise<boolean> {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = errorCode(error);
    return code !== "ESRCH";
  }
}

async function databaseFileLockIsStale(lockPath: string): Promise<boolean> {
  let ageMs = 0;
  try {
    const info = await stat(lockPath);
    ageMs = Date.now() - info.mtimeMs;
  } catch {
    return true;
  }

  try {
    const raw = await readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof parsed.pid === "number" ? parsed.pid : Number(parsed.pid);
    if (Number.isFinite(pid) && pid > 0 && !(await processIsAlive(pid))) {
      return true;
    }
  } catch {
    return ageMs > databaseFileLockStaleMs;
  }

  return ageMs > databaseFileLockStaleMs;
}

async function acquireDatabaseFileLock(): Promise<() => Promise<void>> {
  const config = getConfig();
  const lockPath = databaseLockPath(config.dbFile);
  await mkdir(path.dirname(config.dbFile), { recursive: true });
  const startedAt = Date.now();
  let handle: FileHandle | null = null;
  const token = randomUUID();

  for (let attempt = 0; Date.now() - startedAt < databaseFileLockTimeoutMs; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({
        token,
        pid: process.pid,
        createdAt: nowIso(),
        dbFile: config.dbFile,
      }));
      return async () => {
        await handle?.close().catch(() => undefined);
        handle = null;
        try {
          const raw = await readFile(lockPath, "utf8");
          const parsed = JSON.parse(raw) as { token?: unknown };
          if (parsed.token === token) {
            await unlink(lockPath).catch(() => undefined);
          }
        } catch {
        }
      };
    } catch (error) {
      const code = errorCode(error);
      if (code !== "EEXIST") {
        throw error;
      }
      if (await databaseFileLockIsStale(lockPath)) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      await delay(Math.min(1000, 25 * 1.5 ** attempt) + Math.floor(Math.random() * 50));
    }
  }

  throw new Error(`Timed out waiting for database file lock: ${lockPath}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createId(): Identifier {
  return randomUUID();
}

function defaultLocalRepoPath(config = getConfig()): string {
  return path.join(config.workspaceRoot, "demo-project");
}

function usesManagedDemoWorkspace(project: ProjectRecord | undefined): boolean {
  return project?.id === "project-demo" || project?.repoUrl === "local://demo-project";
}

function equivalentPath(left: string, right: string): boolean {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return process.platform === "win32" ? leftResolved.toLowerCase() === rightResolved.toLowerCase() : leftResolved === rightResolved;
}

function isInsidePath(candidate: string, possibleParent: string): boolean {
  const relative = path.relative(path.resolve(possibleParent), path.resolve(candidate));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shouldNormalizeManagedDemoWorkspace(project: ProjectRecord, config = getConfig()): boolean {
  if (!usesManagedDemoWorkspace(project) || project.workspaceSelection?.source === "manual") {
    return false;
  }
  const currentPath = project.localRepoPath;
  return equivalentPath(currentPath, process.cwd()) || !isInsidePath(currentPath, config.workspaceRoot);
}

function createEmptyDatabase(): AppDatabase {
  const userId = "user-local";
  const projectId = "project-demo";
  const runtimeProfileId = "runtime-demo";
  const chatSessionId = "chat-demo";
  const workSessionId = "work-demo";
  const createdAt = nowIso();
  const config = getConfig();
  const localRepoPath = defaultLocalRepoPath(config);

  const user: UserRecord = {
    id: userId,
    email: "local@example.com",
    name: "Local Developer",
    createdAt,
  };

  const project: ProjectRecord = {
    id: projectId,
    ownerUserId: userId,
    name: "Demo Project",
    slug: "demo-project",
    repoUrl: "local://demo-project",
    localRepoPath,
    defaultBranch: "main",
    trusted: true,
    workspaceSelection: {
      source: "generated",
      selectedAt: createdAt,
      selectedPath: localRepoPath,
      riskLevel: "none",
      riskReasons: [],
      detectedStack: "unknown",
      isEmpty: true,
    },
    createdAt,
  };

  const runtimeProfile: RuntimeProfileRecord = {
    id: runtimeProfileId,
    projectId,
    name: "Default Runtime",
    runtimeKind: "codex",
    provider: config.agentProvider,
    model: config.codexModel,
    approvalPolicy: config.codexApprovalPolicy,
    sandboxMode: config.codexSandboxMode,
    writableRoots: [config.workspaceRoot, localRepoPath],
    extraConfig: {},
    createdAt,
  };

  const chatSession: ChatSessionRecord = {
    id: chatSessionId,
    projectId,
    title: "Closed Dev Loop Chat",
    status: "active",
    createdBy: userId,
    createdAt,
    updatedAt: createdAt,
  };

  const workSession: WorkSessionRecord = {
    id: workSessionId,
    projectId,
    chatSessionId,
    runtimeProfileId,
    currentState: "intake",
    activeBranch: "main",
    activeWorktreePath: localRepoPath,
    activePlanId: null,
    startedBy: userId,
    startedAt: createdAt,
    updatedAt: createdAt,
    lastUserMessage: "",
    deliveryKind: "implementation",
    planModeEnabled: true,
    executionMode: "single-owner",
    autonomyLevel: config.defaultAutonomyLevel,
    paused: false,
    awaitingStep: false,
    nextActionLabel: null,
    pythonRunParams: null,
    rRunParams: null,
    agentProvider: null,
    runtimeOverrides: null,
    runtimeUsage: null,
    claudeSessionId: null,
    codexThreadId: null,
    codexSubagents: [],
    codexCollabCalls: [],
    transcriptRef: null,
    steeringNote: "",
    budget: null,
    lastProgress: null,
    checkpointRef: null,
    historyBaseCheckpointId: null,
    historyBaseCheckpointCreatedAt: null,
    historyRestoredAt: null,
    forkedFromWorkSessionId: null,
    forkedFromCheckpointId: null,
    forkedAt: null,
  };

  return {
    users: [user],
    projects: [project],
    runtimeProfiles: [runtimeProfile],
    chatSessions: [chatSession],
    chatMessages: [
      {
        id: createId(),
        chatSessionId,
        role: "assistant",
        content:
          "I am ready. Send a development request, I will create a durable plan, ask for approval, execute backend tasks, run verification, and store all events/artifacts.",
        messageKind: "chat",
        attachments: [],
        relatedEventId: null,
        createdAt,
      },
    ],
    workSessions: [workSession],
    plans: [],
    tasks: [],
    agentRuns: [],
    toolRuns: [],
    codeChanges: [],
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
}

function normalizeDatabase(db: AppDatabase): AppDatabase {
  db.previewServers ??= [];
  db.experimentRuns ??= [];
  db.githubExports ??= [];
  for (const exportRecord of db.githubExports) {
    exportRecord.writeMode ??= "replace";
  }
  db.playbooks ??= [];
  db.skills ??= [];
  db.skillActivations ??= [];
  db.userMemories ??= [];
  db.projectMemories ??= [];
  db.commandReceipts ??= [];
  db.eventLog ??= [];
  db.tasks ??= [];
  db.steeringMessages ??= [];
  db.checkpoints ??= [];
  const config = getConfig();
  for (const project of db.projects ?? []) {
    project.workspaceSelection ??= {
      source: project.localRepoPath.startsWith(config.workspaceRoot) ? "generated" : "manual",
      selectedAt: project.createdAt,
      selectedPath: project.localRepoPath,
      riskLevel: "none",
      riskReasons: [],
      detectedStack: "unknown",
      isEmpty: false,
    };
    project.workspaceSelection.selectedPath ||= project.localRepoPath;
    project.workspaceSelection.riskReasons ??= [];
  }
  for (const workSession of db.workSessions ?? []) {
    workSession.autonomyLevel ??= "full_auto";
    workSession.paused ??= false;
    workSession.awaitingStep ??= false;
    workSession.nextActionLabel ??= null;
    workSession.pythonRunParams ??= null;
    workSession.rRunParams ??= null;
    workSession.mlRunConfig ??= null;
    workSession.activeExperimentRunId ??= null;
    workSession.agentProvider ??= null;
    workSession.runtimeOverrides ??= null;
    workSession.runtimeUsage ??= null;
    workSession.claudeSessionId ??= null;
    workSession.codexThreadId ??= null;
    workSession.codexLastTurnId ??= null;
    workSession.forkedFromCodexThreadId ??= null;
    workSession.nativeCodexForkedAt ??= null;
    workSession.codexSubagents ??= [];
    workSession.codexCollabCalls ??= [];
    workSession.transcriptRef ??= null;
    const runtimeOverrides = workSession.runtimeOverrides;
    if (runtimeOverrides !== null && (runtimeOverrides.reasoningEffort as string | null | undefined) === "minimal") {
      runtimeOverrides.reasoningEffort = null;
    }
    if (runtimeOverrides !== null) {
      runtimeOverrides.serviceTier ??= null;
      runtimeOverrides.temperature ??= null;
      runtimeOverrides.numCtx ??= null;
      runtimeOverrides.codexTransportMode ??= null;
    }
    workSession.steeringNote ??= "";
    workSession.deliveryKind ??= "implementation";
    workSession.planModeEnabled ??= true;
    workSession.budget ??= null;
    workSession.lastProgress ??= null;
    workSession.checkpointRef ??= null;
    workSession.historyBaseCheckpointId ??= null;
    workSession.historyBaseCheckpointCreatedAt ??= null;
    workSession.historyRestoredAt ??= null;
    workSession.forkedFromWorkSessionId ??= null;
    workSession.forkedFromCheckpointId ??= null;
    workSession.forkedAt ??= null;
  }
  for (const preview of db.previewServers) {
    preview.idleExpiresAt ??= null;
    preview.stoppedReason ??= null;
  }
  for (const message of db.chatMessages ?? []) {
    message.attachments ??= [];
    for (const attachment of message.attachments) {
      attachment.extractedWorkspacePath ??= null;
      attachment.extractedAbsolutePath ??= null;
      attachment.extractedSummary ??= null;
    }
  }
  for (const message of db.steeringMessages ?? []) {
    message.attachments ??= [];
    for (const attachment of message.attachments) {
      attachment.extractedWorkspacePath ??= null;
      attachment.extractedAbsolutePath ??= null;
      attachment.extractedSummary ??= null;
    }
  }
  for (const task of db.tasks) {
    task.attemptCount ??= 0;
    task.lastFailureSummary ??= null;
    task.lastFailureFingerprint ??= null;
    task.acceptanceEvidence ??= task.acceptanceCriteria.map((criterion) => ({
      criterion,
      status: "unknown",
      source: "manual_note",
      note: "No evidence recorded yet.",
      updatedAt: nowIso(),
    }));
  }
  for (const plan of db.plans ?? []) {
    plan.approvalCheckpointId ??= null;
  }
  for (const run of db.agentRuns ?? []) {
    run.codexThreadId ??= null;
    run.codexTurnId ??= null;
    run.codexTransport ??= null;
  }
  for (const checkpoint of db.checkpoints ?? []) {
    checkpoint.codexThreadId ??= null;
    checkpoint.codexTurnId ??= null;
    checkpoint.codexTurnOrdinal ??= null;
  }
  for (const approval of db.approvals ?? []) {
    approval.externalRequestId ??= null;
    approval.externalRequestMethod ??= null;
    approval.codexThreadId ??= null;
    approval.codexTurnId ??= null;
  }
  for (const message of db.steeringMessages ?? []) {
    message.delivery ??= message.status === "applied" ? "queued" : null;
    message.codexThreadId ??= null;
    message.codexTurnId ??= null;
    message.failureReason ??= null;
  }
  for (const event of db.eventLog) {
    event.priority ??= defaultEventPriority(event.eventName);
  }
  for (const verificationRun of db.verificationRuns ?? []) {
    verificationRun.failureKind ??= verificationRun.status === "failed" ? "source_failure" : "none";
  }
  trimEventLog(db);
  normalizeAbandonedAgentRuns(db);
  return db;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const eventLogMaxLowPriorityEntries = positiveIntFromEnv("EVENT_LOG_MAX_LOW_PRIORITY_ENTRIES", 4000);
const eventLogMaxEntries = positiveIntFromEnv("EVENT_LOG_MAX_ENTRIES", 12000);

function trimEventLog(db: AppDatabase): void {
  const lowPriorityCount = db.eventLog.reduce((count, event) => (event.priority === "low" ? count + 1 : count), 0);
  if (lowPriorityCount > eventLogMaxLowPriorityEntries) {
    let toRemove = lowPriorityCount - eventLogMaxLowPriorityEntries;
    db.eventLog = db.eventLog.filter((event) => {
      if (toRemove > 0 && event.priority === "low") {
        toRemove -= 1;
        return false;
      }
      return true;
    });
  }
  if (db.eventLog.length > eventLogMaxEntries) {
    db.eventLog = db.eventLog.slice(db.eventLog.length - eventLogMaxEntries);
  }
}

function normalizeAbandonedAgentRuns(db: AppDatabase): void {
  const terminalStates = new Set(["blocked", "handoff_needed", "completed", "failed", "canceled"]);
  const tasksById = new Map((db.tasks ?? []).map((task) => [task.id, task]));
  const sessionsById = new Map((db.workSessions ?? []).map((session) => [session.id, session]));
  for (const run of db.agentRuns ?? []) {
    if (run.status !== "running" && run.status !== "waiting_approval") {
      continue;
    }
    const session = sessionsById.get(run.workSessionId);
    const task = run.taskId === null ? null : tasksById.get(run.taskId) ?? null;
    const taskIsTerminal = task !== null && (task.status === "done" || task.status === "skipped");
    const sessionIsTerminal = session !== undefined && terminalStates.has(session.currentState);
    if (!taskIsTerminal && !sessionIsTerminal) {
      continue;
    }
    run.status = session?.currentState === "canceled" ? "canceled" : "failed";
    run.summary = run.summary.trim().length > 0
      ? run.summary
      : "Marked abandoned because the task or session had already advanced past this run.";
    run.endedAt = session?.updatedAt ?? task?.acceptanceEvidence.at(-1)?.updatedAt ?? run.startedAt;
  }
}

function defaultEventPriority(eventName: string): EventPriority {
  if (eventName === "session.failed" || eventName === "session.blocked" || eventName === "handoff.created") {
    return "critical";
  }
  if (eventName.endsWith(".failed") || eventName === "approval.requested") {
    return "high";
  }
  if (
    eventName === "task.progress" ||
    eventName.startsWith("chat.message.stream.") ||
    eventName === "agent.process.output.delta" ||
    eventName === "verification.command.output.delta"
  ) {
    return "low";
  }
  return "normal";
}

function applyRuntimeConfigToProfiles(db: AppDatabase): AppDatabase {
  const config = getConfig();
  const managedRepoPath = defaultLocalRepoPath(config);

  for (const project of db.projects) {
    if (shouldNormalizeManagedDemoWorkspace(project, config)) {
      project.localRepoPath = managedRepoPath;
      project.workspaceSelection = {
        source: "generated",
        selectedAt: project.workspaceSelection?.selectedAt ?? project.createdAt,
        selectedPath: managedRepoPath,
        riskLevel: "none",
        riskReasons: [],
        detectedStack: project.workspaceSelection?.detectedStack ?? "unknown",
        isEmpty: project.workspaceSelection?.isEmpty ?? true,
      };
    }
  }

  for (const workSession of db.workSessions) {
    const project = db.projects.find((candidate) => candidate.id === workSession.projectId);
    if (usesManagedDemoWorkspace(project) && project !== undefined && project.workspaceSelection?.source !== "manual") {
      workSession.activeWorktreePath = project.localRepoPath;
    }
  }

  for (const profile of db.runtimeProfiles) {
    const project = db.projects.find((candidate) => candidate.id === profile.projectId);
    const localRepoPath = project?.localRepoPath ?? path.join(config.workspaceRoot, "demo-project");
    profile.provider = config.agentProvider;
    profile.model = config.codexModel;
    profile.approvalPolicy = config.codexApprovalPolicy;
    profile.sandboxMode = config.codexSandboxMode;
    profile.writableRoots = [config.workspaceRoot, localRepoPath];
  }
  return db;
}

let hygieneSweepStarted = false;

function lockOwnerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      return (error as { code?: unknown }).code === "EPERM";
    }
    return false;
  }
}

function startupHygieneSweep(): void {
  if (hygieneSweepStarted) {
    return;
  }
  hygieneSweepStarted = true;
  void (async () => {
    const config = getConfig();
    const directory = path.dirname(config.dbFile);
    const baseName = path.basename(config.dbFile);
    const staleTmpAgeMs = 10 * 60 * 1000;
    try {
      for (const entry of await readdir(directory)) {
        if (!entry.startsWith(`${baseName}.`) || !entry.endsWith(".tmp")) {
          continue;
        }
        const tmpPath = path.join(directory, entry);
        const info = await stat(tmpPath).catch(() => null);
        if (info !== null && Date.now() - info.mtimeMs > staleTmpAgeMs) {
          await unlink(tmpPath).catch(() => undefined);
        }
      }
    } catch {
    }
    try {
      const locksDir = path.join(directory, "locks");
      for (const entry of await readdir(locksDir)) {
        if (!entry.startsWith("controller-") || !entry.endsWith(".lock")) {
          continue;
        }
        const lockPath = path.join(locksDir, entry);
        try {
          const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: unknown };
          const pid = typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null;
          if (pid !== null && pid !== process.pid && !lockOwnerIsAlive(pid)) {
            await unlink(lockPath).catch(() => undefined);
          }
        } catch {
        }
      }
    } catch {
    }
  })();
}

async function readDatabase(): Promise<AppDatabase> {
  const config = getConfig();
  startupHygieneSweep();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const raw = await readFile(config.dbFile, "utf8");
      return applyRuntimeConfigToProfiles(normalizeDatabase(JSON.parse(raw) as AppDatabase));
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") {
        const db = createEmptyDatabase();
        await writeDatabase(db);
        return db;
      }
      if (attempt === 5) {
        throw error;
      }
      await delay(20 * 2 ** attempt);
    }
  }
  throw new Error("Unable to read embedded database.");
}

async function writeFileSynced(filePath: string, payload: string): Promise<void> {
  const handle = await open(filePath, "w");
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDatabase(db: AppDatabase): Promise<void> {
  const config = getConfig();
  const directory = path.dirname(config.dbFile);
  await mkdir(directory, { recursive: true });
  const tempFile = `${config.dbFile}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const payload = JSON.stringify(db);
  const attempts = databaseWriteAttemptCount();
  await writeFileSynced(tempFile, payload);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const lastAttempt = attempt === attempts - 1;
    try {
      await rename(tempFile, config.dbFile);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" && !lastAttempt) {
        await writeFileSynced(tempFile, payload);
        await delay(databaseWriteRetryDelayMs(attempt));
        continue;
      }
      if (!transientDatabaseWriteErrorCodes.has(code) || lastAttempt) {
        await unlink(tempFile).catch(() => undefined);
        throw error;
      }
      await delay(databaseWriteRetryDelayMs(attempt));
    }
  }
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const previousLock = dbLock;
  let releaseLock: () => void = () => undefined;
  dbLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  await previousLock;
  const releaseFileLock = await acquireDatabaseFileLock();
  try {
    return await fn();
  } finally {
    await releaseFileLock();
    releaseLock();
  }
}

export async function readAppState(): Promise<PublicAppState> {
  const db = await readDatabase();
  return {
    users: db.users,
    projects: db.projects,
    runtimeProfiles: db.runtimeProfiles,
    chatSessions: db.chatSessions,
    chatMessages: db.chatMessages.map((message) => ({
      ...message,
      content: message.messageKind === "research_report"
        ? message.content
        : message.role === "assistant" ? chatSummary(message.content) : eventText(message.content),
    })),
    workSessions: db.workSessions,
    plans: db.plans,
    tasks: db.tasks.map((task) => ({
      ...task,
      lastFailureSummary: task.lastFailureSummary === null ? null : chatSummary(task.lastFailureSummary),
      metadata: Object.fromEntries(
        Object.entries(task.metadata).map(([key, value]) => [key, typeof value === "string" ? eventText(value) : value])
      ),
    })),
    agentRuns: db.agentRuns.map((run) => ({ ...run, summary: chatSummary(run.summary) })),
    checkpoints: db.checkpoints,
    verificationRuns: db.verificationRuns.map((run) => ({
      ...run,
      summary: chatSummary(run.summary),
      rawOutput: eventText(run.rawOutput),
    })),
    approvals: db.approvals,
    steeringMessages: db.steeringMessages.map((message) => ({
      ...message,
      content: eventText(message.content),
    })),
    handoffs: db.handoffs,
    artifacts: db.artifacts,
    previewServers: db.previewServers,
    experimentRuns: db.experimentRuns,
    githubExports: db.githubExports,
    playbooks: db.playbooks,
    skills: db.skills,
    skillActivations: db.skillActivations,
    userMemories: db.userMemories,
    projectMemories: db.projectMemories,
    commandReceipts: db.commandReceipts,
    eventLog: db.eventLog.map((event) => ({
      ...event,
      payload: Object.fromEntries(
        Object.entries(event.payload).map(([key, value]) => [key, typeof value === "string" ? eventText(value) : value])
      ),
    })),
  };
}

export async function mutateDatabase<T>(mutator: DbMutator<T>): Promise<T> {
  return withLock(async () => {
    const db = await readDatabase();
    const result = mutator(db);
    await writeDatabase(db);
    return result;
  });
}

export async function resetDatabase(): Promise<AppDatabase> {
  return withLock(async () => {
    const config = getConfig();
    const backupFile = `${config.dbFile}.backup-${nowIso().replace(/[:.]/g, "-")}`;
    await copyFile(config.dbFile, backupFile).catch((error: unknown) => {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") {
        throw error;
      }
    });
    const db = createEmptyDatabase();
    await writeDatabase(db);
    return db;
  });
}

export async function getDatabaseSnapshot(): Promise<AppDatabase> {
  return readDatabase();
}

export function updateWorkSessionTimestamp(workSession: WorkSessionRecord): void {
  workSession.updatedAt = nowIso();
}

export function createChatMessage(input: Omit<ChatMessageRecord, "id" | "createdAt" | "attachments"> & Partial<Pick<ChatMessageRecord, "attachments">>): ChatMessageRecord {
  return {
    id: createId(),
    createdAt: nowIso(),
    attachments: [],
    ...input,
  };
}

export function createEvent(input: Omit<EventRecord, "id" | "createdAt" | "eventVersion" | "priority"> & { eventVersion?: number; priority?: EventPriority }): EventRecord {
  return {
    id: createId(),
    eventVersion: input.eventVersion ?? 1,
    priority: input.priority ?? defaultEventPriority(input.eventName),
    createdAt: nowIso(),
    workSessionId: input.workSessionId,
    projectId: input.projectId,
    chatSessionId: input.chatSessionId,
    eventName: input.eventName,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    producer: input.producer,
    context: input.context,
    payload: input.payload,
  };
}

export function createCommandReceiptRecord(input: Omit<CommandReceiptRecord, "id" | "createdAt" | "updatedAt">): CommandReceiptRecord {
  const createdAt = nowIso();
  return {
    id: createId(),
    createdAt,
    updatedAt: createdAt,
    ...input,
  };
}

export function createPlanRecord(input: Omit<PlanRecord, "id" | "createdAt">): PlanRecord {
  return {
    id: createId(),
    createdAt: nowIso(),
    ...input,
  };
}

export function createTaskRecord(
  input: Omit<TaskRecord, "id" | "attemptCount" | "lastFailureSummary" | "lastFailureFingerprint" | "acceptanceEvidence"> &
    Partial<Pick<TaskRecord, "attemptCount" | "lastFailureSummary" | "lastFailureFingerprint" | "acceptanceEvidence">>
): TaskRecord {
  return {
    id: createId(),
    attemptCount: input.attemptCount ?? 0,
    lastFailureSummary: input.lastFailureSummary ?? null,
    lastFailureFingerprint: input.lastFailureFingerprint ?? null,
    acceptanceEvidence: input.acceptanceEvidence ?? input.acceptanceCriteria.map((criterion) => ({
      criterion,
      status: "unknown",
      source: "manual_note",
      note: "No evidence recorded yet.",
      updatedAt: nowIso(),
    })),
    ...input,
  };
}

export function createAgentRunRecord(input: Omit<AgentRunRecord, "id" | "startedAt" | "endedAt">): AgentRunRecord {
  return {
    id: createId(),
    startedAt: nowIso(),
    endedAt: null,
    ...input,
  };
}

export function createToolRunRecord(input: Omit<ToolRunRecord, "id" | "startedAt" | "endedAt">): ToolRunRecord {
  return {
    id: createId(),
    startedAt: nowIso(),
    endedAt: null,
    ...input,
  };
}

export function createCodeChangeRecord(input: Omit<CodeChangeRecord, "id" | "createdAt">): CodeChangeRecord {
  return {
    id: createId(),
    createdAt: nowIso(),
    ...input,
  };
}

export function createCheckpointRecord(input: Omit<CheckpointRecord, "id" | "createdAt"> & Partial<Pick<CheckpointRecord, "id" | "createdAt">>): CheckpointRecord {
  return {
    ...input,
    id: input.id ?? createId(),
    createdAt: input.createdAt ?? nowIso(),
  };
}

export function createVerificationRunRecord(
  input: Omit<VerificationRunRecord, "id" | "startedAt" | "endedAt" | "failureKind"> &
    Partial<Pick<VerificationRunRecord, "failureKind">>
): VerificationRunRecord {
  return {
    id: createId(),
    startedAt: nowIso(),
    endedAt: null,
    failureKind: input.failureKind ?? "none",
    ...input,
  };
}

export function createApprovalRecord(input: Omit<ApprovalRecord, "id" | "requestedAt" | "resolvedAt" | "resolvedBy">): ApprovalRecord {
  return {
    id: createId(),
    requestedAt: nowIso(),
    resolvedAt: null,
    resolvedBy: null,
    ...input,
  };
}

export function createSteeringMessageRecord(input: Omit<SteeringMessageRecord, "id" | "createdAt" | "appliedAt" | "attachments"> & Partial<Pick<SteeringMessageRecord, "appliedAt" | "attachments">>): SteeringMessageRecord {
  return {
    id: createId(),
    createdAt: nowIso(),
    appliedAt: input.appliedAt ?? null,
    attachments: [],
    ...input,
  };
}

export function createHandoffRecord(input: Omit<HandoffRecord, "id" | "createdAt">): HandoffRecord {
  return {
    id: createId(),
    createdAt: nowIso(),
    ...input,
  };
}

export function createArtifactRecord(input: Omit<ArtifactRecord, "id" | "createdAt">): ArtifactRecord {
  return {
    id: createId(),
    createdAt: nowIso(),
    ...input,
  };
}

export function createPreviewServerRecord(input: Omit<PreviewServerRecord, "id" | "startedAt" | "stoppedAt" | "lastHealthCheckAt">): PreviewServerRecord {
  return {
    id: createId(),
    startedAt: nowIso(),
    stoppedAt: null,
    lastHealthCheckAt: null,
    idleExpiresAt: null,
    stoppedReason: null,
    ...input,
  };
}

export function createExperimentRunRecord(
  input: Omit<ExperimentRunRecord, "id" | "startedAt" | "endedAt"> &
    Partial<Pick<ExperimentRunRecord, "endedAt">>
): ExperimentRunRecord {
  return {
    id: createId(),
    startedAt: nowIso(),
    endedAt: input.endedAt ?? null,
    ...input,
  };
}

export function createGithubExportRecord(input: Omit<GithubExportRecord, "id" | "createdAt" | "updatedAt">): GithubExportRecord {
  const createdAt = nowIso();
  return {
    id: createId(),
    createdAt,
    updatedAt: createdAt,
    ...input,
  };
}

export function createPlaybookRecord(input: Omit<PlaybookRecord, "id" | "createdAt" | "updatedAt">): PlaybookRecord {
  const createdAt = nowIso();
  return {
    id: createId(),
    createdAt,
    updatedAt: createdAt,
    ...input,
  };
}

export function createSkillRecord(input: Omit<SkillRecord, "id" | "createdAt" | "updatedAt" | "lastLoadedAt">): SkillRecord {
  const createdAt = nowIso();
  return {
    id: createId(),
    createdAt,
    updatedAt: createdAt,
    lastLoadedAt: createdAt,
    ...input,
  };
}

export function createSkillActivationRecord(input: Omit<SkillActivationRecord, "id" | "createdAt">): SkillActivationRecord {
  return {
    id: createId(),
    createdAt: nowIso(),
    ...input,
  };
}

export function createProjectMemoryRecord(input: Omit<ProjectMemoryRecord, "id" | "createdAt" | "updatedAt" | "lastInjectedAt"> & Partial<Pick<ProjectMemoryRecord, "lastInjectedAt">>): ProjectMemoryRecord {
  const createdAt = nowIso();
  return {
    id: createId(),
    createdAt,
    updatedAt: createdAt,
    lastInjectedAt: input.lastInjectedAt ?? null,
    ...input,
  };
}

export function createUserMemoryRecord(input: Omit<UserMemoryRecord, "id" | "createdAt" | "updatedAt" | "lastInjectedAt" | "sourceKind"> & Partial<Pick<UserMemoryRecord, "lastInjectedAt">>): UserMemoryRecord {
  const createdAt = nowIso();
  return {
    id: createId(),
    createdAt,
    updatedAt: createdAt,
    lastInjectedAt: input.lastInjectedAt ?? null,
    sourceKind: "user",
    ...input,
  };
}

export function markEnded<T extends { endedAt: string | null }>(record: T): void {
  record.endedAt = nowIso();
}

export function currentTimestamp(): string {
  return nowIso();
}
