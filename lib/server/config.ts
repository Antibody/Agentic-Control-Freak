import path from "node:path";
import type { AgentProvider, AutonomyLevel, CodexTransportMode, PlannerProvider, ProjectStack } from "@/lib/shared/types";

export type CodexThreadPersistence = "auto" | "per-session" | "per-task";

export interface AppConfig {
  appBaseUrl: string;
  controlPlanePort: number;
  appEnv: string;
  dbFile: string;
  workspaceRoot: string;
  artifactsDir: string;
  agentProvider: AgentProvider;
  plannerProvider: PlannerProvider;
  plannerTimeoutMs: number;
  defaultProjectStack: ProjectStack;
  codexCliBin: string;
  codexExtraArgs: string[];
  codexSandboxMode: string;
  codexApprovalPolicy: string;
  codexTimeoutMs: number;
  codexModel: string;
  codexReasoningEffort: string;
  codexTransportMode: CodexTransportMode;
  codexAppServerFallback: boolean;
  codexNativeThreadPersistence: CodexThreadPersistence;
  codexAppServerExec: boolean;
  codexPersistentThread: boolean;
  codexMultiAgentMaxThreads: number;
  claudeCodeBin: string;
  claudeModel: string;
  claudeFallbackModel: string;
  claudeEffort: string;
  claudeTimeoutMs: number;
  claudeMaxTurns: number;
  claudeMaxTurnsExplicit: boolean;
  claudeTurnBudgetBase: number;
  claudeTurnBudgetPerFile: number;
  claudeTurnBudgetCreateBonus: number;
  claudeTurnBudgetCeiling: number;
  claudePlannerAllowExploration: boolean;
  claudeMaxBudgetUsd: number | null;
  claudePermissionMode: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  claudePermissionModeExplicit: boolean;
  claudePermissionGating: boolean;
  claudeSettingsJson: string;
  claudeSettingSources: string;
  claudeTools: string[];
  claudeDisallowedTools: string[];
  claudeUltracode: boolean;
  claudeUltracodeTools: string[];
  claudeUltracodeMaxTurns: number;
  claudeUltracodeMaxBudgetUsd: number | null;
  claudeAddDirs: string[];
  claudeDisableTaskSlashCommands: boolean;
  claudeBare: boolean;
  claudePersistentSessions: boolean;
  claudeTransportMode: "auto" | "stream" | "text";
  claudeExtraArgs: string[];
  agyCliBin: string;
  agyTimeoutMs: number;
  agySandbox: boolean;
  agyDangerouslySkipPermissions: boolean;
  agyExtraArgs: string[];
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaTimeoutMs: number;
  ollamaMaxIterations: number;
  ollamaPlannerMaxAttempts: number;
  ollamaPlannerNumCtx: number | null;
  ollamaNumCtx: number | null;
  ollamaCompactThreshold: number;
  ollamaTemperature: number;
  ollamaToolsMode: "auto" | "native" | "envelope";
  ollamaKeepAlive: string;
  gitBin: string;
  checkpointsEnabled: boolean;
  autoApprovePlans: boolean;
  defaultAutonomyLevel: AutonomyLevel;
  controllerMaxStepsPerTick: number;
  verifyCommands: string[];
  dependencyTaskAutoclose: "manifest-only" | "legacy";
  dispatchRetryContext: boolean;
  dispatchContinuityContext: boolean;
  shellTimeoutMs: number;
  allowAppRootVerification: boolean;
  previewHost: string;
  previewPortStart: number;
  previewPortEnd: number;
  previewAutoOpen: boolean;
  previewIdleTimeoutMs: number;
  snapshotCaptureEnabled: boolean;
  functionalVerificationEnabled: boolean;
  functionalCheckTimeoutMs: number;
  interactionProbeLevel: "basic" | "extended";
  mlPipelineEnabled: boolean;
  mlJobTimeoutMs: number;
  mlJobHeartbeatIdleMs: number;
  mlSmokeTimeoutMs: number;
  mlDiskBudgetMb: number;
  mlTorchScaffoldMinDiskMb: number;
  mlAllowGpu: boolean;
  mlAllowNetworkDownloads: boolean;
  mlAllowSecrets: boolean;
  mlTrustRemoteCode: boolean;
  mlCacheDir: string;
  venvRoot: string;
  mlGpuUnavailablePolicy: "refuse" | "cpu-downgrade";
  mlDefaultCudaTag: string;
  mlRequireVenvCudaVerify: boolean;
  mlInferenceIdleMs: number;
  mlInferenceTimeoutMs: number;
  mlInferenceMaxUploadMb: number;
  mlDataUploadMaxMb: number;
  mlDataUploadMaxFiles: number;
  mlDataUploadMaxTotalMb: number;
  browserHeadless: boolean;
  visionJudgeEnabled: boolean;
  crossProviderBriefRuns: number;
  crossProviderTranscript: boolean;
  relentlessBudgetMs: number;
  relentlessBudgetUsd: number;
  relentlessMaxStrategies: number;
  telegramControlEnabled: boolean;
  telegramBotToken: string;
  telegramControlAppUrl: string;
  telegramControlWorkerToken: string;
  telegramControlAllowedUserIds: string[];
  telegramControlAllowedChatIds: string[];
  telegramControlGroupsEnabled: boolean;
  telegramControlActivityEvents: boolean;
  telegramControlNotifyEvents: string[];
  telegramControlMaxTextChars: number;
  telegramControlSendPreviewScreenshots: boolean;
  telegramControlMaxScreenshotBytes: number;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = cleanScalarEnvValue(value);
  if (normalized === undefined || normalized === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(normalized.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  const normalized = cleanScalarEnvValue(value);
  if (normalized === undefined || normalized === "") {
    return fallback;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  const normalized = cleanScalarEnvValue(value);
  if (normalized === undefined || normalized === "") {
    return fallback;
  }
  const parsed = Number(normalized);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = parseInteger(value, fallback);
  return Math.max(min, Math.min(max, parsed));
}

function cleanScalarEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function cleanEnumEnvValue(value: string | undefined): string | undefined {
  return cleanScalarEnvValue(value)?.replace(/#.*$/, "").trim();
}

function parseInteractionProbeLevel(value: string | undefined): "basic" | "extended" {
  const normalized = cleanEnumEnvValue(value);
  return normalized === "extended" ? "extended" : "basic";
}

function parseDependencyTaskAutoclose(value: string | undefined): "manifest-only" | "legacy" {
  const normalized = cleanEnumEnvValue(value);
  return normalized === "legacy" ? "legacy" : "manifest-only";
}

function parseGpuUnavailablePolicy(value: string | undefined): "refuse" | "cpu-downgrade" {
  const normalized = cleanEnumEnvValue(value);
  return normalized === "cpu-downgrade" ? "cpu-downgrade" : "refuse";
}

function parseProvider(value: string | undefined): AgentProvider {
  const normalized = cleanEnumEnvValue(value);
  if (normalized === "codex-cli" || normalized === "ollama" || normalized === "claude-code" || normalized === "antigravity-cli") {
    return normalized;
  }
  return "codex-cli";
}

function parsePlannerProvider(value: string | undefined): PlannerProvider | null {
  const normalized = cleanEnumEnvValue(value);
  if (normalized === "codex-cli") {
    return normalized;
  }
  return null;
}

function parseOllamaToolsMode(value: string | undefined): "auto" | "native" | "envelope" {
  const normalized = cleanEnumEnvValue(value);
  if (normalized === "native" || normalized === "envelope" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}

function parseCodexTransportMode(value: string | undefined): CodexTransportMode | null {
  const normalized = cleanEnumEnvValue(value);
  if (normalized === "auto" || normalized === "app-server-only" || normalized === "exec-only") {
    return normalized;
  }
  return null;
}

function resolveCodexTransportMode(): CodexTransportMode {
  const explicit = parseCodexTransportMode(process.env.CODEX_TRANSPORT_MODE);
  if (explicit !== null) {
    return explicit;
  }
  if (process.env.CODEX_APP_SERVER_EXEC !== undefined) {
    return parseBoolean(process.env.CODEX_APP_SERVER_EXEC, false) ? "auto" : "exec-only";
  }
  return "auto";
}

function parseCodexThreadPersistence(value: string | undefined): CodexThreadPersistence | null {
  const normalized = cleanEnumEnvValue(value);
  if (normalized === "auto" || normalized === "per-session" || normalized === "per-task") {
    return normalized;
  }
  return null;
}

function resolveCodexThreadPersistence(): CodexThreadPersistence {
  const explicit = parseCodexThreadPersistence(process.env.CODEX_NATIVE_THREAD_PERSISTENCE);
  if (explicit !== null) {
    return explicit;
  }
  if (process.env.CODEX_PERSISTENT_THREAD !== undefined) {
    return parseBoolean(process.env.CODEX_PERSISTENT_THREAD, false) ? "per-session" : "per-task";
  }
  return "auto";
}

function isClaudePermissionMode(value: string | undefined): value is AppConfig["claudePermissionMode"] {
  return value === "acceptEdits" || value === "auto" || value === "bypassPermissions" || value === "default" || value === "dontAsk" || value === "plan";
}

function parseClaudePermissionMode(value: string | undefined): AppConfig["claudePermissionMode"] {
  const normalized = cleanEnumEnvValue(value);
  if (isClaudePermissionMode(normalized)) {
    return normalized;
  }
  return "acceptEdits";
}

function parseClaudePermissionModeExplicit(value: string | undefined): boolean {
  return isClaudePermissionMode(cleanEnumEnvValue(value));
}

function parseClaudeTransportMode(value: string | undefined): AppConfig["claudeTransportMode"] {
  const normalized = cleanEnumEnvValue(value);
  if (normalized === "auto" || normalized === "stream" || normalized === "text") {
    return normalized;
  }
  return "auto";
}

function parseAutonomyLevel(value: string | undefined): AutonomyLevel {
  const normalized = cleanEnumEnvValue(value);
  if (normalized === "manual" || normalized === "checkpoint" || normalized === "supervised" || normalized === "full_auto") {
    return normalized;
  }
  return "checkpoint";
}

function parseProjectStack(value: string | undefined): ProjectStack {
  const normalized = cleanEnumEnvValue(value);
  if (
    normalized === "static-html" ||
    normalized === "next" ||
    normalized === "vite-react" ||
    normalized === "node-cli" ||
    normalized === "node-express" ||
    normalized === "python-script" ||
    normalized === "python-flask" ||
    normalized === "python-django" ||
    normalized === "r-script" ||
    normalized === "r-shiny" ||
    normalized === "go" ||
    normalized === "rust" ||
    normalized === "csharp" ||
    normalized === "java" ||
    normalized === "php" ||
    normalized === "ruby"
  ) {
    return normalized;
  }
  return "next";
}

function resolvePlannerProvider(value: string | undefined, agentProvider: AgentProvider): PlannerProvider {
  const parsed = parsePlannerProvider(value);
  if (agentProvider === "codex-cli") {
    return parsed ?? "codex-cli";
  }
  return parsed ?? "codex-cli";
}

function parseList(value: string | undefined): string[] {
  const normalized = cleanScalarEnvValue(value);
  if (normalized === undefined || normalized === "") {
    return [];
  }
  return normalized
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseArgs(value: string | undefined): string[] {
  const normalized = cleanScalarEnvValue(value);
  if (normalized === undefined || normalized === "") {
    return [];
  }
  return normalized
    .split(" ")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function resolveProjectPath(rawPath: string): string {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.resolve( process.cwd(), rawPath);
}

function defaultMlCacheDir(): string {
  if (process.platform === "win32") {
    const localAppData = cleanScalarEnvValue(process.env.LOCALAPPDATA) ?? cleanScalarEnvValue(process.env.TEMP);
    if (localAppData !== undefined && localAppData.length > 0) {
      return path.join(localAppData, "acf-ml-cache");
    }
  }
  return resolveProjectPath(".data/ml-cache");
}

function defaultVenvRoot(): string {
  if (process.platform === "win32") {
    const localAppData = cleanScalarEnvValue(process.env.LOCALAPPDATA) ?? cleanScalarEnvValue(process.env.TEMP);
    if (localAppData !== undefined && localAppData.length > 0) {
      return path.join(localAppData, "acf-venvs");
    }
  }
  return resolveProjectPath(".data/venvs");
}

let warnedNonLoopbackPreviewHost = false;
function previewHostIsLoopback(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

export function getConfig(): AppConfig {
  const agentProvider = parseProvider(process.env.AGENT_PROVIDER);
  const rawControlPlanePort = parseNumber(process.env.CONTROL_PLANE_PORT, 3000);
  const controlPlanePort =
    Number.isInteger(rawControlPlanePort) && rawControlPlanePort >= 1 && rawControlPlanePort <= 65535
      ? rawControlPlanePort
      : 3000;
  const appBaseUrl = process.env.APP_BASE_URL ?? `http://localhost:${controlPlanePort}`;
  const previewHostOverride = cleanScalarEnvValue(process.env.PREVIEW_HOST);
  if (
    previewHostOverride !== undefined &&
    previewHostOverride.length > 0 &&
    !previewHostIsLoopback(previewHostOverride) &&
    !warnedNonLoopbackPreviewHost
  ) {
    warnedNonLoopbackPreviewHost = true;
    console.warn(
      `[orchestrator] PREVIEW_HOST="${previewHostOverride}" is not loopback. Generated app previews — and, via the static preview server, workspace files — will be reachable on your network with no authentication and no API guard. Use 127.0.0.1 unless you intend LAN exposure.`,
    );
  }
  const codexTransportMode = resolveCodexTransportMode();
  const codexNativeThreadPersistence = resolveCodexThreadPersistence();
  return {
    appBaseUrl,
    controlPlanePort,
    appEnv: process.env.APP_ENV ?? "development",
    dbFile: resolveProjectPath(process.env.DB_FILE ?? ".data/closed-dev-loop.json"),
    workspaceRoot: resolveProjectPath(process.env.WORKSPACE_ROOT ?? ".workspace"),
    artifactsDir: resolveProjectPath(process.env.ARTIFACTS_DIR ?? ".data/artifacts"),
    agentProvider,
    plannerProvider: resolvePlannerProvider(process.env.PLANNER_PROVIDER, agentProvider),
    plannerTimeoutMs: parseNumber(process.env.PLANNER_TIMEOUT_MS, 120000),
    defaultProjectStack: parseProjectStack(process.env.DEFAULT_PROJECT_STACK),
    codexCliBin: process.env.CODEX_CLI_BIN ?? "",
    codexExtraArgs: parseArgs(process.env.CODEX_EXTRA_ARGS),
    codexSandboxMode: process.env.CODEX_SANDBOX_MODE ?? "workspace-write",
    codexApprovalPolicy: process.env.CODEX_APPROVAL_POLICY ?? "on-request",
    codexTimeoutMs: parseNumber(process.env.CODEX_TIMEOUT_MS, 300000),
    codexModel: process.env.CODEX_MODEL ?? "",
    codexReasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "",
    codexTransportMode,
    codexAppServerFallback: parseBoolean(process.env.CODEX_APP_SERVER_FALLBACK, true),
    codexNativeThreadPersistence,
    codexAppServerExec: codexTransportMode !== "exec-only",
    codexPersistentThread: codexNativeThreadPersistence !== "per-task",
    codexMultiAgentMaxThreads: parseBoundedInteger(process.env.CODEX_MULTI_AGENT_MAX_THREADS, 8, 2, 64),
    claudeCodeBin: process.env.CLAUDE_CODE_BIN ?? "",
    claudeModel: process.env.CLAUDE_MODEL ?? "",
    claudeFallbackModel: (process.env.CLAUDE_FALLBACK_MODEL ?? "").trim(),
    claudeEffort: process.env.CLAUDE_EFFORT ?? "",
    claudeTimeoutMs: parseNumber(process.env.CLAUDE_TIMEOUT_MS, 600000),
    claudeMaxTurns: parseNumber(process.env.CLAUDE_MAX_TURNS, 24),
    claudeMaxTurnsExplicit: process.env.CLAUDE_MAX_TURNS !== undefined && process.env.CLAUDE_MAX_TURNS.trim() !== "",
    claudeTurnBudgetBase: parseNumber(process.env.CLAUDE_TURN_BUDGET_BASE, 16),
    claudeTurnBudgetPerFile: parseNumber(process.env.CLAUDE_TURN_BUDGET_PER_FILE, 6),
    claudeTurnBudgetCreateBonus: parseNumber(process.env.CLAUDE_TURN_BUDGET_CREATE_BONUS, 12),
    claudeTurnBudgetCeiling: parseNumber(process.env.CLAUDE_TURN_BUDGET_CEILING, 80),
    claudePlannerAllowExploration: parseBoolean(process.env.CLAUDE_PLANNER_ALLOW_EXPLORATION, false),
    claudeMaxBudgetUsd: process.env.CLAUDE_MAX_BUDGET_USD !== undefined && process.env.CLAUDE_MAX_BUDGET_USD.trim() !== "" ? parseNumber(process.env.CLAUDE_MAX_BUDGET_USD, 0) : null,
    claudePermissionMode: parseClaudePermissionMode(process.env.CLAUDE_PERMISSION_MODE),
    claudePermissionModeExplicit: parseClaudePermissionModeExplicit(process.env.CLAUDE_PERMISSION_MODE),
    claudePermissionGating: parseBoolean(process.env.CLAUDE_PERMISSION_GATING, true),
    claudeSettingsJson: (process.env.CLAUDE_SETTINGS_JSON ?? "").trim(),
    claudeSettingSources: (process.env.CLAUDE_SETTING_SOURCES ?? "").trim(),
    claudeTools: parseList(process.env.CLAUDE_TOOLS ?? "Read;Edit;Write;Glob;Grep"),
    claudeDisallowedTools: parseList(process.env.CLAUDE_DISALLOWED_TOOLS ?? "Bash;WebFetch;WebSearch"),
    claudeUltracode: parseBoolean(process.env.CLAUDE_ULTRACODE, false),
    claudeUltracodeTools: parseList(process.env.CLAUDE_ULTRACODE_TOOLS ?? "Read;Edit;Write;Glob;Grep;Task;Workflow"),
    claudeUltracodeMaxTurns: parseNumber(process.env.CLAUDE_ULTRACODE_MAX_TURNS, 200),
    claudeUltracodeMaxBudgetUsd:
      process.env.CLAUDE_ULTRACODE_MAX_BUDGET_USD !== undefined && process.env.CLAUDE_ULTRACODE_MAX_BUDGET_USD.trim() !== ""
        ? parseNumber(process.env.CLAUDE_ULTRACODE_MAX_BUDGET_USD, 5)
        : 5,
    claudeAddDirs: parseList(process.env.CLAUDE_ADD_DIRS ?? ""),
    claudeDisableTaskSlashCommands: parseBoolean(process.env.CLAUDE_DISABLE_TASK_SLASH_COMMANDS, false),
    claudeBare: parseBoolean(process.env.CLAUDE_BARE, false),
    claudePersistentSessions: parseBoolean(process.env.CLAUDE_PERSISTENT_SESSIONS, false),
    claudeTransportMode: parseClaudeTransportMode(process.env.CLAUDE_TRANSPORT_MODE),
    claudeExtraArgs: parseArgs(process.env.CLAUDE_EXTRA_ARGS),
    agyCliBin: process.env.AGY_CLI_BIN ?? "",
    agyTimeoutMs: parseNumber(process.env.AGY_TIMEOUT_MS, 600000),
    agySandbox: parseBoolean(process.env.AGY_SANDBOX, false),
    agyDangerouslySkipPermissions: parseBoolean(process.env.AGY_DANGEROUSLY_SKIP_PERMISSIONS, false),
    agyExtraArgs: parseArgs(process.env.AGY_EXTRA_ARGS),
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, ""),
    ollamaModel: process.env.OLLAMA_MODEL ?? "",
    ollamaTimeoutMs: parseNumber(process.env.OLLAMA_TIMEOUT_MS, 600000),
    ollamaMaxIterations: parseNumber(process.env.OLLAMA_MAX_ITERATIONS, 24),
    ollamaPlannerMaxAttempts: parseNumber(process.env.OLLAMA_PLANNER_MAX_ATTEMPTS, 3),
    ollamaPlannerNumCtx: process.env.OLLAMA_PLANNER_NUM_CTX !== undefined && process.env.OLLAMA_PLANNER_NUM_CTX.trim() !== "" ? parseNumber(process.env.OLLAMA_PLANNER_NUM_CTX, 8192) : null,
    ollamaNumCtx: process.env.OLLAMA_NUM_CTX !== undefined && process.env.OLLAMA_NUM_CTX.trim() !== "" ? parseNumber(process.env.OLLAMA_NUM_CTX, 8192) : null,
    ollamaCompactThreshold: parseNumber(process.env.OLLAMA_COMPACT_THRESHOLD, 0.8),
    ollamaTemperature: parseNumber(process.env.OLLAMA_TEMPERATURE, 0.2),
    ollamaToolsMode: parseOllamaToolsMode(process.env.OLLAMA_TOOLS_MODE),
    ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE ?? "5m",
    gitBin: process.env.GIT_BIN ?? "git",
    checkpointsEnabled: parseBoolean(process.env.CHECKPOINTS_ENABLED, true),
    autoApprovePlans: parseBoolean(process.env.AUTO_APPROVE_PLANS, false),
    defaultAutonomyLevel: parseAutonomyLevel(process.env.DEFAULT_AUTONOMY_LEVEL),
    controllerMaxStepsPerTick: parseNumber(process.env.CONTROLLER_MAX_STEPS_PER_TICK, 8),
    verifyCommands: parseList(process.env.VERIFY_COMMANDS),
    dependencyTaskAutoclose: parseDependencyTaskAutoclose(process.env.DEPENDENCY_TASK_AUTOCLOSE),
    dispatchRetryContext: parseBoolean(process.env.DISPATCH_RETRY_CONTEXT, true),
    dispatchContinuityContext: parseBoolean(process.env.DISPATCH_CONTINUITY_CONTEXT, true),
    shellTimeoutMs: parseNumber(process.env.SHELL_TIMEOUT_MS, 120000),
    allowAppRootVerification: parseBoolean(process.env.ALLOW_APP_ROOT_VERIFICATION, true),
    previewHost: previewHostOverride ?? "127.0.0.1",
    previewPortStart: parseNumber(process.env.PREVIEW_PORT_START, 3100),
    previewPortEnd: parseNumber(process.env.PREVIEW_PORT_END, 3999),
    previewAutoOpen: parseBoolean(process.env.PREVIEW_AUTO_OPEN, false),
    previewIdleTimeoutMs: parseNumber(process.env.PREVIEW_IDLE_TIMEOUT_MS, 300000),
    snapshotCaptureEnabled: parseBoolean(process.env.SNAPSHOT_CAPTURE_ENABLED, false),
    functionalVerificationEnabled: parseBoolean(process.env.FUNCTIONAL_VERIFICATION_ENABLED, false),
    functionalCheckTimeoutMs: parseNumber(process.env.FUNCTIONAL_CHECK_TIMEOUT_MS, 45000),
    interactionProbeLevel: parseInteractionProbeLevel(process.env.INTERACTION_PROBE_LEVEL),
    mlPipelineEnabled: parseBoolean(process.env.ML_PIPELINE_ENABLED, false),
    mlJobTimeoutMs: parseNumber(process.env.ML_JOB_TIMEOUT_MS, 3600000),
    mlJobHeartbeatIdleMs: parseNumber(process.env.ML_JOB_HEARTBEAT_IDLE_MS, 300000),
    mlSmokeTimeoutMs: parseNumber(process.env.ML_SMOKE_TIMEOUT_MS, 300000),
    mlDiskBudgetMb: parseNumber(process.env.ML_DISK_BUDGET_MB, 20480),
    mlTorchScaffoldMinDiskMb: parseNumber(process.env.ML_TORCH_SCAFFOLD_MIN_DISK_MB, 4096),
    mlAllowGpu: parseBoolean(process.env.ML_ALLOW_GPU, false),
    mlAllowNetworkDownloads: parseBoolean(process.env.ML_ALLOW_NETWORK_DOWNLOADS, true),
    mlAllowSecrets: parseBoolean(process.env.ML_ALLOW_SECRETS, false),
    mlTrustRemoteCode: parseBoolean(process.env.ML_TRUST_REMOTE_CODE, false),
    mlCacheDir: cleanScalarEnvValue(process.env.ML_CACHE_DIR) !== undefined
      ? resolveProjectPath(cleanScalarEnvValue(process.env.ML_CACHE_DIR) as string)
      : defaultMlCacheDir(),
    venvRoot: cleanScalarEnvValue(process.env.ACF_VENV_ROOT) !== undefined
      ? resolveProjectPath(cleanScalarEnvValue(process.env.ACF_VENV_ROOT) as string)
      : defaultVenvRoot(),
    mlGpuUnavailablePolicy: parseGpuUnavailablePolicy(process.env.ML_GPU_UNAVAILABLE_POLICY),
    mlDefaultCudaTag: cleanEnumEnvValue(process.env.ML_DEFAULT_CUDA_TAG) ?? "cu124",
    mlRequireVenvCudaVerify: parseBoolean(process.env.ML_REQUIRE_VENV_CUDA_VERIFY, true),
    mlInferenceIdleMs: parseNumber(process.env.ML_INFERENCE_IDLE_MS, 600000),
    mlInferenceTimeoutMs: parseNumber(process.env.ML_INFERENCE_TIMEOUT_MS, 120000),
    mlInferenceMaxUploadMb: parseNumber(process.env.ML_INFERENCE_MAX_UPLOAD_MB, 64),
    mlDataUploadMaxMb: parseNumber(process.env.ML_DATA_UPLOAD_MAX_MB, 200),
    mlDataUploadMaxFiles: parseBoundedInteger(process.env.ML_DATA_UPLOAD_MAX_FILES, 500, 1, 100000),
    mlDataUploadMaxTotalMb: parseNumber(process.env.ML_DATA_UPLOAD_MAX_TOTAL_MB, 1024),
    browserHeadless: parseBoolean(process.env.BROWSER_HEADLESS, true),
    visionJudgeEnabled: parseBoolean(process.env.VISION_JUDGE_ENABLED, false),
    crossProviderBriefRuns: Math.max(0, Math.floor(parseNumber(process.env.CROSS_PROVIDER_BRIEF_RUNS, 6))),
    crossProviderTranscript: parseBoolean(process.env.CROSS_PROVIDER_TRANSCRIPT, false),
    relentlessBudgetMs: parseNumber(process.env.RELENTLESS_BUDGET_MS, 20 * 60 * 1000),
    relentlessBudgetUsd: parseNumber(process.env.RELENTLESS_BUDGET_USD, 5),
    relentlessMaxStrategies: parseNumber(process.env.RELENTLESS_MAX_STRATEGIES, 5),
    telegramControlEnabled: parseBoolean(process.env.TELEGRAM_CONTROL_ENABLED, false),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    telegramControlAppUrl: (process.env.TELEGRAM_CONTROL_APP_URL ?? `http://127.0.0.1:${controlPlanePort}`).replace(/\/$/, ""),
    telegramControlWorkerToken: process.env.TELEGRAM_CONTROL_WORKER_TOKEN ?? "",
    telegramControlAllowedUserIds: parseList(process.env.TELEGRAM_CONTROL_ALLOWED_USER_IDS),
    telegramControlAllowedChatIds: parseList(process.env.TELEGRAM_CONTROL_ALLOWED_CHAT_IDS),
    telegramControlGroupsEnabled: parseBoolean(process.env.TELEGRAM_CONTROL_GROUPS_ENABLED, false),
    telegramControlActivityEvents: parseBoolean(process.env.TELEGRAM_CONTROL_ACTIVITY_EVENTS, true),
    telegramControlNotifyEvents: parseList(process.env.TELEGRAM_CONTROL_NOTIFY_EVENTS ?? "approval.requested;session.blocked;session.failed;session.finished;verification.failed;preview.ready;preview.failed;task.timeout.needs_decision"),
    telegramControlMaxTextChars: parseNumber(process.env.TELEGRAM_CONTROL_MAX_TEXT_CHARS, 4000),
    telegramControlSendPreviewScreenshots: parseBoolean(process.env.TELEGRAM_CONTROL_SEND_PREVIEW_SCREENSHOTS, false),
    telegramControlMaxScreenshotBytes: parseNumber(process.env.TELEGRAM_CONTROL_MAX_SCREENSHOT_BYTES, 10 * 1024 * 1024),
  };
}
