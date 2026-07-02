import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getConfig, type AppConfig } from "@/lib/server/config";
import { saveArtifact } from "@/lib/server/artifacts";
import { runProcess } from "@/lib/server/runtime/process-runner";
import { startClaudeStreamTurn, ClaudeStreamStartupError } from "@/lib/server/runtime/claude-stream-transport";
import { registerProcess, unregisterProcess } from "@/lib/server/runtime/process-registry";
import { createAgentProcessEnv } from "@/lib/server/runtime/env";
import { resolveClaudeCodeBin } from "@/lib/server/runtime/claude-code-resolver";
import { runClaudeCodeDoctor } from "@/lib/server/runtime/claude-code-doctor";
import { validateClaudeModelEffort } from "@/lib/server/runtime/claude-model-catalog";
import { clearClaudeContextCache } from "@/lib/server/runtime/claude-context-client";
import { ensureWorkspaceClaudeMd } from "@/lib/server/runtime/claude-md";
import { compareWorkspaceSnapshots, snapshotWorkspace } from "@/lib/server/runtime/workspace-diff";
import { buildCodexOrchestratorContext } from "@/lib/server/orchestrator-state";
import { renderProjectMemoryPromptBlock } from "@/lib/server/project-memory";
import { renderUserMemoryPromptBlock } from "@/lib/server/user-memory";
import { attachmentPromptBlock } from "@/lib/server/chat-attachments";
import { renderRelevantPlaybooksForPrompt } from "@/lib/server/playbooks";
import { recordRuntimeUsage } from "@/lib/server/runtime/runtime-usage";
import { mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { logProcess } from "@/lib/server/logging";
import { boundedText, tailExcerpt } from "@/lib/server/text-bounds";
import { standardServiceTier } from "@/lib/shared/runtime-overrides";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import type { AgentRunRecord, AutonomyLevel, TaskRecord, WorkSessionRecord } from "@/lib/shared/types";
import type { RuntimeExecutionResult } from "@/lib/server/runtime/execution-result";
import { parseClaudeStreamJson, type ClaudeStreamTelemetry, type ClaudeStructuredOutput } from "@/lib/server/runtime/claude-stream-parse";

function metadataString(task: TaskRecord, key: string, fallback: string): string {
  const value = task.metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function metadataStringList(task: TaskRecord, key: string): string[] {
  const value = task.metadata[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function isClaudeRepairTask(task: TaskRecord): boolean {
  return (
    typeof task.metadata.repairForTaskId === "string" ||
    typeof task.metadata.repairForVerificationRunId === "string" ||
    typeof task.metadata.repairForPreviewId === "string"
  );
}

function bulletList(values: string[], fallback: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function buildTaskSteeringBlock(taskNote: string): string {
  return taskNote.trim().length > 0 ? `Steering for this specific task:\n${taskNote.trim()}` : "";
}

function computeClaudeTurnBudget(config: AppConfig, task: TaskRecord): number {
  const floor = config.claudeMaxTurns;
  if (config.claudeMaxTurnsExplicit || floor <= 0) {
    return floor;
  }
  const targetFiles = metadataStringList(task, "targetFiles");
  const expectedChanges = metadataStringList(task, "expectedChanges");
  const scopeSize = Math.max(targetFiles.length, expectedChanges.length, task.acceptanceCriteria.length, 1);
  const taskKind = metadataString(task, "taskKind", "modify").toLowerCase();
  const creationHeavy = /create|setup|scaffold|initiali|bootstrap|generate/.test(taskKind);
  const raw = config.claudeTurnBudgetBase
    + config.claudeTurnBudgetPerFile * scopeSize
    + (creationHeavy ? config.claudeTurnBudgetCreateBonus : 0);
  const ceiling = Math.max(floor, config.claudeTurnBudgetCeiling);
  return Math.min(ceiling, Math.max(floor, raw));
}

function buildClaudeSystemPrompt(sessionSteeringNote: string, ultracode = false): string {
  const sections = [
    "You are a coding agent executing one task at a time inside an automated closed dev-loop orchestrator.",
    [
      "Hard rules (these govern every task and outrank task-specific instructions):",
      "- Work directly in the workspace when the task requires code changes. Keep edits scoped to the original user goal and the current task.",
      "- Do not run dependency installs, dev servers, or formal verification. The orchestrator owns dependency install, verification, and preview.",
      "- Spend tool turns efficiently: write each file complete in a single Write, and do not re-read a file you just wrote unless verifying a specific change. Avoid Write-then-Read-then-Edit churn — it triples the turns each file costs and can exhaust your turn budget before the task is done.",
      "- When you finish, return the required structured result: a concise `summary`, the `filesChanged` you edited, the `verificationSteps` you recommend, any `risks`, and `needsFollowup` (true if the task is not fully done).",
    ].join("\n"),
  ];
  if (ultracode) {
    sections.push(
      [
        "Ultracode is ON for this task: you are cleared and expected to orchestrate multiple agents.",
        "- For substantive work, author and run a Workflow (multi-agent orchestration), or fan out subagents with the Task tool, to decompose the work and verify findings adversarially before finalizing. Prefer parallel subagents over doing everything in one context.",
        "- Subagents inherit the same workspace confinement as you: every edit must stay inside the workspace, and the orchestrator's permission gate applies to their tool calls too.",
        "- After the orchestration completes, you (the parent) must still return the required structured result described in the hard rules above — the Workflow's return value does not replace it.",
      ].join("\n"),
    );
  }
  if (sessionSteeringNote.trim().length > 0) {
    sections.push(`User steering (applies to every task; honor unless it conflicts with a hard rule above):\n${sessionSteeringNote.trim()}`);
  }
  return sections.join("\n\n");
}

function summarizeOutputChunk(chunk: string): string {
  const normalized = chunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-3)
    .join(" ");
  return (normalized || chunk.replace(/\s+/g, " ").trim()).slice(0, 500);
}

function createBufferedOutputEmitter(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  agentRun: AgentRunRecord;
}): { stdout: (chunk: string) => void; stderr: (chunk: string) => void; flush: () => Promise<void> } {
  let buffer = "";
  let stream: "stdout" | "stderr" = "stdout";
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function emitBuffered(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const chunk = buffer;
    buffer = "";
    if (chunk.trim().length === 0) return;
    const summary = summarizeOutputChunk(chunk);
    if (summary.length === 0) return;
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "agent.process.output.delta",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { stream, text: summary, message: `${stream}: ${summary}` },
      priority: "low",
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });
  }

  function enqueue(nextStream: "stdout" | "stderr", chunk: string): void {
    if (buffer.length > 0 && stream !== nextStream) {
      void emitBuffered();
    }
    stream = nextStream;
    buffer += chunk;
    if (buffer.length >= 2000) {
      void emitBuffered();
      return;
    }
    if (timer === null) {
      timer = setTimeout(() => void emitBuffered(), 500);
    }
  }

  return {
    stdout: (chunk) => enqueue("stdout", chunk),
    stderr: (chunk) => enqueue("stderr", chunk),
    flush: emitBuffered,
  };
}

function claudeToolTargetHint(input: Record<string, unknown> | undefined): string {
  const candidate = input?.file_path ?? input?.notebook_path ?? input?.path ?? input?.pattern ?? input?.command;
  return typeof candidate === "string" ? candidate.slice(0, 160) : "";
}

function createClaudeActivityTextFeed(emit: (chunk: string) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string): void => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      if (line[0] !== "{") {
        emit(`${line}\n`);
        continue;
      }
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        emit(`${line}\n`);
        continue;
      }
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "stream_event") {
        const inner = (event.event ?? null) as { type?: string; delta?: { type?: string; text?: string } } | null;
        if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
          emit(inner.delta.text);
        }
        continue;
      }
      if (type === "assistant") {
        const content = (event.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const record = block as { type?: string; name?: string; input?: Record<string, unknown> };
            if (record.type === "tool_use" && typeof record.name === "string") {
              const hint = claudeToolTargetHint(record.input);
              emit(`\n[tool] ${record.name}${hint.length > 0 ? ` ${hint}` : ""}\n`);
            }
          }
        }
        continue;
      }
    }
  };
}

