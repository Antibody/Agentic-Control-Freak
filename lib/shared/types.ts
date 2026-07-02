export type Identifier = string;

export type AgentProvider = "codex-cli" | "ollama" | "claude-code" | "antigravity-cli";
export type PlannerProvider = "codex-cli";
export type ChatRole = "user" | "assistant" | "system" | "tool";
export type ChatSessionStatus = "active" | "archived" | "closed";
export type WorkSessionState =
  | "intake"
  | "clarifying"
  | "planning"
  | "awaiting_approval"
  | "queued"
  | "executing"
  | "verifying"
  | "blocked"
  | "handoff_needed"
  | "completed"
  | "failed"
  | "canceled";
export type PlanStatus = "draft" | "approved" | "superseded" | "completed" | "canceled";
export type TaskStatus = "todo" | "in_progress" | "blocked" | "done" | "skipped";
export type AgentRunStatus = "starting" | "running" | "blocked" | "waiting_approval" | "completed" | "failed" | "canceled";
export type AgentRole = "planner" | "architect" | "executor" | "reviewer" | "researcher" | "verifier";
export type ToolRunStatus = "started" | "completed" | "failed";
export type VerificationStatus = "running" | "passed" | "failed";
export type VerificationFailureKind =
  | "none"
  | "source_failure"
  | "verification_contract_failure"
  | "environment_failure"
  | "dependency_failure"
  | "functional_failure"
  | "visual_failure";
export type ApprovalKind =
  | "command"
  | "file_write"
  | "network"
  | "plan"
  | "merge"
  | "dangerous_action"
  | "codex_command"
  | "codex_file_change"
  | "codex_permissions"
  | "codex_tool_input"
  | "codex_mcp_elicitation";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type SteeringMessageStatus = "pending" | "applied" | "superseded" | "canceled";
export type SteeringApplyMode = "next_boundary" | "restart_current_task" | "live_steer_attempted";
export type CodexTransportMode = "auto" | "app-server-only" | "exec-only";
export type ArtifactKind = "plan" | "verification" | "handoff" | "log" | "patch" | "report" | "screenshot" | "image" | "file";
export type PreviewStatus = "starting" | "ready" | "failed" | "stopped" | "unavailable";
export type PreviewRestartPolicy = "hard_restart" | "refresh_existing_or_start" | "reuse_if_safe_with_hard_fallback";
export type PreviewServerReloadMode = "hmr" | "watcher" | "static" | "plain_process" | "rerun";
export type PreviewStoppedReason = "manual" | "restart" | "process_exit" | "idle_timeout" | "health_failed" | "aborted" | "unavailable";
export type ProjectStack =
  | "static-html"
  | "next"
  | "vite-react"
  | "node-cli"
  | "node-express"
  | "python-script"
  | "python-ml"
  | "python-flask"
  | "python-django"
  | "r-script"
  | "r-shiny"
  | "go"
  | "rust"
  | "csharp"
  | "java"
  | "php"
  | "ruby"
  | "unknown";
export type PreviewAppType = ProjectStack | "node";
export type RuntimeKind = "codex" | "ollama" | "claude" | "antigravity";
export type IntentKind = "clarify" | "plan" | "execute" | "resume" | "explain" | "review" | "cancel" | "handoff" | "approval-response";
export type WorkSessionDeliveryKind = "implementation" | "research";
export type ActivityKind =
  | "runtime_check"
  | "preparing_prompt"
  | "running_runtime"
  | "researching_repo"
  | "searching_web"
  | "reading_files"
  | "editing_files"
  | "running_command"
  | "dependency_research"
  | "installing_dependencies"
  | "verifying"
  | "preview"
  | "snapshot"
  | "preparing_report"
  | "finishing"
  | "waiting";
export type WorkspaceSelectionSource = "generated" | "manual";
export type WorkspaceRiskLevel = "none" | "low" | "medium" | "high";
export type ExecutionMode = "single-owner" | "parallel" | "resume";
export type AutonomyLevel = "manual" | "checkpoint" | "supervised" | "full_auto";
export type CodeChangeKind = "create" | "update" | "delete" | "rename";
export type CheckpointTrigger =
  | "baseline"
  | "plan_approved"
  | "pre_task"
  | "post_task"
  | "pre_restore"
  | "restore"
  | "pre_surgical_revert"
  | "surgical_revert"
  | "manual";
export type CheckpointStatus = "active" | "restored" | "superseded";
export type EventPriority = "low" | "normal" | "high" | "critical";
export type AcceptanceEvidenceStatus = "unknown" | "satisfied" | "failed" | "not_machine_verifiable";
export type AcceptanceEvidenceSource =
  | "code_change"
  | "verification_run"
  | "agent_summary"
  | "manual_note"
  | "dom_assertion"
  | "functional_test"
  | "geometry_check"
  | "visual_judgment";
