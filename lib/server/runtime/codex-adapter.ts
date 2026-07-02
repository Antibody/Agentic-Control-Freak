import { mkdir } from "node:fs/promises";
import { getConfig, type AppConfig } from "@/lib/server/config";
import { saveArtifact } from "@/lib/server/artifacts";
import { mutateDatabase } from "@/lib/server/db/file-db";
import { runProcess } from "@/lib/server/runtime/process-runner";
import { registerProcess, unregisterProcess } from "@/lib/server/runtime/process-registry";
import { createAgentProcessEnv } from "@/lib/server/runtime/env";
import { resolveCodexCliBin } from "@/lib/server/runtime/codex-cli-resolver";
import { ensureWorkspaceAgentsMd } from "@/lib/server/runtime/agents-md";
import { runCodexDoctor } from "@/lib/server/runtime/codex-doctor";
import { validateCodexModelReasoning } from "@/lib/server/runtime/codex-model-catalog";
import { compareWorkspaceSnapshots, snapshotWorkspace } from "@/lib/server/runtime/workspace-diff";
import { buildCodexTaskPrompt } from "@/lib/server/runtime/codex-task-prompt";
import { codexExecImageArgs } from "@/lib/server/chat-attachments";
import { recordRuntimeUsage } from "@/lib/server/runtime/runtime-usage";
import { emitEvent } from "@/lib/server/events";
import { logProcess } from "@/lib/server/logging";
import { boundedText, tailExcerpt } from "@/lib/server/text-bounds";
import { standardServiceTier } from "@/lib/shared/runtime-overrides";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import type { AgentRunRecord, TaskRecord, WorkSessionRecord } from "@/lib/shared/types";
import type { RuntimeExecutionResult } from "@/lib/server/runtime/execution-result";

function metadataString(task: TaskRecord, key: string, fallback: string): string {
  const value = task.metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

interface ResolvedCodexRuntime {
  sandboxMode: string;
  model: string | null;
  reasoningEffort: string | null;
  serviceTier: string | null;
  networkAccess: boolean | null;
  timeoutMs: number;
}

function normalizeCodexReasoningEffort(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return null;
  }
  if (trimmed === "minimal") {
    return null;
  }
  return trimmed;
}

async function resolveCodexRuntime(workSession: WorkSessionRecord, config: AppConfig): Promise<ResolvedCodexRuntime & { validationNote: string | null }> {
  const overrides = workSession.runtimeOverrides;
  const reasoningEffort = overrides?.reasoningEffort ?? config.codexReasoningEffort;
  const resolved = await validateCodexModelReasoning({
    model: overrides?.model ?? (config.codexModel.trim().length > 0 ? config.codexModel.trim() : null),
    reasoningEffort: normalizeCodexReasoningEffort(reasoningEffort),
    serviceTier: overrides?.serviceTier ?? null,
  });
  return {
    sandboxMode: overrides?.sandboxMode ?? config.codexSandboxMode,
    model: resolved.model,
    reasoningEffort: resolved.reasoningEffort,
    serviceTier: resolved.serviceTier,
    networkAccess: overrides?.networkAccess ?? null,
    timeoutMs: overrides?.timeoutMs ?? config.codexTimeoutMs,
    validationNote: resolved.reason,
  };
}

function codexToolIsolationArgs(): string[] {
  return [
    "-c",
    'web_search="disabled"',
    "--disable",
    "image_generation",
    "--disable",
    "apps",
    "--disable",
    "browser_use",
    "--disable",
    "plugins",
  ];
}

function outputLooksLikeCodexRuntimeConfigRejection(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("invalid_request_error") &&
    (
      normalized.includes("reasoning.effort") ||
      normalized.includes("model_reasoning_effort") ||
      normalized.includes("following tools cannot be used") ||
      normalized.includes('"param": "tools"') ||
      normalized.includes("unsupported value")
    )
  );
}

function summarizeCodexRuntimeConfigRejection(output: string): string {
  const compact = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("OpenAI Codex v") && !line.startsWith("--------"))
    .slice(-12)
    .join(" ");
  return `Codex rejected the runtime configuration. The orchestrator retried with a safe default reasoning effort, but Codex still failed. ${compact.slice(0, 1000)}`;
}

interface CodexJsonlTelemetry {
  summary: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  compaction: boolean;
}