interface ResolvedClaudeRuntime {
  model: string | null;
  fallbackModel: string | null;
  effort: string | null;
  serviceTier: string | null;
  timeoutMs: number;
  ultracode: boolean;
  validationNote: string | null;
}

async function resolveClaudeRuntime(workSession: WorkSessionRecord, config: AppConfig): Promise<ResolvedClaudeRuntime> {
  const overrides = workSession.runtimeOverrides;
  const validated = await validateClaudeModelEffort({
    model: overrides?.model ?? (config.claudeModel.trim().length > 0 ? config.claudeModel.trim() : null),
    reasoningEffort: overrides?.reasoningEffort ?? (config.claudeEffort.trim().length > 0 ? config.claudeEffort.trim() : null),
    serviceTier: overrides?.serviceTier ?? null,
  });
  let fallbackModel: string | null = null;
  if (config.claudeFallbackModel.length > 0) {
    const validatedFallback = await validateClaudeModelEffort({ model: config.claudeFallbackModel, reasoningEffort: null });
    fallbackModel = validatedFallback.model !== null && validatedFallback.model !== validated.model ? validatedFallback.model : null;
  }
  return {
    model: validated.model,
    fallbackModel,
    effort: validated.reasoningEffort,
    serviceTier: validated.serviceTier,
    timeoutMs: overrides?.timeoutMs ?? config.claudeTimeoutMs,
    ultracode: overrides?.ultracode ?? config.claudeUltracode,
    validationNote: validated.reason,
  };
}

function claudeAuthSatisfiedOutsideLogin(config: AppConfig): boolean {
  return config.claudeBare || (process.env.ANTHROPIC_API_KEY ?? "").trim().length > 0;
}

function isParseableJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

interface ClaudePermissionDecision {
  mode: AppConfig["claudePermissionMode"];
  gating: boolean;
}

function resolveClaudePermission(input: {
  config: AppConfig;
  readOnly: boolean;
  autonomyLevel: AutonomyLevel;
}): ClaudePermissionDecision {
  if (input.readOnly) {
    return { mode: "plan", gating: false };
  }
  if (input.config.claudePermissionModeExplicit) {
    return { mode: input.config.claudePermissionMode, gating: false };
  }
  if (input.autonomyLevel === "full_auto") {
    return { mode: "bypassPermissions", gating: false };
  }
  if (!input.config.claudePermissionGating) {
    return { mode: "acceptEdits", gating: false };
  }
  return { mode: "default", gating: true };
}

const CLAUDE_FINAL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    verificationSteps: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    needsFollowup: { type: "boolean" },
  },
  required: ["summary", "filesChanged", "verificationSteps", "risks", "needsFollowup"],
  additionalProperties: false,
} as const;