export type PlanTaskKind = "inspect" | "create" | "modify" | "wire" | "style" | "verify" | "handoff";
export type RiskLevel = "low" | "medium" | "high";
export type DomainEventName =
  | "chat.message.received"
  | "chat.message.stream.delta"
  | "chat.message.stream.completed"
  | "intent.classified"
  | "workspace.selected"
  | "workspace.reset_to_generated"
  | "workspace.selection.canceled"
  | "workspace.safety.blocked"
  | "project.import.started"
  | "project.import.completed"
  | "project.import.failed"
  | "session.started"
  | "session.resumed"
  | "session.blocked"
  | "session.provider_quota_paused"
  | "session.failed"
  | "session.finished"
  | "session.canceled"
  | "session.forked"
  | "github.auth.started"
  | "github.auth.completed"
  | "github.auth.failed"
  | "github.export.prepared"
  | "github.export.started"
  | "github.export.repo_resolved"
  | "github.export.commit_created"
  | "github.export.completed"
  | "github.export.failed"
  | "clarification.requested"
  | "clarification.answered"
  | "plan.created"
  | "plan.updated"
  | "plan.approved"
  | "plan.rejected"
  | "plan.superseded"
  | "plan.stack.mismatch"
  | "plan.stack.changed"
  | "task.queued"
  | "task.started"
  | "task.progress"
  | "task.blocked"
  | "task.timeout.needs_decision"
  | "task.completed"
  | "task.failed"
  | "task.render_regression"
  | "agent.started"
  | "agent.preflight.started"
  | "agent.preflight.passed"
  | "agent.preflight.failed"
  | "agent.process.started"
  | "agent.prompt.prepared"
  | "agent.process.output.delta"
  | "agent.process.exited"
  | "agent.completed"
  | "agent.failed"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "code.change.detected"
  | "checkpoint.created"
  | "checkpoint.restored"
  | "checkpoint.surgical_reverted"
  | "checkpoint.failed"
  | "verification.started"
  | "verification.commands.resolved"
  | "verification.command.started"
  | "verification.command.output.delta"
  | "verification.command.passed"
  | "verification.command.skipped"
  | "verification.command.failed"
  | "verification.passed"
  | "verification.failed"
  | "snapshot.started"
  | "snapshot.dom.captured"
  | "snapshot.screenshot.captured"
  | "snapshot.completed"
  | "snapshot.failed"
  | "snapshot.attached_to_verification"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "handoff.created"
  | "handoff.accepted"
  | "preview.starting"
  | "preview.ready"
  | "preview.failed"
  | "preview.stopped"
  | "experiment.started"
  | "experiment.phase"
  | "experiment.metric"
  | "experiment.completed"
  | "experiment.failed"
  | "experiment.aborted"
  | "steering.received"
  | "steering.queued"
  | "steering.applied"
  | "steering.superseded"
  | "steering.canceled"
  | "steering.apply_now_requested"
  | "skill.discovered"
  | "skill.changed"
  | "skill.activated"
  | "skill.disabled"
  | "skill.deleted"
  | "skill.imported"
  | "skill.trust_required"
  | "user.memory.changed"
  | "project.memory.changed"
  | "runtime.usage.updated"
  | "runtime.rateLimits.updated"
  | "runtime.compaction.observed"
  | "runtime.compaction.started"
  | "codex.collab.started"
  | "codex.collab.completed"
  | "codex.subagent.spawned"
  | "codex.subagent.status"
  | "codex.thread.rollback"
  | "ui.toast"
  | "ui.badge.updated"
  | "ui.timeline.appended";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface AcceptanceCriterionEvidence {
  criterion: string;
  status: AcceptanceEvidenceStatus;
  source: AcceptanceEvidenceSource;
  note: string;
  updatedAt: string;
}

export interface CheckSpec {
  id: Identifier;
  criterion: string;
  kind: "structural" | "interaction" | "geometry" | "visual";
  locator: {
    role?: string;
    name?: string;
    text?: string;
    selector?: string;
  };
  action?: {
    type: "click" | "fill" | "navigate";
    value?: string;
  };
  expect: {
    exists?: boolean;
    visible?: boolean;
    textEquals?: string;
    textChanges?: boolean;
    domDelta?: boolean;
  };
  createdBy: "orchestrator" | "agent";
  locked: boolean;
}