function parseCodexJsonlTelemetry(stdout: string): CodexJsonlTelemetry {
  let summary: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let compaction = false;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line[0] !== "{") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (type.includes("compact")) compaction = true;
    const item = typeof event.item === "object" && event.item !== null ? (event.item as Record<string, unknown>) : null;
    if (item !== null) {
      const itemType = typeof item.type === "string" ? item.type : "";
      if (itemType.includes("compact")) compaction = true;
      if (itemType === "agent_message" && typeof item.text === "string" && item.text.trim().length > 0) {
        summary = item.text.trim();
      }
    }
    const usage = typeof event.usage === "object" && event.usage !== null ? (event.usage as Record<string, unknown>) : null;
    if (usage !== null) {
      if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
      if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
    }
  }
  return { summary, inputTokens, outputTokens, compaction };
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
    if (chunk.trim().length === 0) {
      return;
    }
    const summary = summarizeOutputChunk(chunk);
    if (summary.length === 0) {
      return;
    }
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "agent.process.output.delta",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: {
        stream,
        text: summary,
        message: `${stream}: ${summary}`,
      },
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
      timer = setTimeout(() => {
        void emitBuffered();
      }, 500);
    }
  }

  return {
    stdout: (chunk) => enqueue("stdout", chunk),
    stderr: (chunk) => enqueue("stderr", chunk),
    flush: emitBuffered,
  };
}