function buildClaudeArgs(input: {
  config: AppConfig;
  runtime: ResolvedClaudeRuntime;
  readOnly: boolean;
  autonomyLevel: AutonomyLevel;
  worktreePath: string;
  appendSystemPrompt?: string | null;
  session?: { id: string; resume: boolean; fork?: boolean } | null;
  streamInput?: boolean;
  maxTurns?: number;
}): string[] {
  const ultracode = input.runtime.ultracode === true && !input.readOnly;
  const tools = input.readOnly
    ? ["Read", "Glob", "Grep"]
    : ultracode
      ? input.config.claudeUltracodeTools
      : input.config.claudeTools;
  const args = input.streamInput === true && !input.readOnly
    ? ["-p", "--input-format", "stream-json", "--replay-user-messages"]
    : ["-p", "--input-format", "text"];
  if (input.readOnly) {
    args.push("--output-format", "text");
  } else {
    args.push("--output-format", "stream-json", "--include-partial-messages", "--verbose");
  }
  const session = input.session ?? null;
  if (session !== null) {
    args.push(session.resume ? "--resume" : "--session-id", session.id);
    if (session.resume && session.fork === true) {
      args.push("--fork-session");
    }
  } else {
    args.push("--no-session-persistence");
  }
  const permission = resolveClaudePermission({ config: input.config, readOnly: input.readOnly, autonomyLevel: input.autonomyLevel });
  const serverPath = join(process.cwd(), "scripts", "claude-permission-server.mjs");
  const gatingActive = permission.gating && existsSync(serverPath);
  const effectiveMode = permission.gating && !gatingActive ? "acceptEdits" : permission.mode;
  args.push("--permission-mode", effectiveMode, "--tools", tools.join(","));
  if (gatingActive) {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        orchestrator: {
          command: process.execPath,
          args: [serverPath],
          env: { CLAUDE_PERM_WORKTREE: input.worktreePath, CLAUDE_PERM_AUTONOMY: input.autonomyLevel },
        },
      },
    });
    args.push("--mcp-config", mcpConfig, "--permission-prompt-tool", "mcp__orchestrator__approve");
  }
  const appendSystemPrompt = (input.appendSystemPrompt ?? "").trim();
  if (!input.readOnly && appendSystemPrompt.length > 0) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }
  if (!input.readOnly && session !== null) {
    args.push("--exclude-dynamic-system-prompt-sections");
  }
  if (!input.readOnly) {
    args.push("--json-schema", JSON.stringify(CLAUDE_FINAL_OUTPUT_SCHEMA));
  }
  if (input.config.claudeBare) {
    args.push("--bare");
  }
  if (input.config.claudeSettingsJson.length > 0 && isParseableJson(input.config.claudeSettingsJson)) {
    args.push("--settings", input.config.claudeSettingsJson);
  }
  if (input.config.claudeSettingSources.length > 0) {
    args.push("--setting-sources", input.config.claudeSettingSources);
  }
  if (!input.readOnly && input.config.claudeDisallowedTools.length > 0) {
    const allowed = new Set(tools);
    const disallowed = input.config.claudeDisallowedTools.filter((tool) => !allowed.has(tool));
    if (disallowed.length > 0) {
      args.push("--disallowedTools", disallowed.join(","));
    }
  }
  if (!input.readOnly) {
    for (const dir of input.config.claudeAddDirs) {
      if (existsSync(dir)) {
        args.push("--add-dir", dir);
      }
    }
  }
  if (!input.readOnly && input.config.claudeDisableTaskSlashCommands) {
    args.push("--disable-slash-commands");
  }
  if (input.runtime.model !== null) {
    args.push("--model", input.runtime.model);
  }
  if (!input.readOnly && input.runtime.fallbackModel !== null) {
    args.push("--fallback-model", input.runtime.fallbackModel);
  }
  if (input.runtime.effort !== null) {
    args.push("--effort", input.runtime.effort);
  }
  if (input.config.claudeMaxBudgetUsd !== null && input.config.claudeMaxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(input.config.claudeMaxBudgetUsd));
  } else if (ultracode && input.config.claudeUltracodeMaxBudgetUsd !== null && input.config.claudeUltracodeMaxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(input.config.claudeUltracodeMaxBudgetUsd));
  }
  const turnBudget = ultracode ? input.config.claudeUltracodeMaxTurns : (input.maxTurns ?? input.config.claudeMaxTurns);
  if (!input.readOnly && turnBudget > 0) {
    args.push("--max-turns", String(turnBudget));
  }
  args.push(...input.config.claudeExtraArgs);
  return args;
}

interface ClaudeControlTurnResult {
  ok: boolean;
  message: string;
  telemetry: ClaudeStreamTelemetry;
}