export interface FunctionalCheckResult {
  specId: Identifier;
  status: "passed" | "failed" | "skipped";
  observed: JsonObject;
  screenshotArtifactId?: Identifier;
  domArtifactId?: Identifier;
  consoleErrors: string[];
  note: string;
}

export interface ProgressVector {
  criteriaSatisfied: number;
  functionalChecksPassing: number;
  verificationErrorCount: number;
  distinctFingerprints: number;
}

export interface WorkSessionBudget {
  timeMsSpent: number;
  costUsdSpent: number;
  strategiesTried: number;
}

export interface UserRecord {
  id: Identifier;
  email: string;
  name: string;
  createdAt: string;
}

export interface ProjectRecord {
  id: Identifier;
  ownerUserId: Identifier;
  name: string;
  slug: string;
  repoUrl: string;
  localRepoPath: string;
  defaultBranch: string;
  trusted: boolean;
  workspaceSelection: WorkspaceSelectionMetadata;
  createdAt: string;
}

export interface WorkspaceSelectionMetadata {
  source: WorkspaceSelectionSource;
  selectedAt: string;
  selectedPath: string;
  riskLevel: WorkspaceRiskLevel;
  riskReasons: string[];
  detectedStack: ProjectStack | "unknown";
  isEmpty: boolean;
}

export interface RuntimeProfileRecord {
  id: Identifier;
  projectId: Identifier;
  name: string;
  runtimeKind: RuntimeKind;
  provider: AgentProvider;
  model: string;
  approvalPolicy: string;
  sandboxMode: string;
  writableRoots: string[];
  extraConfig: JsonObject;
  createdAt: string;
}