export async function executeWithCodexCli(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  agentRun: AgentRunRecord;
}): Promise<RuntimeExecutionResult> {
  const config = getConfig();
  await mutateDatabase((db) => {
    const run = db.agentRuns.find((candidate) => candidate.id === input.agentRun.id);
    if (run !== undefined) {
      run.codexTransport = "exec";
      run.codexThreadId = null;
      run.codexTurnId = null;
    }
  });
  await assertSafeWorkspace(input.workSession.activeWorktreePath, { operation: "Codex CLI execution" });
  await mkdir(input.workSession.activeWorktreePath, { recursive: true });
  await ensureWorkspaceAgentsMd(input.workSession.activeWorktreePath);
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.started",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Checking Codex CLI availability and sandbox." },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });
  const doctor = await runCodexDoctor();
  if (!doctor.available || !doctor.smokeExecPassed) {
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "agent.preflight.failed",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { message: doctor.error ?? "Codex smoke exec did not pass.", version: doctor.version ?? "" },
      priority: "high",
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });
    return {
      type: "failed",
      summary: `Codex CLI preflight failed: ${doctor.error ?? "smoke exec did not pass."}`,
      codeChanges: [],
    };
  }
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.passed",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Codex CLI preflight passed.", version: doctor.version ?? "" },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });
  const beforeSnapshot = await snapshotWorkspace(input.workSession.activeWorktreePath);
  const runtime = await resolveCodexRuntime(input.workSession, config);
  const executable = await resolveCodexCliBin();
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
  const { prompt, steeringBlock, steeringMessageIds } = await buildCodexTaskPrompt(input);
  const imageArgs = await codexExecImageArgs(input.workSession);

  logProcess("info", "codex.prompt.prepared", {
    workSessionId: input.workSession.id,
    taskId: input.task.id,
    agentRunId: input.agentRun.id,
    taskTitle: input.task.title,
    promptChars: prompt.length,
    hasSessionSteering: input.workSession.steeringNote.trim().length > 0,
    hasTaskSteering: metadataString(input.task, "steeringNote", "").trim().length > 0,
    appliedSteeringCount: steeringMessageIds.length,
    appliedSteeringIds: steeringMessageIds.join(","),
    steeringBlockChars: steeringBlock.length,
    steeringBlockExcerpt: steeringBlock.slice(0, 1000),
    imageCount: imageArgs.length / 2,
  });
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.prompt.prepared",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: {
      message: steeringMessageIds.length > 0
        ? `Prepared Codex prompt with ${steeringMessageIds.length} applied steering message(s).`
        : "Prepared Codex prompt with no pending steering messages applied.",
      taskId: input.task.id,
      appliedSteeringCount: String(steeringMessageIds.length),
      appliedSteeringIds: steeringMessageIds.join(","),
      steeringBlockChars: String(steeringBlock.length),
      steeringBlockExcerpt: steeringBlock.slice(0, 1000),
      promptChars: String(prompt.length),
      imageCount: String(imageArgs.length / 2),
    },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });

  function buildArgs(reasoningEffort: string | null): string[] {
    const args = [
      "exec",
      "--cd",
      input.workSession.activeWorktreePath,
      "--sandbox",
      runtime.sandboxMode,
      "-c",
      'approval_policy="never"',
      ...codexToolIsolationArgs(),
      "--skip-git-repo-check",
      "--color",
      "never",
      "--json",
    ];
    if (runtime.model !== null) {
      args.push("-m", runtime.model);
    }
    if (reasoningEffort !== null) {
      args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    }
    if (runtime.serviceTier === standardServiceTier) {
      args.push("-c", "service_tier=null");
    } else if (runtime.serviceTier !== null) {
      args.push("-c", `service_tier="${runtime.serviceTier}"`, "-c", "features.fast_mode=true");
    }
    if (runtime.networkAccess !== null) {
      args.push("-c", `sandbox_workspace_write.network_access=${runtime.networkAccess ? "true" : "false"}`);
    }
    args.push(...imageArgs, ...config.codexExtraArgs, "-");
    return args;
  }

  type CodexAttempt = {
    label: string;
    args: string[];
    result: Awaited<ReturnType<typeof runProcess>>;
  };

  const attempts: CodexAttempt[] = [];
  const outputEmitter = createBufferedOutputEmitter(input);
  const abortController = new AbortController();
  registerProcess({
    agentRunId: input.agentRun.id,
    workSessionId: input.workSession.id,
    abort: (reason?: string) => abortController.abort(reason),
  });
  try {
    const runCodexAttempt = async (label: string, args: string[]): Promise<CodexAttempt> => {
      const result = await runProcess({
        command: executable.command,
        args,
        cwd: input.workSession.activeWorktreePath,
        timeoutMs: runtime.timeoutMs,
        stdin: prompt,
        signal: abortController.signal,
        env: createAgentProcessEnv({
          PORT: process.env.GENERATED_APP_PORT ?? "3100",
          CODEX_SANDBOX_MODE: runtime.sandboxMode,
          CODEX_APPROVAL_POLICY: config.codexApprovalPolicy,
          CI: "true",
          NEXT_TELEMETRY_DISABLED: "1",
        }),
        progress: {
          onStart: (pid) => {
            void emitEvent({
              workSessionId: input.workSession.id,
              eventName: "agent.process.started",
              aggregateType: "agent_run",
              aggregateId: input.agentRun.id,
              payload: { message: `Codex CLI process started (${label}).`, pid: pid === null ? "" : String(pid) },
              producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
              context: { taskId: input.task.id, agentRunId: input.agentRun.id },
            });
          },
          onStdout: outputEmitter.stdout,
          onStderr: outputEmitter.stderr,
          onExit: (processResult) => {
            void emitEvent({
              workSessionId: input.workSession.id,
              eventName: "agent.process.exited",
              aggregateType: "agent_run",
              aggregateId: input.agentRun.id,
              payload: {
                message: processResult.timedOut
                  ? `Codex CLI process timed out (${label}).`
                  : `Codex CLI process exited with code ${processResult.exitCode === null ? "unknown" : String(processResult.exitCode)} (${label}).`,
                exitCode: processResult.exitCode === null ? "" : String(processResult.exitCode),
                timedOut: processResult.timedOut,
              },
              priority: processResult.exitCode === 0 && !processResult.timedOut ? "normal" : "high",
              producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
              context: { taskId: input.task.id, agentRunId: input.agentRun.id },
            });
          },
        },
      });
      return { label, args, result };
    };

    const primaryArgs = buildArgs(runtime.reasoningEffort);
    const primaryAttempt = await runCodexAttempt("primary", primaryArgs);
    attempts.push(primaryAttempt);

    const primaryOutput = `${primaryAttempt.result.stdout}\n${primaryAttempt.result.stderr}`;
    const shouldRetryWithoutEffort =
      runtime.reasoningEffort !== null &&
      !primaryAttempt.result.aborted &&
      !primaryAttempt.result.timedOut &&
      primaryAttempt.result.exitCode !== 0 &&
      outputLooksLikeCodexRuntimeConfigRejection(primaryOutput);

    if (shouldRetryWithoutEffort) {
      await emitEvent({
        workSessionId: input.workSession.id,
        eventName: "task.progress",
        aggregateType: "agent_run",
        aggregateId: input.agentRun.id,
        payload: {
          message: "Codex rejected the configured reasoning effort; retrying once with the model default.",
        },
        priority: "high",
        producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
        context: { taskId: input.task.id, agentRunId: input.agentRun.id },
      });
      attempts.push(await runCodexAttempt("retry-with-default-reasoning", buildArgs(null)));
    }
  } finally {
    unregisterProcess(input.agentRun.id);
  }
  const finalAttempt = attempts[attempts.length - 1];
  if (finalAttempt === undefined) {
    return {
      type: "failed",
      summary: "Codex CLI did not start.",
      codeChanges: [],
    };
  }
  const result = finalAttempt.result;
  await outputEmitter.flush();
  const afterSnapshot = await snapshotWorkspace(input.workSession.activeWorktreePath);
  const codeChanges = await compareWorkspaceSnapshots({
    workspacePath: input.workSession.activeWorktreePath,
    before: beforeSnapshot,
    after: afterSnapshot,
  });

  const telemetry = parseCodexJsonlTelemetry(result.stdout);
  if (telemetry.compaction) {
    logProcess("info", "compaction.codex_exec.observed", {
      workSessionId: input.workSession.id,
      agentRunId: input.agentRun.id,
      taskId: input.task.id,
      trigger: "auto",
      inputTokens: telemetry.inputTokens ?? -1,
    });
  }
  await recordRuntimeUsage({
    workSessionId: input.workSession.id,
    agentRunId: input.agentRun.id,
    taskId: input.task.id,
    provider: "codex-cli",
    model: runtime.model,
    promptTokens: telemetry.inputTokens,
    outputTokens: telemetry.outputTokens,
    contextWindow: null,
    compactionTrigger: telemetry.compaction ? "auto" : null,
    compactionAt: telemetry.compaction ? new Date().toISOString() : null,
  });

  const attemptReports = attempts
    .map((attempt, index) => `## Attempt ${index + 1}: ${attempt.label}

### Command
${executable.command} ${attempt.args.join(" ")}

### Exit code
${attempt.result.exitCode === null ? "null" : String(attempt.result.exitCode)}

### Timed out
${attempt.result.timedOut ? "yes" : "no"}

### Aborted
${attempt.result.aborted ? "yes" : "no"}

### Stdout
${attempt.result.stdout}

### Stderr
${attempt.result.stderr}
`)
    .join("\n");

  const report = `# Codex CLI execution report

${attemptReports}

## Prompt
${prompt}
`;

  const logArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `codex-cli-task-${input.task.ordinal}.md`,
    content: report,
    metadata: {
      taskId: input.task.id,
      agentRunId: input.agentRun.id,
      provider: "codex-cli",
      exitCode: result.exitCode ?? "null",
      timedOut: result.timedOut,
      attempts: attempts.length,
      appliedSteeringCount: steeringMessageIds.length,
      appliedSteeringIds: steeringMessageIds.join(","),
      steeringBlockChars: steeringBlock.length,
    },
  });

  if (result.aborted) {
    const interruptedBySteering = abortController.signal.reason === "steering";
    return {
      type: "failed",
      summary: interruptedBySteering
        ? `Codex CLI run was interrupted to apply new user steering. Full transcript artifact: ${logArtifact.id}.`
        : `Codex CLI run was aborted by the user. Full transcript artifact: ${logArtifact.id}.`,
      codeChanges,
      failureKind: interruptedBySteering ? "interrupted_by_user_steering" : "aborted",
      logArtifactId: logArtifact.id,
      rawOutputBytes: Buffer.byteLength(`${result.stdout}\n${result.stderr}`, "utf8"),
    };
  }

  if (result.exitCode !== 0 || result.timedOut) {
    const finalOutput = `${result.stdout}\n${result.stderr}`;
    const outputBytes = Buffer.byteLength(finalOutput, "utf8");
    const fallbackSummary = outputLooksLikeCodexRuntimeConfigRejection(finalOutput)
      ? summarizeCodexRuntimeConfigRejection(finalOutput)
      : result.timedOut
        ? `Codex CLI timed out after ${runtime.timeoutMs}ms. ${codeChanges.length} changed file(s) were captured. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(finalOutput).length > 0 ? ` Last output excerpt:\n${tailExcerpt(finalOutput)}` : ""}`
        : `Codex CLI failed with exit code ${result.exitCode === null ? "unknown" : String(result.exitCode)}. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(result.stderr || result.stdout).length > 0 ? ` Last output excerpt:\n${tailExcerpt(result.stderr || result.stdout)}` : ""}`;
    return {
      type: "failed",
      summary: boundedText(fallbackSummary),
      codeChanges,
      failureKind: result.timedOut ? "timeout" : "runtime_failure",
      timedOut: result.timedOut,
      logArtifactId: logArtifact.id,
      rawOutputBytes: outputBytes,
      continuationRecommended: result.timedOut && codeChanges.length > 0,
    };
  }

  const summary = boundedText(telemetry.summary ?? result.stdout ?? "Codex CLI completed successfully.");
  return {
    type: "completed",
    summary,
    codeChanges,
    logArtifactId: logArtifact.id,
    rawOutputBytes: Buffer.byteLength(`${result.stdout}\n${result.stderr}`, "utf8"),
    transcript: [{
      provider: "codex",
      model: runtime.model ?? input.agentRun.model,
      role: input.agentRun.role,
      finalText: summary,
      ts: new Date().toISOString(),
    }],
  };
}