async function runClaudeFastControlTurn(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  agentRun: AgentRunRecord;
  executable: { command: string };
  config: AppConfig;
  runtime: ResolvedClaudeRuntime;
  session: { id: string; resume: boolean };
}): Promise<ClaudeControlTurnResult> {
  const command = input.runtime.serviceTier === standardServiceTier ? "/fast off" : "/fast on";
  const args = buildClaudeArgs({
    config: input.config,
    runtime: input.runtime,
    readOnly: true,
    autonomyLevel: input.workSession.autonomyLevel,
    worktreePath: input.workSession.activeWorktreePath,
    session: input.session,
  });
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "task.progress",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: `Applying Claude ${command}.` },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });
  const result = await runProcess({
    command: input.executable.command,
    args,
    cwd: input.workSession.activeWorktreePath,
    timeoutMs: Math.min(Math.max(input.runtime.timeoutMs, 30_000), 180_000),
    stdin: command,
    env: createAgentProcessEnv({ CI: "true", NEXT_TELEMETRY_DISABLED: "1" }),
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const telemetry = parseClaudeStreamJson(output);
  const ok = result.exitCode === 0 && !result.timedOut;
  logProcess(ok ? "info" : "warn", "claude.fast_control.done", {
    workSessionId: input.workSession.id,
    taskId: input.task.id,
    agentRunId: input.agentRun.id,
    sessionId: input.session.id,
    serviceTier: input.runtime.serviceTier ?? "",
    exitCode: result.exitCode ?? -1,
    timedOut: result.timedOut,
  });
  if (ok) {
    clearClaudeContextCache();
    await recordRuntimeUsage({
      workSessionId: input.workSession.id,
      agentRunId: input.agentRun.id,
      taskId: input.task.id,
      provider: "claude-code",
      model: input.runtime.model,
      promptTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      contextWindow: null,
      costUsd: telemetry.costUsd,
      sessionId: input.session.id,
      emit: false,
    });
  }
  return {
    ok,
    message: ok
      ? `Claude ${command} applied.`
      : result.timedOut
        ? `Claude ${command} timed out.`
        : `Claude ${command} failed with exit code ${result.exitCode === null ? "unknown" : String(result.exitCode)}.${tailExcerpt(output).length > 0 ? ` Last output excerpt:\n${tailExcerpt(output)}` : ""}`,
    telemetry,
  };
}

function extractClaudeSummary(stdout: string): string {
  const text = stdout.trim();
  return text.length > 0 ? text : "Claude Code completed successfully.";
}

function composeClaudeCompletedSummary(structured: ClaudeStructuredOutput): string {
  const parts = [structured.summary.trim()];
  if (structured.verificationSteps.length > 0) {
    parts.push(`Recommended verification:\n${structured.verificationSteps.map((step) => `- ${step}`).join("\n")}`);
  }
  if (structured.risks.length > 0) {
    parts.push(`Risks:\n${structured.risks.map((risk) => `- ${risk}`).join("\n")}`);
  }
  if (structured.needsFollowup) {
    parts.push("The agent flagged that follow-up work is still needed.");
  }
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}


export async function executeWithClaudeCode(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  agentRun: AgentRunRecord;
}): Promise<RuntimeExecutionResult> {
  const config = getConfig();
  await assertSafeWorkspace(input.workSession.activeWorktreePath, { operation: "Claude Code execution" });
  await mkdir(input.workSession.activeWorktreePath, { recursive: true });
  await ensureWorkspaceClaudeMd(input.workSession.activeWorktreePath);
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.started",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Checking Claude Code availability." },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });
  const doctor = await runClaudeCodeDoctor({ force: true });
  if (!doctor.available || !doctor.smokeExecPassed) {
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "agent.preflight.failed",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { message: doctor.error ?? "Claude Code preflight did not pass.", version: doctor.version ?? "" },
      priority: "high",
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });
    return {
      type: "failed",
      summary: `Claude Code preflight failed: ${doctor.error ?? "smoke exec did not pass."}`,
      codeChanges: [],
      failureKind: "environment_failure",
    };
  }
  if (doctor.authenticated === false && !claudeAuthSatisfiedOutsideLogin(config)) {
    const message = "Claude Code is installed but not logged in. Run `claude auth login` (or `claude setup-token`), or set ANTHROPIC_API_KEY.";
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "agent.preflight.failed",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { message, version: doctor.version ?? "" },
      priority: "high",
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });
    return {
      type: "failed",
      summary: `Claude Code preflight failed: ${message}`,
      codeChanges: [],
      failureKind: "environment_failure",
    };
  }
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.passed",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: doctor.error ?? "Claude Code preflight passed.", version: doctor.version ?? "" },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });

  const beforeSnapshot = await snapshotWorkspace(input.workSession.activeWorktreePath);
  const taskKind = metadataString(input.task, "taskKind", "modify");
  const riskLevel = metadataString(input.task, "riskLevel", "low");
  const objective = metadataString(input.task, "objective", input.task.description);
  const targetFiles = metadataStringList(input.task, "targetFiles");
  const expectedChanges = metadataStringList(input.task, "expectedChanges");
  const verificationHints = metadataStringList(input.task, "verificationHints");
  const turnBudget = computeClaudeTurnBudget(config, input.task);
  const dependencyResearchSummary = metadataString(input.task, "dependencyResearchSummary", "No dependency research report is attached to this task.");
  const dependencyInstallSummary = metadataString(input.task, "dependencyInstallSummary", "");
  const dispatchRetryContext = metadataString(input.task, "dispatchRetryContext", "");
  const dispatchContinuityContext = metadataString(input.task, "dispatchContinuityContext", "");
  const priorResearchContext = metadataString(input.task, "priorResearchContext", "");
  const skillsBlock = metadataString(input.task, "activatedSkillPrompt", "");

  const persistent = config.claudePersistentSessions;
  let session: { id: string; resume: boolean; fork?: boolean } | null = null;
  let skipOrchestratorContext = false;
  if (persistent) {
    const existing = input.workSession.claudeSessionId;
    const sessionId = existing ?? randomUUID();
    if (existing === null) {
      await mutateDatabase((db) => {
        const ws = db.workSessions.find((candidate) => candidate.id === input.workSession.id);
        if (ws !== undefined) {
          ws.claudeSessionId = sessionId;
          updateWorkSessionTimestamp(ws);
        }
      });
    }
    const fork = existing !== null && isClaudeRepairTask(input.task);
    session = { id: sessionId, resume: existing !== null, fork };
    skipOrchestratorContext = existing !== null;
  }
  const orchestratorContext = skipOrchestratorContext ? "" : await buildCodexOrchestratorContext(input.workSession.id);
  const userMemory = skipOrchestratorContext ? await renderUserMemoryPromptBlock() : "";
  const projectMemory = skipOrchestratorContext ? await renderProjectMemoryPromptBlock(input.workSession.id) : "";
  const attachmentsBlock = await attachmentPromptBlock(input.workSession);
  const playbooksBlock = await renderRelevantPlaybooksForPrompt({ workSession: input.workSession, task: input.task });
  const runtime = await resolveClaudeRuntime(input.workSession, config);
  const executable = await resolveClaudeCodeBin();
  if (runtime.validationNote !== null) {
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "task.progress",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { message: runtime.validationNote },
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });
  }
  if (runtime.ultracode) {
    const budgetCap = config.claudeMaxBudgetUsd ?? config.claudeUltracodeMaxBudgetUsd;
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "task.progress",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: {
        message: `Ultracode mode ON — Claude may orchestrate subagents (tools: ${config.claudeUltracodeTools.join(", ")}; turn cap ${config.claudeUltracodeMaxTurns}; budget cap ${budgetCap !== null ? `$${budgetCap}` : "none"}). Subagents stay confined to the workspace via the permission gate. Expect higher token cost.`,
      },
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });
  }
  if (runtime.serviceTier !== null) {
    if (session === null) {
      return {
        type: "failed",
        summary: "Claude Fast/Standard mode requires CLAUDE_PERSISTENT_SESSIONS so the /fast setting can be applied to a session before the task run.",
        codeChanges: [],
      };
    }
    const fastControl = await runClaudeFastControlTurn({
      workSession: input.workSession,
      task: input.task,
      agentRun: input.agentRun,
      executable,
      config,
      runtime,
      session,
    });
    if (!fastControl.ok) {
      return {
        type: "failed",
        summary: fastControl.message,
        codeChanges: [],
      };
    }
    session = { id: session.id, resume: true };
  }
  const systemPrompt = buildClaudeSystemPrompt(input.workSession.steeringNote, runtime.ultracode);
  const taskSteering = buildTaskSteeringBlock(metadataString(input.task, "steeringNote", ""));
  const prompt = `Execute the task below. Your role and the hard rules you must follow are in the system prompt.

Original user goal:
${input.workSession.lastUserMessage}

${attachmentsBlock.length > 0 ? `${attachmentsBlock}\n` : ""}

Workspace:
${input.workSession.activeWorktreePath}

Current task:
${input.task.title}

Task description:
${input.task.description}

Task objective:
${objective}

Task kind: ${taskKind}
Risk level: ${riskLevel}

Turn budget and scope discipline:
You have approximately ${turnBudget} tool-call turns for this task (each file Read, Write, or Edit consumes one).
- Implement ONLY this task's deliverables. Do NOT create or edit files that belong to later tasks — leave that work for them. Straying past this task's scope is the most common way a run exhausts its budget before finishing.
- Pace yourself against the budget. Before you run low on turns, stop and emit your StructuredOutput completion for the work done so far, so progress is recorded even if the budget is reached.

Target files:
${bulletList(targetFiles, "Inspect the workspace and choose the smallest relevant files for this task.")}

Expected changes:
${bulletList(expectedChanges, "Make only the changes needed for this task.")}

Acceptance criteria:
${input.task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}
Acceptance criteria that mention invalid or empty input are mandatory behavior, not suggestions: implement the graceful path (inline error or 4xx response), never an unhandled throw on a user-facing flow.

Verification hints:
${bulletList(verificationHints, "Do not run long verification here; the orchestrator owns formal verification.")}

${dispatchRetryContext.length > 0 ? `${dispatchRetryContext}\n` : ""}
${dispatchContinuityContext.length > 0 ? `${dispatchContinuityContext}\n` : ""}
${dependencyInstallSummary.length > 0 ? `Dependency pre-flight:\n${dependencyInstallSummary}\nThe packages above are already installed. Do not reinstall them; focus on the remaining file deliverables of this task.\n` : ""}
Dependency research:
Use this dependency research as the package baseline. Do not downgrade package.json below the recommended/latest versions in this report.
${dependencyResearchSummary}

${priorResearchContext.trim().length > 0 ? `Prior research context for this implementation:\n${priorResearchContext}\n` : ""}

${playbooksBlock.length > 0 ? `Relevant approved project playbooks:\n${playbooksBlock}\n` : ""}

${skillsBlock.length > 0 ? `${skillsBlock}\n` : ""}

${orchestratorContext}
${userMemory.length > 0 ? `${userMemory}\n` : ""}
${projectMemory.length > 0 ? `${projectMemory}\n` : ""}
${taskSteering.length > 0 ? `\n${taskSteering}\n` : ""}`;

  logProcess("info", "claude.prompt.prepared", {
    workSessionId: input.workSession.id,
    taskId: input.task.id,
    agentRunId: input.agentRun.id,
    taskTitle: input.task.title,
    promptChars: prompt.length,
    model: runtime.model ?? "",
    effort: runtime.effort ?? "",
    serviceTier: runtime.serviceTier ?? "",
  });

  const outputEmitter = createBufferedOutputEmitter(input);
  const abortController = new AbortController();
  const progressHandlers = {
    onStart: (pid: number | null) => {
      void emitEvent({
        workSessionId: input.workSession.id,
        eventName: "agent.process.started",
        aggregateType: "agent_run",
        aggregateId: input.agentRun.id,
        payload: { message: "Claude Code process started.", pid: pid === null ? "" : String(pid) },
        producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
        context: { taskId: input.task.id, agentRunId: input.agentRun.id },
      });
    },
    onStdout: createClaudeActivityTextFeed(outputEmitter.stdout),
    onStderr: outputEmitter.stderr,
    onExit: (processResult: { exitCode: number | null; timedOut: boolean }) => {
      void emitEvent({
        workSessionId: input.workSession.id,
        eventName: "agent.process.exited",
        aggregateType: "agent_run",
        aggregateId: input.agentRun.id,
        payload: {
          message: processResult.timedOut
            ? "Claude Code process timed out."
            : `Claude Code process exited with code ${processResult.exitCode === null ? "unknown" : String(processResult.exitCode)}.`,
          exitCode: processResult.exitCode === null ? "" : String(processResult.exitCode),
          timedOut: processResult.timedOut,
        },
        priority: processResult.exitCode === 0 && !processResult.timedOut ? "normal" : "high",
        producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
        context: { taskId: input.task.id, agentRunId: input.agentRun.id },
      });
    },
  };

  let args: string[] = [];

  const runWithTextTransport = async (): Promise<Awaited<ReturnType<typeof runProcess>>> => {
    args = buildClaudeArgs({ config, runtime, readOnly: false, autonomyLevel: input.workSession.autonomyLevel, worktreePath: input.workSession.activeWorktreePath, appendSystemPrompt: systemPrompt, session, maxTurns: turnBudget });
    registerProcess({
      agentRunId: input.agentRun.id,
      workSessionId: input.workSession.id,
      abort: (reason?: string) => abortController.abort(reason),
    });
    try {
      return await runProcess({
        command: executable.command,
        args,
        cwd: input.workSession.activeWorktreePath,
        timeoutMs: runtime.timeoutMs,
        stdin: prompt,
        signal: abortController.signal,
        env: createAgentProcessEnv({ CI: "true", NEXT_TELEMETRY_DISABLED: "1" }),
        progress: progressHandlers,
      });
    } finally {
      unregisterProcess(input.agentRun.id);
    }
  };

  const runWithStreamTransport = async (): Promise<Awaited<ReturnType<typeof runProcess>>> => {
    args = buildClaudeArgs({ config, runtime, readOnly: false, autonomyLevel: input.workSession.autonomyLevel, worktreePath: input.workSession.activeWorktreePath, appendSystemPrompt: systemPrompt, session, streamInput: true, maxTurns: turnBudget });
    const handle = startClaudeStreamTurn({
      command: executable.command,
      args,
      cwd: input.workSession.activeWorktreePath,
      timeoutMs: runtime.timeoutMs,
      env: createAgentProcessEnv({ CI: "true", NEXT_TELEMETRY_DISABLED: "1" }),
      prompt,
      progress: progressHandlers,
    });
    registerProcess({
      agentRunId: input.agentRun.id,
      workSessionId: input.workSession.id,
      abort: (reason?: string) => {
        abortController.abort(reason);
        handle.interrupt("abort");
      },
      steer: async (steering) => {
        const outcome = await handle.steer(steering.content);
        if (outcome.ok) {
          await emitEvent({
            workSessionId: input.workSession.id,
            eventName: "task.progress",
            aggregateType: "agent_run",
            aggregateId: input.agentRun.id,
            payload: { message: "Live steering injected into the running Claude turn." },
            producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
            context: { taskId: input.task.id, agentRunId: input.agentRun.id },
          });
        }
        return { ok: outcome.ok, message: outcome.message, data: { sessionId: session?.id ?? "" } };
      },
      getNativeThreadState: () => ({
        agentRunId: input.agentRun.id,
        workSessionId: input.workSession.id,
        threadId: session?.id ?? null,
        turnId: null,
        status: handle.status() === "starting" ? "starting" : handle.status() === "closed" ? "completed" : "running",
      }),
    });
    try {
      return await handle.result;
    } finally {
      unregisterProcess(input.agentRun.id);
    }
  };

  let result: Awaited<ReturnType<typeof runProcess>>;
  if (config.claudeTransportMode === "text") {
    result = await runWithTextTransport();
  } else {
    try {
      result = await runWithStreamTransport();
    } catch (error) {
      if (error instanceof ClaudeStreamStartupError && config.claudeTransportMode === "auto") {
        logProcess("warn", "claude_stream.fallback.text", {
          workSessionId: input.workSession.id,
          agentRunId: input.agentRun.id,
          taskId: input.task.id,
          message: error.message,
        });
        await emitEvent({
          workSessionId: input.workSession.id,
          eventName: "task.progress",
          aggregateType: "agent_run",
          aggregateId: input.agentRun.id,
          payload: { message: "Claude stream transport failed to start; falling back to the text transport for this turn." },
          producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
          context: { taskId: input.task.id, agentRunId: input.agentRun.id },
        });
        result = await runWithTextTransport();
      } else if (error instanceof ClaudeStreamStartupError) {
        result = { exitCode: 1, stdout: "", stderr: error.message, timedOut: false, aborted: false };
      } else {
        throw error;
      }
    }
  }

  await outputEmitter.flush();
  const afterSnapshot = await snapshotWorkspace(input.workSession.activeWorktreePath);
  const codeChanges = await compareWorkspaceSnapshots({
    workspacePath: input.workSession.activeWorktreePath,
    before: beforeSnapshot,
    after: afterSnapshot,
  });

  const telemetry = parseClaudeStreamJson(result.stdout);
  if (telemetry.compaction) {
    logProcess("info", "compaction.claude.observed", {
      workSessionId: input.workSession.id,
      agentRunId: input.agentRun.id,
      taskId: input.task.id,
      trigger: "auto",
      sessionId: telemetry.sessionId ?? session?.id ?? "",
    });
  }
  if (telemetry.initModel !== null) {
    logProcess("info", "claude.init.observed", {
      workSessionId: input.workSession.id,
      agentRunId: input.agentRun.id,
      taskId: input.task.id,
      requestedModel: runtime.model ?? "",
      actualModel: telemetry.initModel,
      tools: (telemetry.initTools ?? []).join(","),
      mcpServers: (telemetry.initMcpServers ?? []).join(","),
      permissionMode: telemetry.initPermissionMode ?? "",
      cliVersion: telemetry.cliVersion ?? "",
    });
    const requested = (runtime.model ?? "").trim();
    const actual = telemetry.initModel.trim();
    if (requested.length > 0 && actual.length > 0 && !actual.includes(requested) && !requested.includes(actual)) {
      await emitEvent({
        workSessionId: input.workSession.id,
        eventName: "task.progress",
        aggregateType: "agent_run",
        aggregateId: input.agentRun.id,
        payload: { message: `Claude ran on "${actual}" but "${requested}" was requested (silent model fallback).`, requestedModel: requested, actualModel: actual },
        priority: "high",
        producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
        context: { taskId: input.task.id, agentRunId: input.agentRun.id },
      });
    }
  }
  if (telemetry.rateLimited) {
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "task.progress",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { message: `Claude was rate-limited/retrying during this run${telemetry.rateLimitDetail !== null ? ` (${telemetry.rateLimitDetail})` : ""}.` },
      priority: "high",
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });
  }
  await recordRuntimeUsage({
    workSessionId: input.workSession.id,
    agentRunId: input.agentRun.id,
    taskId: input.task.id,
    provider: "claude-code",
    model: runtime.model,
    promptTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    contextWindow: null,
    costUsd: telemetry.costUsd,
    sessionId: telemetry.sessionId ?? session?.id ?? null,
    compactionTrigger: telemetry.compaction ? "auto" : null,
    compactionAt: telemetry.compaction ? new Date().toISOString() : null,
  });

  const report = `# Claude Code execution report

## Command
${executable.command} ${args.join(" ")}

## Exit code
${result.exitCode === null ? "null" : String(result.exitCode)}

## Timed out
${result.timedOut ? "yes" : "no"}

## Aborted
${result.aborted ? "yes" : "no"}

## Stdout
${result.stdout}

## Stderr
${result.stderr}

## System prompt
${systemPrompt}

## Prompt
${prompt}
${telemetry.permissionDenials.length > 0 ? `
## Permission Denials
${telemetry.permissionDenials.map((d) => {
  const inputStr = Object.keys(d.tool_input).length > 0
    ? ` — ${Object.entries(d.tool_input).map(([k, v]) => `${k}: ${String(v)}`).join(", ")}`
    : "";
  return `- **${d.tool_name}**${inputStr}`;
}).join("\n")}
` : ""}
`;

  const logArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `claude-code-task-${input.task.ordinal}.md`,
    content: report,
    metadata: {
      taskId: input.task.id,
      agentRunId: input.agentRun.id,
      provider: "claude-code",
      exitCode: result.exitCode ?? "null",
      timedOut: result.timedOut,
      model: runtime.model ?? "",
      effort: runtime.effort ?? "",
      actualModel: telemetry.initModel ?? "",
      actualTools: (telemetry.initTools ?? []).join(",") || "",
      rateLimited: telemetry.rateLimited,
      needsFollowup: telemetry.structured?.needsFollowup ?? false,
      structuredRisks: (telemetry.structured?.risks ?? []).join(" | "),
      structuredVerification: (telemetry.structured?.verificationSteps ?? []).join(" | "),
    },
  });

  const rawOutputBytes = Buffer.byteLength(`${result.stdout}\n${result.stderr}`, "utf8");
  if (result.aborted) {
    const interruptedBySteering = abortController.signal.reason === "steering";
    return {
      type: "failed",
      summary: interruptedBySteering
        ? `Claude Code run was interrupted to apply new user steering. Full transcript artifact: ${logArtifact.id}.`
        : `Claude Code run was aborted by the user. Full transcript artifact: ${logArtifact.id}.`,
      codeChanges,
      failureKind: interruptedBySteering ? "interrupted_by_user_steering" : "aborted",
      logArtifactId: logArtifact.id,
      rawOutputBytes,
    };
  }

  if (result.exitCode !== 0 && !result.timedOut && telemetry.resultSubtype === "error_max_turns") {
    const recovered = telemetry.structured ?? telemetry.recoveredStructured;
    const maxTurns = config.claudeMaxTurns;
    if (recovered !== null && codeChanges.length > 0) {
      const summary = boundedText(
        `${composeClaudeCompletedSummary(recovered)}\n\nNote: Claude reached its ${maxTurns}-turn budget after signaling completion of this task; any remaining work is treated as follow-up. Full transcript artifact: ${logArtifact.id}.`,
      );
      return {
        type: "completed",
        summary,
        codeChanges,
        logArtifactId: logArtifact.id,
        rawOutputBytes,
        transcript: [{
          provider: "claude",
          model: runtime.model ?? input.agentRun.model,
          role: input.agentRun.role,
          finalText: summary,
          reasoning: telemetry.reasoning.length > 0 ? boundedText(telemetry.reasoning.join("\n\n"), 4000) : undefined,
          ts: new Date().toISOString(),
        }],
      };
    }
    return {
      type: "failed",
      summary: boundedText(
        `Claude reached its ${maxTurns}-turn limit (error_max_turns) before signaling task completion. ${codeChanges.length} file(s) changed. Full transcript artifact: ${logArtifact.id}.`,
      ),
      codeChanges,
      failureKind: "max_turns_exhausted",
      logArtifactId: logArtifact.id,
      rawOutputBytes,
      continuationRecommended: codeChanges.length > 0,
    };
  }

  if (result.exitCode !== 0 || result.timedOut) {
    const output = `${result.stdout}\n${result.stderr}`;
    return {
      type: "failed",
      summary: boundedText(
        result.timedOut
          ? `Claude Code timed out after ${runtime.timeoutMs}ms. ${codeChanges.length} changed file(s) were captured. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(output).length > 0 ? ` Last output excerpt:\n${tailExcerpt(output)}` : ""}`
          : `Claude Code failed with exit code ${result.exitCode === null ? "unknown" : String(result.exitCode)}. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(output).length > 0 ? ` Last output excerpt:\n${tailExcerpt(output)}` : ""}`,
      ),
      codeChanges,
      failureKind: result.timedOut ? "timeout" : "runtime_failure",
      timedOut: result.timedOut,
      logArtifactId: logArtifact.id,
      rawOutputBytes,
      continuationRecommended: result.timedOut && codeChanges.length > 0,
    };
  }

  const summary = boundedText(
    telemetry.structured !== null
      ? composeClaudeCompletedSummary(telemetry.structured)
      : telemetry.summary ?? extractClaudeSummary(result.stdout),
  );
  return {
    type: "completed",
    summary,
    codeChanges,
    logArtifactId: logArtifact.id,
    rawOutputBytes,
    transcript: [{
      provider: "claude",
      model: runtime.model ?? input.agentRun.model,
      role: input.agentRun.role,
      finalText: summary,
      reasoning: telemetry.reasoning.length > 0 ? boundedText(telemetry.reasoning.join("\n\n"), 4000) : undefined,
      ts: new Date().toISOString(),
    }],
  };
}