export interface ChatSessionRecord {
  id: Identifier;
  projectId: Identifier;
  title: string;
  status: ChatSessionStatus;
  createdBy: Identifier;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRecord {
  id: Identifier;
  chatSessionId: Identifier;
  role: ChatRole;
  content: string;
  messageKind: string;
  attachments: ChatAttachment[];
  relatedEventId: Identifier | null;
  createdAt: string;
}

export interface ChatAttachment {
  id: Identifier;
  artifactId: Identifier;
  kind: "image" | "pdf" | "document" | "spreadsheet" | "presentation";
  originalName: string;
  mimeType: string;
  byteSize: number;
  workspacePath: string;
  absolutePath: string;
  extractedWorkspacePath: string | null;
  extractedAbsolutePath: string | null;
  extractedSummary: string | null;
}

export type StackDecisionSource = "user" | "planner" | "heuristic" | "workspace";

export interface StackDecision {
  stack: ProjectStack;
  source: StackDecisionSource;
  confidence: "high" | "medium" | "low";
  rationale: string;
  decidedAt: string;
}

export interface WorkSessionRecord {
  id: Identifier;
  projectId: Identifier;
  chatSessionId: Identifier;
  runtimeProfileId: Identifier;
  currentState: WorkSessionState;
  activeBranch: string;
  activeWorktreePath: string;
  activePlanId: Identifier | null;
  startedBy: Identifier;
  startedAt: string;
  updatedAt: string;
  lastUserMessage: string;
  deliveryKind: WorkSessionDeliveryKind;
  planModeEnabled: boolean;
  executionMode: ExecutionMode;
  autonomyLevel: AutonomyLevel;
  paused: boolean;
  awaitingStep: boolean;
  nextActionLabel: string | null;
  pythonRunParams: PythonRunParams | null;
  rRunParams: RRunParams | null;
  mlRunConfig?: MlRunConfig | null;
  activeExperimentRunId?: Identifier | null;
  agentProvider: AgentProvider | null;
  runtimeOverrides: RuntimeOverrides | null;
  runtimeUsage: RuntimeUsageSnapshot | null;
  claudeSessionId: string | null;
  codexThreadId: string | null;
  codexLastTurnId?: string | null;
  forkedFromCodexThreadId?: string | null;
  nativeCodexForkedAt?: string | null;
  stackDecision?: StackDecision | null;
  scaffoldManifest?: string[] | null;
  previewFirstServableAt?: string | null;
  codexSubagents?: CodexSubagentRecord[];
  codexCollabCalls?: CodexCollabCallRecord[];
  transcriptRef: string | null;
  steeringNote: string;
  budget: WorkSessionBudget | null;
  lastProgress: ProgressVector | null;
  checkpointRef: string | null;
  historyBaseCheckpointId: Identifier | null;
  historyBaseCheckpointCreatedAt: string | null;
  historyRestoredAt: string | null;
  forkedFromWorkSessionId: Identifier | null;
  forkedFromCheckpointId: Identifier | null;
  forkedAt: string | null;
}

export type CodexCollabTool = "spawnAgent" | "sendInput" | "resumeAgent" | "wait" | "closeAgent" | "unknown";
export type CodexCollabCallStatus = "inProgress" | "completed" | "failed" | "stale" | "unknown";
export type CodexSubagentStatus = "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound" | "unknown";

export interface CodexCollabAgentState {
  status: CodexSubagentStatus;
  message: string | null;
}

export interface CodexCollabCallRecord {
  id: Identifier;
  workSessionId: Identifier;
  agentRunId: Identifier | null;
  rootThreadId: string | null;
  turnId: string | null;
  tool: CodexCollabTool;
  status: CodexCollabCallStatus;
  senderThreadId: string | null;
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agentsStates: Record<string, CodexCollabAgentState>;
  failureReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  raw: JsonObject;
}

export interface CodexSubagentRecord {
  threadId: string;
  parentThreadId: string | null;
  rootThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  status: CodexSubagentStatus;
  lastMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodexNativeThreadTreeNode {
  threadId: string;
  parentThreadId: string | null;
  agentNickname: string | null;
  agentRole: string | null;
  status: CodexSubagentStatus;
  lastMessage: string | null;
  children: CodexNativeThreadTreeNode[];
}

export interface TranscriptTurnRecord {
  agentRunId?: Identifier;
  taskId?: Identifier | null;
  provider: RuntimeKind;
  model: string;
  role: AgentRole;
  finalText: string;
  toolCalls?: JsonObject[];
  reasoning?: string;
  ts: string;
}

export type ReasoningEffort = string;
export type ExecutorSandboxMode = "workspace-write" | "danger-full-access";
export type RuntimeServiceTier = string;

export interface RuntimeOverrides {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  serviceTier: RuntimeServiceTier | null;
  sandboxMode: ExecutorSandboxMode | null;
  networkAccess: boolean | null;
  codexTransportMode: CodexTransportMode | null;
  timeoutMs: number | null;
  temperature: number | null;
  numCtx: number | null;
  ultracode: boolean | null;
}

export interface CodexReasoningLevelOption {
  effort: string;
  description: string | null;
}

export interface RuntimeServiceTierOption {
  id: string;
  name: string;
  description: string | null;
}

export interface CodexModelOption {
  slug: string;
  displayName: string;
  description: string | null;
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: CodexReasoningLevelOption[];
  supportedInApi: boolean;
  visibility: string;
  priority: number;
  contextWindow: number | null;
  serviceTiers: RuntimeServiceTierOption[];
  defaultServiceTier: string | null;
}


export type RuntimeQuotaScope = "account" | "bucket" | "cost" | "none";
export type RuntimeContextScope = "live-thread" | "last-run" | "estimate" | "catalog" | "unknown";
export type RuntimeStatusSource = "live" | "cache" | "unsupported" | "empty";
export type RuntimeDiagnosticStatus = "ok" | "degraded" | "unavailable" | "unknown";
export type ToolMutability = "read" | "write" | "delete" | "finish";
export type ToolPolicyMode = "plan" | "research" | "execute" | "repair";
export type ToolRiskLevel = "low" | "medium" | "high";
export type PlaybookStatus = "draft" | "approved" | "archived";
export type SkillSourceType = "app-md" | "codex-skill" | "custom-md" | "remote-skills-md" | "plugin";
export type SkillSourceScope = "app" | "workspace" | "user" | "remote";
export type SkillActivationMode = "explicit" | "implicit" | "pinned";
export type ProjectMemoryScope = "project" | "session" | "lineage";
export type ProjectMemoryCategory = "architecture" | "style" | "constraint" | "verification" | "decision" | "handoff";
export type ProjectMemoryStatus = "active" | "candidate" | "dismissed";
export type ProjectMemorySourceKind = "agent_run" | "transcript" | "handoff" | "user" | "verification" | "artifact";
export type UserMemoryStatus = "active" | "dismissed";

export interface RuntimeQuotaWindow {
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export interface RuntimeQuotaBucket {
  id: string;
  label: string | null;
  planType: string | null;
  windows: RuntimeQuotaWindow[];
  creditsBalance: string | null;
}

export interface RuntimeQuotaStatus {
  scope: RuntimeQuotaScope;
  buckets: RuntimeQuotaBucket[];
  costUsd: number | null;
  note: string;
}

export interface RuntimeContextStatus {
  usedTokens: number | null;
  contextWindow: number | null;
  remainingTokens: number | null;
  scope: RuntimeContextScope;
  model: string | null;
  note: string;
  details?: RuntimeContextDetails | null;
}

export interface RuntimeContextCategory {
  label: string;
  tokens: number | null;
  percent: number | null;
}

export interface RuntimeContextReference {
  section: string;
  label: string;
  tokens: number | null;
}

export interface RuntimeContextDetails {
  source: "claude-context";
  modelLabel: string | null;
  modelSlug: string | null;
  percentUsed: number | null;
  freeTokens: number | null;
  categories: RuntimeContextCategory[];
  references: RuntimeContextReference[];
}

export interface RuntimeCompactionStatus {
  supported: boolean;
  manualCompaction: boolean;
  canManualCompact: boolean;
  autoObserved: boolean;
  lastCompactionAt: string | null;
  trigger: "auto" | "manual" | null;
  note: string;
}

export interface RuntimeDiagnostic {
  id: string;
  label: string;
  status: RuntimeDiagnosticStatus;
  detail: string;
}

export interface RuntimeStatus {
  provider: AgentProvider;
  model: string | null;
  quota: RuntimeQuotaStatus;
  context: RuntimeContextStatus;
  compaction: RuntimeCompactionStatus;
  diagnostics?: RuntimeDiagnostic[];
  source: RuntimeStatusSource;
  fetchedAt: string | null;
  error: string | null;
}

export interface RuntimeUsageSnapshot {
  provider: AgentProvider;
  model: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  contextWindow: number | null;
  costUsd: number | null;
  threadId: string | null;
  sessionId: string | null;
  compactionTrigger: "auto" | "manual" | null;
  compactionAt: string | null;
  updatedAt: string;
}

export interface CodexRuntimeOptions {
  models: CodexModelOption[];
  defaults: {
    model: string | null;
    reasoningEffort: string | null;
    sandboxMode: ExecutorSandboxMode;
    networkAccess: boolean | null;
    timeoutMs: number;
    serviceTier: string | null;
    codexTransportMode?: CodexTransportMode | null;
  };
  source: "live" | "observed" | "cache" | "bundled" | "native" | "native+live" | "empty";
  fetchedAt: string | null;
  error: string | null;
  native?: {
    source: "app-server";
    models: boolean;
    permissionProfiles: boolean;
    collaborationModes: boolean;
    configRequirements: boolean;
    error: string | null;
  } | null;
}

export type PythonFigureFormat = "png" | "svg" | "jpeg";

export interface PythonRunParams {
  entrypoint: string | null;
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  matplotlib: {
    dpi: number | null;
    format: PythonFigureFormat | null;
    style: string | null;
  };
}

export interface PythonEntrypointOption {
  file: string;
  score: number;
}

export type RFigureFormat = "png" | "svg" | "jpeg" | "pdf";

export interface RRunParams {
  entrypoint: string | null;
  argv: string[];
  stdin: string;
  env: Record<string, string>;
  graphics: {
    dpi: number | null;
    format: RFigureFormat | null;
    width: number | null;
    height: number | null;
  };
}

export type REntrypointOption = PythonEntrypointOption;

export type MlRunRegime = "smoke" | "short" | "full" | "calibration";
export type MlDevice = "auto" | "cpu" | "cuda" | "mps";
export type MlPrecision = "fp32" | "fp16" | "bf16" | "int8" | "int4";

export type MlDatasetMode =
  | "builtin"
  | "single_corpus"
  | "train_test"
  | "train_val_test"
  | "jsonl_finetune"
  | "custom";
export type MlDatasetFormat = "auto" | "text" | "jsonl" | "csv" | "image_folder" | "other";

export interface MlDatasetConfig {
  mode: MlDatasetMode;
  format: MlDatasetFormat;
  trainPath: string | null;
  valPath: string | null;
  testPath: string | null;
  corpusPath: string | null;
}

export interface MlDataContract {
  recommendedMode: MlDatasetMode;
  supportedModes: MlDatasetMode[];
  format: MlDatasetFormat;
  accept: string | null;
  builtinFallback: boolean;
  guidance: string;
}

export interface MlRunConfig {
  seed: number;
  device: MlDevice;
  regime: MlRunRegime;
  maxSteps: number | null;
  epochs: number | null;
  batchSize: number | null;
  gradAccum: number | null;
  precision: MlPrecision;
  subsetLimit: number | null;
  lr: number | null;
  blockSize: number | null;
  embedDim: number | null;
  hiddenDim: number | null;
  numLayers: number | null;
  decode: {
    temperature: number | null;
    topP: number | null;
    maxNewTokens: number | null;
    greedy: boolean;
  };
  dataset: MlDatasetConfig;
  extra: Record<string, string>;
}

export type ExperimentRunStatus = "queued" | "running" | "succeeded" | "failed" | "aborted";

export interface ExperimentRunRecord {
  id: Identifier;
  workSessionId: Identifier;
  taskId: Identifier | null;
  regime: MlRunRegime;
  status: ExperimentRunStatus;
  config: MlRunConfig;
  entrypoint: string | null;
  datasetRef: string | null;
  metricsArtifactId: Identifier | null;
  reportArtifactId: Identifier | null;
  checkpointArtifactIds: Identifier[];
  hardware: JsonObject | null;
  libraryVersions: JsonObject | null;
  primaryMetric: { name: string; value: number; split: string; goal?: "max" | "min" } | null;
  summary: string;
  failureSummary: string | null;
  intendedDevice?: MlDevice;
  effectiveDevice?: MlDevice | null;
  deviceMismatch?: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface PlanTaskInput {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  objective?: string;
  taskKind?: PlanTaskKind;
  targetFiles?: string[];
  expectedChanges?: string[];
  verificationHints?: string[];
  riskLevel?: RiskLevel;
}

export interface PlanJson {
  schemaVersion?: number;
  title: string;
  goal: string;
  targetStack?: ProjectStack;
  stackRationale?: string;
  risks: string[];
  verificationCommands: string[];
  tasks: PlanTaskInput[];
  workspace?: JsonObject;
}

export interface PlanRecord {
  id: Identifier;
  workSessionId: Identifier;
  version: number;
  title: string;
  goal: string;
  status: PlanStatus;
  planMarkdown: string;
  planJson: PlanJson;
  createdByAgent: string;
  createdAt: string;
  approvedAt: string | null;
  approvalCheckpointId: Identifier | null;
}

export interface TaskRecord {
  id: Identifier;
  planId: Identifier;
  parentTaskId: Identifier | null;
  ordinal: number;
  title: string;
  description: string;
  status: TaskStatus;
  acceptanceCriteria: string[];
  metadata: JsonObject;
  attemptCount: number;
  lastFailureSummary: string | null;
  lastFailureFingerprint: string | null;
  acceptanceEvidence: AcceptanceCriterionEvidence[];
}

export interface AgentRunRecord {
  id: Identifier;
  workSessionId: Identifier;
  taskId: Identifier | null;
  role: AgentRole;
  runtimeKind: RuntimeKind;
  model: string;
  status: AgentRunStatus;
  startedAt: string;
  endedAt: string | null;
  summary: string;
  codexThreadId?: string | null;
  codexTurnId?: string | null;
  codexTransport?: "exec" | "app-server" | null;
}

export interface ToolRunRecord {
  id: Identifier;
  agentRunId: Identifier;
  toolName: string;
  status: ToolRunStatus;
  input: JsonObject;
  output: JsonObject;
  startedAt: string;
  endedAt: string | null;
}

export interface CodeChangeRecord {
  id: Identifier;
  agentRunId: Identifier;
  filePath: string;
  changeKind: CodeChangeKind;
  diffExcerpt: string;
  createdAt: string;
}

export interface SessionChangedFile {
  filePath: string;
  previousPath: string | null;
  changeKind: CodeChangeKind;
  additions?: number | null;
  deletions?: number | null;
  binary?: boolean;
}

export interface SessionChangeSet {
  workSessionId: Identifier;
  handoffId: Identifier;
  source: "checkpoint" | "recorded_changes";
  baseCheckpointId: Identifier | null;
  targetCheckpointId: Identifier | null;
  files: SessionChangedFile[];
}

export interface SessionFileDiff {
  workSessionId: Identifier;
  handoffId: Identifier;
  filePath: string;
  source: "checkpoint" | "recorded_changes";
  diff: string;
  additions?: number | null;
  deletions?: number | null;
  binary?: boolean;
  hunks?: number;
}

export interface CheckpointRecord {
  id: Identifier;
  workSessionId: Identifier;
  taskId: Identifier | null;
  agentRunId: Identifier | null;
  trigger: CheckpointTrigger;
  status: CheckpointStatus;
  refName: string;
  commitHash: string;
  previousCheckpointId: Identifier | null;
  restoredFromCheckpointId: Identifier | null;
  summary: string;
  filesChanged: number;
  createdAt: string;
  codexThreadId?: string | null;
  codexTurnId?: string | null;
  codexTurnOrdinal?: number | null;
}

export interface VerificationCommandResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  status: "passed" | "failed" | "skipped";
  stdoutTail: string;
  stderrTail: string;
}

export interface VerificationRunRecord {
  id: Identifier;
  workSessionId: Identifier;
  planId: Identifier | null;
  status: VerificationStatus;
  failureKind: VerificationFailureKind;
  commands: string[];
  summary: string;
  rawOutput: string;
  commandResults?: VerificationCommandResult[];
  startedAt: string;
  endedAt: string | null;
  previewId?: Identifier | null;
}

export interface ApprovalRecord {
  id: Identifier;
  workSessionId: Identifier;
  agentRunId: Identifier | null;
  approvalKind: ApprovalKind;
  reason: string;
  payload: JsonObject;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: Identifier | null;
  externalRequestId?: string | null;
  externalRequestMethod?: string | null;
  codexThreadId?: string | null;
  codexTurnId?: string | null;
}

export interface SteeringMessageRecord {
  id: Identifier;
  workSessionId: Identifier;
  chatSessionId: Identifier;
  taskId: Identifier | null;
  agentRunId: Identifier | null;
  content: string;
  attachments: ChatAttachment[];
  status: SteeringMessageStatus;
  applyMode: SteeringApplyMode;
  createdAt: string;
  appliedAt: string | null;
  delivery?: "queued" | "live" | "restart" | null;
  codexThreadId?: string | null;
  codexTurnId?: string | null;
  failureReason?: string | null;
}

export interface HandoffRecord {
  id: Identifier;
  workSessionId: Identifier;
  createdByAgentRunId: Identifier | null;
  summaryMarkdown: string;
  openQuestions: string[];
  nextSteps: string[];
  createdAt: string;
}

export interface ArtifactRecord {
  id: Identifier;
  workSessionId: Identifier;
  artifactKind: ArtifactKind;
  storageUri: string;
  metadata: JsonObject;
  createdAt: string;
}

export interface ToolCatalogEntry {
  id: string;
  description: string;
  providerSupport: AgentProvider[];
  mode: ToolPolicyMode[];
  mutability: ToolMutability;
  workspaceScope: "workspace";
  risk: ToolRiskLevel;
  promptCost: "low" | "medium" | "high";
}

export interface PlaybookRecord {
  id: Identifier;
  projectId: Identifier | null;
  workSessionId: Identifier | null;
  title: string;
  trigger: string;
  procedure: string;
  tags: string[];
  status: PlaybookStatus;
  sourceAgentRunId: Identifier | null;
  sourceTaskId: Identifier | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillRecord {
  id: Identifier;
  name: string;
  description: string;
  sourceType: SkillSourceType;
  sourceScope: SkillSourceScope;
  sourcePath: string;
  enabled: boolean;
  allowImplicit: boolean;
  trusted: boolean;
  contentHash: string;
  frontmatter: JsonObject;
  bodyPreview: string;
  displayName: string | null;
  shortDescription: string | null;
  icon: string | null;
  color: string | null;
  diagnostics: string[];
  createdAt: string;
  updatedAt: string;
  lastLoadedAt: string;
}

export interface SkillActivationRecord {
  id: Identifier;
  workSessionId: Identifier;
  skillId: Identifier;
  taskId: Identifier | null;
  agentRunId: Identifier | null;
  activationMode: SkillActivationMode;
  contentHash: string;
  promptArtifactId: Identifier | null;
  createdAt: string;
}

export interface ProjectMemoryRecord {
  id: Identifier;
  projectId: Identifier;
  workSessionId: Identifier | null;
  scope: ProjectMemoryScope;
  category: ProjectMemoryCategory;
  content: string;
  sourceKind: ProjectMemorySourceKind;
  sourceId: Identifier | null;
  sourceProvider: RuntimeKind | null;
  confidence: number;
  status: ProjectMemoryStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  lastInjectedAt: string | null;
}

export interface UserMemoryRecord {
  id: Identifier;
  content: string;
  status: UserMemoryStatus;
  pinned: boolean;
  sourceKind: "user";
  createdAt: string;
  updatedAt: string;
  lastInjectedAt: string | null;
}

export interface PreviewServerRecord {
  id: Identifier;
  workSessionId: Identifier;
  projectId: Identifier;
  workspacePath: string;
  appType: PreviewAppType;
  command: string;
  port: number;
  url: string;
  pid: number | null;
  status: PreviewStatus;
  startedAt: string;
  stoppedAt: string | null;
  lastHealthCheckAt: string | null;
  stdoutTail: string;
  stderrTail: string;
  restartPolicy?: PreviewRestartPolicy;
  serverReloadMode?: PreviewServerReloadMode;
  commandFingerprint?: string;
  refreshRevision?: number;
  lastValidatedAt?: string | null;
  idleExpiresAt?: string | null;
  stoppedReason?: PreviewStoppedReason | null;
  lastFailureReason?: string | null;
  mode?: "probe" | "final";
}

export type GithubExportSourceMode = "current_workspace" | "checkpoint";
export type GithubExportStatus = "prepared" | "running" | "completed" | "failed";
export type GithubRepositoryVisibility = "public" | "private";

export type GithubExportWriteMode = "additive" | "replace";

export interface GithubExportRecord {
  id: Identifier;
  workSessionId: Identifier;
  projectId: Identifier;
  accountLogin: string;
  repoOwner: string;
  repoName: string;
  repoUrl: string;
  htmlUrl: string;
  branch: string;
  visibility: GithubRepositoryVisibility;
  writeMode: GithubExportWriteMode;
  sourceMode: GithubExportSourceMode;
  sourceCheckpointId: Identifier | null;
  status: GithubExportStatus;
  commitSha: string | null;
  treeSha: string | null;
  fileCount: number;
  byteCount: number;
  ignoredCount: number;
  failureSummary: string | null;
  reportArtifactId: Identifier | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventProducer {
  module: string;
  runtimeKind?: RuntimeKind;
  role?: AgentRole;
}

export interface EventContext {
  repoName?: string;
  branch?: string;
  worktreePath?: string;
  planId?: Identifier;
  taskId?: Identifier;
  agentRunId?: Identifier;
  approvalId?: Identifier;
  verificationRunId?: Identifier;
  previewId?: Identifier;
  snapshotId?: Identifier;
}

export interface EventRecord {
  id: Identifier;
  workSessionId: Identifier | null;
  projectId: Identifier | null;
  chatSessionId: Identifier | null;
  eventName: DomainEventName;
  aggregateType: string;
  aggregateId: Identifier | null;
  eventVersion: number;
  priority: EventPriority;
  producer: EventProducer;
  context: EventContext;
  payload: JsonObject;
  createdAt: string;
}

export interface CommandReceiptRecord {
  id: Identifier;
  workSessionId: Identifier;
  idempotencyKey: string;
  commandType: string;
  requestHash: string;
  status: "running" | "completed" | "failed";
  result: JsonObject | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppDatabase {
  users: UserRecord[];
  projects: ProjectRecord[];
  runtimeProfiles: RuntimeProfileRecord[];
  chatSessions: ChatSessionRecord[];
  chatMessages: ChatMessageRecord[];
  workSessions: WorkSessionRecord[];
  plans: PlanRecord[];
  tasks: TaskRecord[];
  agentRuns: AgentRunRecord[];
  toolRuns: ToolRunRecord[];
  codeChanges: CodeChangeRecord[];
  checkpoints: CheckpointRecord[];
  verificationRuns: VerificationRunRecord[];
  approvals: ApprovalRecord[];
  steeringMessages: SteeringMessageRecord[];
  handoffs: HandoffRecord[];
  artifacts: ArtifactRecord[];
  previewServers: PreviewServerRecord[];
  experimentRuns: ExperimentRunRecord[];
  githubExports: GithubExportRecord[];
  playbooks: PlaybookRecord[];
  skills: SkillRecord[];
  skillActivations: SkillActivationRecord[];
  userMemories: UserMemoryRecord[];
  projectMemories: ProjectMemoryRecord[];
  commandReceipts: CommandReceiptRecord[];
  eventLog: EventRecord[];
}

export interface PublicAppState {
  users: UserRecord[];
  projects: ProjectRecord[];
  runtimeProfiles: RuntimeProfileRecord[];
  chatSessions: ChatSessionRecord[];
  chatMessages: ChatMessageRecord[];
  workSessions: WorkSessionRecord[];
  plans: PlanRecord[];
  tasks: TaskRecord[];
  agentRuns: AgentRunRecord[];
  checkpoints: CheckpointRecord[];
  verificationRuns: VerificationRunRecord[];
  approvals: ApprovalRecord[];
  steeringMessages: SteeringMessageRecord[];
  handoffs: HandoffRecord[];
  artifacts: ArtifactRecord[];
  previewServers: PreviewServerRecord[];
  experimentRuns: ExperimentRunRecord[];
  githubExports: GithubExportRecord[];
  playbooks: PlaybookRecord[];
  skills: SkillRecord[];
  skillActivations: SkillActivationRecord[];
  userMemories: UserMemoryRecord[];
  projectMemories: ProjectMemoryRecord[];
  commandReceipts: CommandReceiptRecord[];
  eventLog: EventRecord[];
}

export interface ChatPostRequest {
  content: string;
  projectId?: string;
  chatSessionId?: string;
}

export interface ApprovalPostRequest {
  status: "approved" | "rejected";
  note?: string;
}

export interface PlanEditPostRequest {
  planId: string;
  planJson: PlanJson;
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