async function runClaudeCompact(args: {
  workSession: WorkSessionRecord;
  task?: TaskRecord | null;
  agentRun?: AgentRunRecord | null;
  executable: { command: string };
  config: AppConfig;
  runtime: ResolvedClaudeRuntime;
  sessionId: string;
  reason: string;
}): Promise<ClaudeManualCompactionResult> {
  const { workSession, task = null, agentRun = null, executable, config, runtime, sessionId } = args;
  logProcess("info", "compaction.claude.manual_start", {
    workSessionId: workSession.id,
    agentRunId: agentRun?.id ?? "",
    sessionId,
    reason: args.reason,
  });
  await emitEvent({
    workSessionId: workSession.id,
    eventName: "runtime.compaction.started",
    aggregateType: agentRun === null ? "work_session" : "agent_run",
    aggregateId: agentRun?.id ?? workSession.id,
    payload: { message: "Manual Claude context compaction requested (/compact).", trigger: "manual" },
    priority: "low",
    producer: agentRun === null ? undefined : { module: "runtime-adapter", runtimeKind: agentRun.runtimeKind, role: agentRun.role },
    context: task === null && agentRun === null ? undefined : {
      ...(task === null ? {} : { taskId: task.id }),
      ...(agentRun === null ? {} : { agentRunId: agentRun.id }),
    },
  });
  const compactArgs = [
    "-p",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--resume",
    sessionId,
    "--permission-mode",
    "plan",
    "--tools",
    "Read",
  ];
  if (config.claudeBare) compactArgs.push("--bare");
  if (runtime.model !== null) {
    compactArgs.push("--model", runtime.model);
  }
  if (runtime.effort !== null) {
    compactArgs.push("--effort", runtime.effort);
  }
  if (config.claudeMaxBudgetUsd !== null && config.claudeMaxBudgetUsd > 0) {
    compactArgs.push("--max-budget-usd", String(config.claudeMaxBudgetUsd));
  }
  const result = await runProcess({
    command: executable.command,
    args: compactArgs,
    cwd: workSession.activeWorktreePath,
    timeoutMs: Math.min(Math.max(runtime.timeoutMs, 30_000), 180_000),
    stdin: "/compact",
    env: createAgentProcessEnv({ CI: "true", NEXT_TELEMETRY_DISABLED: "1" }),
  });
  const telemetry = parseClaudeStreamJson(`${result.stdout}\n${result.stderr}`);
  const ok = result.exitCode === 0 && !result.timedOut;
  logProcess(result.exitCode === 0 ? "info" : "warn", "compaction.claude.manual_done", {
    workSessionId: workSession.id,
    agentRunId: agentRun?.id ?? "",
    sessionId,
    exitCode: result.exitCode ?? -1,
    timedOut: result.timedOut,
    costUsd: telemetry.costUsd ?? -1,
    compactionMarkerSeen: telemetry.compaction,
  });
  if (ok) {
    clearClaudeContextCache();
    await recordRuntimeUsage({
      workSessionId: workSession.id,
      agentRunId: agentRun?.id ?? null,
      taskId: task?.id ?? null,
      provider: "claude-code",
      model: runtime.model,
      promptTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      contextWindow: null,
      costUsd: telemetry.costUsd,
      sessionId,
      compactionTrigger: "manual",
      compactionAt: new Date().toISOString(),
    });
  }
  return {
    requested: true,
    ok,
    sessionId,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    compactionMarkerSeen: telemetry.compaction,
    message: ok
      ? "Manual Claude context compaction completed."
      : result.timedOut
        ? "Claude context compaction timed out."
        : `Claude context compaction failed with exit code ${result.exitCode === null ? "unknown" : String(result.exitCode)}.`,
  };
}

export interface ClaudeManualCompactionResult {
  requested: boolean;
  ok: boolean;
  sessionId: string | null;
  exitCode: number | null;
  timedOut: boolean;
  compactionMarkerSeen: boolean;
  message: string;
}

export async function compactClaudePersistedSession(input: {
  workSession: WorkSessionRecord;
  reason?: string;
}): Promise<ClaudeManualCompactionResult> {
  const config = getConfig();
  if (!config.claudePersistentSessions) {
    return {
      requested: false,
      ok: false,
      sessionId: null,
      exitCode: null,
      timedOut: false,
      compactionMarkerSeen: false,
      message: "Claude persistent sessions are disabled.",
    };
  }
  const sessionId = input.workSession.claudeSessionId;
  if (sessionId === null) {
    return {
      requested: false,
      ok: false,
      sessionId: null,
      exitCode: null,
      timedOut: false,
      compactionMarkerSeen: false,
      message: "Claude has no persisted session to compact yet.",
    };
  }
  const runtime = await resolveClaudeRuntime(input.workSession, config);
  const executable = await resolveClaudeCodeBin();
  return runClaudeCompact({
    workSession: input.workSession,
    executable,
    config,
    runtime,
    sessionId,
    reason: input.reason ?? "manual",
  });
}

export async function executeClaudeReadOnly(input: {
  workSession: WorkSessionRecord;
  agentRun: AgentRunRecord;
  prompt: string;
}): Promise<Awaited<ReturnType<typeof runProcess>> & { commandLine: string }> {
  const config = getConfig();
  const executable = await resolveClaudeCodeBin();
  const runtime = await resolveClaudeRuntime(input.workSession, config);
  const args = buildClaudeArgs({ config, runtime, readOnly: true, autonomyLevel: input.workSession.autonomyLevel, worktreePath: input.workSession.activeWorktreePath });
  const result = await runProcess({
    command: executable.command,
    args,
    cwd: input.workSession.activeWorktreePath,
    timeoutMs: runtime.timeoutMs,
    stdin: input.prompt,
    env: createAgentProcessEnv({ CI: "true", NEXT_TELEMETRY_DISABLED: "1" }),
  });
  return { ...result, commandLine: `${executable.command} ${args.join(" ")}` };
}
