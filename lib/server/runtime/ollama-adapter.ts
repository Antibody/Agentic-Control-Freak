import { mkdir } from "node:fs/promises";
import { getConfig } from "@/lib/server/config";
import { saveArtifact } from "@/lib/server/artifacts";
import { registerProcess, unregisterProcess } from "@/lib/server/runtime/process-registry";
import { ensureWorkspaceAgentsMd } from "@/lib/server/runtime/agents-md";
import { compareWorkspaceSnapshots, snapshotWorkspace } from "@/lib/server/runtime/workspace-diff";
import { createOllamaClient, OllamaToolsUnsupportedError } from "@/lib/server/runtime/ollama-client";
import {
  envelopeActionToTool,
  executeWorkspaceTool,
  extractLargestCodeBlock,
  ollamaToolDefinitions,
  parseEnvelopeActions,
  readWorkspaceFileRaw,
} from "@/lib/server/runtime/ollama-tools";
import type { ChatMessage, ChatTokenUsage } from "@/lib/server/runtime/chat-model-client";
import { buildCodexOrchestratorContext } from "@/lib/server/orchestrator-state";
import { renderRelevantPlaybooksForPrompt } from "@/lib/server/playbooks";
import { renderToolPolicySummary } from "@/lib/server/runtime/tool-policy";
import { recordRuntimeUsage } from "@/lib/server/runtime/runtime-usage";
import { emitEvent } from "@/lib/server/events";
import { logProcess } from "@/lib/server/logging";
import { boundedText } from "@/lib/server/text-bounds";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import type { ActivityKind, AgentRunRecord, JsonObject, TaskRecord, TranscriptTurnRecord, WorkSessionRecord } from "@/lib/shared/types";
import type { RuntimeExecutionResult } from "@/lib/server/runtime/execution-result";

function metadataString(task: TaskRecord, key: string, fallback: string): string {
  const value = task.metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function metadataStringList(task: TaskRecord, key: string): string[] {
  const value = task.metadata[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function activityKindForWorkspaceTool(name: string, deliveryKind: WorkSessionRecord["deliveryKind"]): ActivityKind {
  if (name === "search_text") return "researching_repo";
  if (name === "read_file" || name === "list_dir") {
    return deliveryKind === "research" ? "researching_repo" : "reading_files";
  }
  if (name === "write_file" || name === "delete_file") return "editing_files";
  if (name === "finish") return deliveryKind === "research" ? "preparing_report" : "finishing";
  return "running_runtime";
}

function activityLabelForWorkspaceTool(kind: ActivityKind): string {
  switch (kind) {
    case "researching_repo":
      return "Researching repo";
    case "reading_files":
      return "Reading files";
    case "editing_files":
      return "Editing files";
    case "preparing_report":
      return "Preparing report";
    case "finishing":
      return "Finishing";
    default:
      return "Running runtime";
  }
}

function toolTarget(args: Record<string, unknown>): string | null {
  if (typeof args.query === "string" && args.query.trim().length > 0) return `"${args.query.trim()}"`;
  if (typeof args.path === "string" && args.path.trim().length > 0) return args.path.trim();
  return null;
}

async function emitWorkspaceToolActivity(input: {
  ctx: { input: { workSession: WorkSessionRecord; task: TaskRecord; agentRun: AgentRunRecord } };
  eventName: "tool.started" | "tool.completed" | "tool.failed";
  toolName: string;
  args: Record<string, unknown>;
  result?: { ok: boolean; result: string };
}): Promise<void> {
  const kind = activityKindForWorkspaceTool(input.toolName, input.ctx.input.workSession.deliveryKind);
  const label = activityLabelForWorkspaceTool(kind);
  const target = toolTarget(input.args);
  const payload: JsonObject = {
    toolName: input.toolName,
    activityKind: kind,
    activityLabel: label,
    message: target === null ? label : `${label}: ${target}`,
  };
  if (typeof input.args.path === "string" && input.args.path.trim().length > 0) payload.path = input.args.path.trim();
  if (typeof input.args.query === "string" && input.args.query.trim().length > 0) payload.query = input.args.query.trim();
  if (input.result !== undefined) {
    payload.ok = input.result.ok;
    payload.summary = input.result.result.slice(0, 300);
  }
  await emitEvent({
    workSessionId: input.ctx.input.workSession.id,
    eventName: input.eventName,
    aggregateType: "tool_run",
    aggregateId: input.ctx.input.agentRun.id,
    payload,
    producer: { module: "runtime-adapter", runtimeKind: input.ctx.input.agentRun.runtimeKind, role: input.ctx.input.agentRun.role },
    context: { taskId: input.ctx.input.task.id, agentRunId: input.ctx.input.agentRun.id },
  });
}

function bulletList(values: string[], fallback: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function steeringBlock(sessionNote: string, taskNote: string): string {
  return [
    sessionNote.trim().length > 0 ? `User steering (applies to every task):\n${sessionNote.trim()}` : "",
    taskNote.trim().length > 0 ? `Steering for this specific task:\n${taskNote.trim()}` : "",
  ]
    .filter((entry) => entry.length > 0)
    .join("\n\n");
}

async function buildWorkspaceContext(workspaceRoot: string, targetFiles: string[]): Promise<string> {
  const sections: string[] = [];
  const listResults: string[] = [];
  for (const dir of [".", "app", "src", "pages", "public"]) {
    const exec = await executeWorkspaceTool({ workspaceRoot, name: "list_dir", args: { path: dir } });
    if (exec.ok) {
      listResults.push(exec.result);
    }
  }
  if (listResults.length > 0) {
    sections.push(`Workspace files (relative paths):\n${listResults.join("\n")}`);
  }
  const fileBlocks: string[] = [];
  for (const rel of targetFiles.slice(0, 6)) {
    const raw = await readWorkspaceFileRaw(workspaceRoot, rel);
    fileBlocks.push(
      raw !== null
        ? `--- ${rel} (current contents — write the COMPLETE updated version) ---\n${raw}`
        : `--- ${rel} does not exist yet; create it with complete contents ---`,
    );
  }
  if (fileBlocks.length > 0) {
    sections.push(`Target file contents:\n${fileBlocks.join("\n\n")}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : "Workspace context: (empty workspace)";
}

const systemPrompt = `You are a coding executor working inside a single project workspace. You change the project by WRITING COMPLETE FILES.

Rules:
- To create or modify a file, output its ENTIRE new contents — never a diff, a fragment, or a prose description of changes.
- Use the file contents you are given. Do NOT invent or guess the contents of any file. If a file's current contents are shown to you below, edit those exact contents. Only read a file if you genuinely need one that was not provided.
- This project uses the Next.js App Router unless the workspace listing shows otherwise: the home page is app/page.tsx and routes are app/<route>/page.tsx. Do NOT create a pages/ directory or _app.tsx unless one already exists.
- Edit only the files needed for the task. Do not run installs, builds, dev servers, or verification — the orchestrator owns those. Do not import packages that are not in package.json.
- After writing the file(s), finish with a one-line summary.

Act in ONE of two ways (use whichever your runtime supports), and actually emit the action — never just describe it:
1) Native tool calls: write_file(path, content), read_file(path), list_dir(path), delete_file(path), finish(summary).
2) Text directives (use these if you cannot call tools), emitted literally with the file body in between:
<<<WRITE relative/path.ext>>>
the complete file contents go here
<<<END>>>
<<<FINISH>>>
one-line summary`;

interface LoopOutcome {
  status: "finished" | "final_answer" | "max_iterations" | "aborted" | "model_error";
  summary: string;
  iterations: number;
  transcript: string;
  transcriptTurns: TranscriptTurnRecord[];
  mutatedPaths: string[];
  errorMessage: string | null;
}

export async function executeWithOllama(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  agentRun: AgentRunRecord;
}): Promise<RuntimeExecutionResult> {
  const config = getConfig();
  const workspaceRoot = input.workSession.activeWorktreePath;
  await assertSafeWorkspace(workspaceRoot, { operation: "Ollama execution" });
  await mkdir(workspaceRoot, { recursive: true });
  await ensureWorkspaceAgentsMd(workspaceRoot);

  const client = createOllamaClient();
  const overrides = input.workSession.runtimeOverrides;
  const model = (overrides?.model ?? (config.ollamaModel.trim().length > 0 ? config.ollamaModel.trim() : null));

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.started",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Checking Ollama availability." },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });

  const doctor = await client.doctor();
  if (!doctor.available || model === null) {
    const reason = model === null
      ? "No Ollama model is configured. Set OLLAMA_MODEL or choose a model in the Runtime drawer."
      : doctor.error ?? "Ollama is not reachable.";
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "agent.preflight.failed",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { message: reason, version: doctor.version ?? "" },
      priority: "high",
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });
    return { type: "failed", summary: `Ollama preflight failed: ${reason}`, codeChanges: [], failureKind: "environment_failure" };
  }

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.passed",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: `Ollama reachable with ${doctor.modelCount} model(s).`, version: doctor.version ?? "" },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });

  const beforeSnapshot = await snapshotWorkspace(workspaceRoot);
  const orchestratorContext = await buildCodexOrchestratorContext(input.workSession.id);
  const steering = steeringBlock(input.workSession.steeringNote, metadataString(input.task, "steeringNote", ""));
  const targetFiles = metadataStringList(input.task, "targetFiles");
  const workspaceContext = await buildWorkspaceContext(workspaceRoot, targetFiles);
  const playbooksBlock = await renderRelevantPlaybooksForPrompt({ workSession: input.workSession, task: input.task });
  const skillsBlock = metadataString(input.task, "activatedSkillPrompt", "");
  const taskPrompt = `Original user goal:
${input.workSession.lastUserMessage}

Workspace (all tool paths are relative to this directory):
${workspaceRoot}

Current task: ${input.task.title}

Task description:
${input.task.description}

Task objective:
${metadataString(input.task, "objective", input.task.description)}

Task kind: ${metadataString(input.task, "taskKind", "modify")}
Risk level: ${metadataString(input.task, "riskLevel", "low")}

Target files:
${bulletList(metadataStringList(input.task, "targetFiles"), "Inspect the workspace and choose the smallest relevant files.")}

Expected changes:
${bulletList(metadataStringList(input.task, "expectedChanges"), "Make only the changes needed for this task.")}

Acceptance criteria:
${input.task.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}
Acceptance criteria that mention invalid or empty input are mandatory behavior, not suggestions: implement the graceful path (inline error or 4xx response), never an unhandled throw on a user-facing flow.

${metadataString(input.task, "dispatchRetryContext", "").length > 0 ? `${metadataString(input.task, "dispatchRetryContext", "")}\n` : ""}
${metadataString(input.task, "dispatchContinuityContext", "").length > 0 ? `${metadataString(input.task, "dispatchContinuityContext", "")}\n` : ""}
${metadataString(input.task, "dependencyInstallSummary", "").length > 0 ? `Dependency pre-flight:\n${metadataString(input.task, "dependencyInstallSummary", "")}\nThe packages above are already installed. Do not reinstall them; focus on the remaining file deliverables of this task.\n` : ""}
Dependency research:
${metadataString(input.task, "dependencyResearchSummary", "No dependency research report is attached to this task.")}

${workspaceContext}

${renderToolPolicySummary("execute")}

${playbooksBlock.length > 0 ? `Relevant approved project playbooks:\n${playbooksBlock}\n` : ""}

${skillsBlock.length > 0 ? `${skillsBlock}\n` : ""}

${orchestratorContext}
${steering.length > 0 ? `\n${steering}\n` : ""}
The workspace already exists; its files and the current contents of the target files are shown above. Write the COMPLETE updated contents of each target file (using write_file or a <<<WRITE path>>> block), then finish. Do not fabricate the contents of files you were not shown, and do not just describe the change.`;

  const toolsMode = config.ollamaToolsMode;
  const offerNativeTools = toolsMode !== "envelope";
  const tools = offerNativeTools ? ollamaToolDefinitions() : undefined;
  const timeoutMs = overrides?.timeoutMs ?? config.ollamaTimeoutMs;
  const temperature = overrides?.temperature ?? config.ollamaTemperature;
  const numCtx = overrides?.numCtx ?? config.ollamaNumCtx;

  logProcess("info", "ollama.prompt.prepared", {
    workSessionId: input.workSession.id,
    taskId: input.task.id,
    agentRunId: input.agentRun.id,
    model,
    toolsMode,
    promptChars: taskPrompt.length,
    hasSteering: steering.length > 0,
  });

  const abortController = new AbortController();
  const compactionState = { requested: false };
  registerProcess({
    agentRunId: input.agentRun.id,
    workSessionId: input.workSession.id,
    abort: (reason?: string) => abortController.abort(reason),
    requestCompaction: () => {
      compactionState.requested = true;
    },
  });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.process.started",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: `Ollama agent loop started (model ${model}).`, pid: "" },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: taskPrompt },
  ];
  const transcriptLines: string[] = [];
  const transcriptTurns: TranscriptTurnRecord[] = [];
  const mutatedPaths = new Set<string>();
  const modelContextLength = await client.showModelContextLength(model);
  const effectiveContextWindow = numCtx ?? modelContextLength;
  const usageHolder: { value: ChatTokenUsage | null } = { value: null };
  let outcome: LoopOutcome;

  try {
    outcome = await runAgentLoop({
      input,
      client,
      model,
      messages,
      tools,
      offerNativeTools,
      toolsMode,
      timeoutMs,
      temperature,
      numCtx,
      keepAlive: config.ollamaKeepAlive,
      maxIterations: config.ollamaMaxIterations,
      workspaceRoot,
      targetFiles,
      abortController,
      transcriptLines,
      transcriptTurns,
      mutatedPaths,
      usageHolder,
      contextWindow: effectiveContextWindow,
      compactionState,
      compactThreshold: config.ollamaCompactThreshold,
    });
  } finally {
    unregisterProcess(input.agentRun.id);
  }

  await recordRuntimeUsage({
    workSessionId: input.workSession.id,
    agentRunId: input.agentRun.id,
    taskId: input.task.id,
    provider: "ollama",
    model,
    promptTokens: usageHolder.value?.promptTokens ?? null,
    outputTokens: usageHolder.value?.outputTokens ?? null,
    contextWindow: effectiveContextWindow,
  });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.process.exited",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: {
      message: `Ollama agent loop ended (${outcome.status}) after ${outcome.iterations} iteration(s).`,
      exitCode: outcome.status === "finished" || outcome.status === "final_answer" ? "0" : "",
      timedOut: false,
    },
    priority: outcome.status === "aborted" || outcome.status === "model_error" ? "high" : "normal",
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });

  const afterSnapshot = await snapshotWorkspace(workspaceRoot);
  const codeChanges = await compareWorkspaceSnapshots({ workspacePath: workspaceRoot, before: beforeSnapshot, after: afterSnapshot });

  const report = `# Ollama execution report

## Model
${model}

## Outcome
${outcome.status} (${outcome.iterations} iteration(s))${outcome.errorMessage !== null ? `\nError: ${outcome.errorMessage}` : ""}

## Changed files
${codeChanges.length > 0 ? codeChanges.map((change) => `- ${change.changeKind}: ${change.filePath}`).join("\n") : "- (none)"}

## Transcript
${outcome.transcript}

## Prompt
${taskPrompt}
`;

  const logArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `ollama-task-${input.task.ordinal}.md`,
    content: report,
    metadata: {
      taskId: input.task.id,
      agentRunId: input.agentRun.id,
      provider: "ollama",
      model,
      outcome: outcome.status,
      iterations: outcome.iterations,
    },
  });

  if (outcome.status === "aborted") {
    const interruptedBySteering = abortController.signal.reason === "steering";
    return {
      type: "failed",
      summary: interruptedBySteering
        ? `Ollama run was interrupted to apply new user steering. Transcript artifact: ${logArtifact.id}.`
        : `Ollama run was aborted by the user. Transcript artifact: ${logArtifact.id}.`,
      codeChanges,
      failureKind: interruptedBySteering ? "interrupted_by_user_steering" : "aborted",
      logArtifactId: logArtifact.id,
      transcript: outcome.transcriptTurns,
    };
  }

  if (outcome.status === "model_error" && codeChanges.length === 0) {
    return {
      type: "failed",
      summary: boundedText(`Ollama model error: ${outcome.errorMessage ?? "unknown error"}. Transcript artifact: ${logArtifact.id}.`),
      codeChanges,
      failureKind: "runtime_failure",
      logArtifactId: logArtifact.id,
      transcript: outcome.transcriptTurns,
    };
  }

  if (codeChanges.length === 0) {
    return {
      type: "failed",
      summary: boundedText(
        `Ollama produced no file changes for this task (outcome: ${outcome.status}). The local model '${model}' likely returned a description or malformed output instead of writing files. A tool-capable code model (for example a qwen2.5-coder or llama3.1 tag) is recommended for reliable edits. Transcript artifact: ${logArtifact.id}.`,
      ),
      codeChanges,
      failureKind: "runtime_failure",
      logArtifactId: logArtifact.id,
      transcript: outcome.transcriptTurns,
    };
  }

  const summary = outcome.status === "max_iterations"
    ? `Ollama reached the ${outcome.iterations}-iteration budget without calling finish. ${codeChanges.length} file(s) changed. Transcript artifact: ${logArtifact.id}.`
    : boundedText(outcome.summary.trim().length > 0 ? outcome.summary : `Ollama completed the task with ${codeChanges.length} file change(s).`);

  return {
    type: "completed",
    summary,
    codeChanges,
    logArtifactId: logArtifact.id,
    continuationRecommended: outcome.status === "max_iterations" && codeChanges.length > 0,
    transcript: outcome.transcriptTurns,
  };
}

async function runAgentLoop(ctx: {
  input: { workSession: WorkSessionRecord; task: TaskRecord; agentRun: AgentRunRecord };
  client: ReturnType<typeof createOllamaClient>;
  model: string;
  messages: ChatMessage[];
  tools: ReturnType<typeof ollamaToolDefinitions> | undefined;
  offerNativeTools: boolean;
  toolsMode: "auto" | "native" | "envelope";
  timeoutMs: number;
  temperature: number | null;
  numCtx: number | null;
  keepAlive: string;
  maxIterations: number;
  workspaceRoot: string;
  targetFiles: string[];
  abortController: AbortController;
  transcriptLines: string[];
  transcriptTurns: TranscriptTurnRecord[];
  mutatedPaths: Set<string>;
  usageHolder: { value: ChatTokenUsage | null };
  contextWindow: number | null;
  compactionState: { requested: boolean };
  compactThreshold: number;
}): Promise<LoopOutcome> {
  let iterations = 0;
  let toolsEnabled = ctx.offerNativeTools;
  let noActionNudges = 0;
  let pendingCompaction: "auto" | "manual" | null = null;

  for (let i = 0; i < ctx.maxIterations; i += 1) {
    if (ctx.abortController.signal.aborted) {
      return outcomeFrom("aborted", "", iterations, ctx, null);
    }

    if (ctx.compactionState.requested) {
      ctx.compactionState.requested = false;
      logProcess("info", "compaction.ollama.manual_requested", {
        workSessionId: ctx.input.workSession.id,
        agentRunId: ctx.input.agentRun.id,
        taskId: ctx.input.task.id,
      });
      pendingCompaction = pendingCompaction ?? "manual";
    }
    if (pendingCompaction !== null) {
      const trigger = pendingCompaction;
      pendingCompaction = null;
      const beforeCount = ctx.messages.length;
      const folded = compactMessagesInPlace(ctx.messages);
      logProcess(folded > 0 ? "info" : "info", "compaction.ollama.apply", {
        workSessionId: ctx.input.workSession.id,
        agentRunId: ctx.input.agentRun.id,
        taskId: ctx.input.task.id,
        trigger,
        folded,
        messagesBefore: beforeCount,
        messagesAfter: ctx.messages.length,
        promptTokens: ctx.usageHolder.value?.promptTokens ?? -1,
        contextWindow: ctx.contextWindow ?? -1,
        applied: folded > 0,
      });
      if (folded > 0) {
        ctx.transcriptLines.push(`### Iteration ${iterations + 1}: compacted context (${trigger}); folded ${folded} older message(s).`);
        await recordCompaction(ctx, trigger);
      }
    }

    iterations += 1;

    let turn;
    try {
      turn = await ctx.client.chat(ctx.model, ctx.messages, {
        tools: toolsEnabled ? ctx.tools : undefined,
        temperature: ctx.temperature,
        numCtx: ctx.numCtx,
        keepAlive: ctx.keepAlive,
        signal: ctx.abortController.signal,
        timeoutMs: ctx.timeoutMs,
      });
    } catch (error) {
      if (ctx.abortController.signal.aborted) {
        return outcomeFrom("aborted", "", iterations, ctx, null);
      }
      if (error instanceof OllamaToolsUnsupportedError && toolsEnabled) {
        toolsEnabled = false;
        iterations -= 1;
        i -= 1;
        ctx.transcriptLines.push(`### Notice: model '${ctx.model}' does not support tool calls; switching to directive mode.`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      ctx.transcriptLines.push(`### Iteration ${iterations}: model error\n${message}`);
      return outcomeFrom("model_error", "", iterations, ctx, message);
    }

    ctx.messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
    ctx.transcriptLines.push(`### Iteration ${iterations}: assistant\n${turn.content.slice(0, 2000)}`);
    ctx.transcriptTurns.push({
      provider: "ollama",
      model: ctx.model,
      role: ctx.input.agentRun.role,
      finalText: turn.content,
      toolCalls: turn.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments }) as JsonObject),
      reasoning: turn.reasoning,
      ts: new Date().toISOString(),
    });

    if (turn.usage !== undefined && (turn.usage.promptTokens !== null || turn.usage.outputTokens !== null)) {
      ctx.usageHolder.value = turn.usage;
      void recordRuntimeUsage({
        workSessionId: ctx.input.workSession.id,
        agentRunId: ctx.input.agentRun.id,
        taskId: ctx.input.task.id,
        provider: "ollama",
        model: ctx.model,
        promptTokens: turn.usage.promptTokens,
        outputTokens: turn.usage.outputTokens,
        contextWindow: ctx.contextWindow,
        emit: false,
      });
    }

    if (
      ctx.compactThreshold > 0 &&
      ctx.contextWindow !== null &&
      ctx.contextWindow > 0 &&
      turn.usage?.promptTokens != null &&
      turn.usage.promptTokens / ctx.contextWindow >= ctx.compactThreshold
    ) {
      if (pendingCompaction === null) {
        logProcess("info", "compaction.ollama.threshold_crossed", {
          workSessionId: ctx.input.workSession.id,
          agentRunId: ctx.input.agentRun.id,
          taskId: ctx.input.task.id,
          promptTokens: turn.usage.promptTokens,
          contextWindow: ctx.contextWindow,
          ratio: Number((turn.usage.promptTokens / ctx.contextWindow).toFixed(3)),
          threshold: ctx.compactThreshold,
        });
      }
      pendingCompaction = pendingCompaction ?? "auto";
    }

    const usedNative = turn.toolCalls.length > 0;
    const calls = usedNative
      ? turn.toolCalls.map((call) => ({ name: call.name, args: call.arguments }))
      : (toolsEnabled && ctx.toolsMode === "native" ? [] : parseEnvelopeActions(turn.content).map(envelopeActionToTool));

    if (calls.length === 0) {
      if (ctx.mutatedPaths.size === 0) {
        const block = extractLargestCodeBlock(turn.content);
        if (block !== null && ctx.targetFiles.length === 1) {
          const args = { path: ctx.targetFiles[0], content: block };
          await emitWorkspaceToolActivity({ ctx, eventName: "tool.started", toolName: "write_file", args });
          const exec = await executeWorkspaceTool({ workspaceRoot: ctx.workspaceRoot, name: "write_file", args });
          await emitWorkspaceToolActivity({ ctx, eventName: exec.ok ? "tool.completed" : "tool.failed", toolName: "write_file", args, result: exec });
          ctx.transcriptLines.push(`### Iteration ${iterations}: rescued fenced code block -> write ${ctx.targetFiles[0]}\n${exec.result.slice(0, 300)}`);
          if (exec.mutatedPath !== null) {
            ctx.mutatedPaths.add(exec.mutatedPath);
            await emitDelta(ctx, `write_file: ${exec.result.slice(0, 200)}`);
            return outcomeFrom("finished", `Wrote ${ctx.targetFiles[0]} from the model's code block.`, iterations, ctx, null);
          }
        }
        if (noActionNudges < 2) {
          noActionNudges += 1;
          ctx.transcriptLines.push(`### Iteration ${iterations}: no actionable output; nudging to write (${noActionNudges}).`);
          ctx.messages.push({
            role: "user",
            content: "You did not write any file. Do not explain or describe. Emit the COMPLETE contents of each target file now using write_file, or a <<<WRITE path>>> ... <<<END>>> block, then finish.",
          });
          continue;
        }
      }
      await emitDelta(ctx, turn.content);
      return outcomeFrom("final_answer", turn.content, iterations, ctx, null);
    }

    const toolResultMessages: ChatMessage[] = [];
    let finished = false;
    let finishSummary = "";

    for (const call of calls) {
      if (call.name === "finish") {
        finished = true;
        finishSummary = typeof call.args.summary === "string" ? call.args.summary : turn.content;
        ctx.transcriptLines.push(`### Iteration ${iterations}: finish\n${finishSummary.slice(0, 1000)}`);
        await emitWorkspaceToolActivity({
          ctx,
          eventName: "tool.completed",
          toolName: "finish",
          args: call.args,
          result: { ok: true, result: finishSummary },
        });
        if (usedNative) {
          toolResultMessages.push({ role: "tool", content: "Finished.", toolName: "finish" });
        }
        continue;
      }
      await emitWorkspaceToolActivity({ ctx, eventName: "tool.started", toolName: call.name, args: call.args });
      const execution = await executeWorkspaceTool({ workspaceRoot: ctx.workspaceRoot, name: call.name, args: call.args });
      await emitWorkspaceToolActivity({ ctx, eventName: execution.ok ? "tool.completed" : "tool.failed", toolName: call.name, args: call.args, result: execution });
      ctx.transcriptLines.push(`### Iteration ${iterations}: tool ${call.name}\n${execution.result.slice(0, 1000)}`);
      if (execution.mutatedPath !== null) {
        ctx.mutatedPaths.add(execution.mutatedPath);
        await emitDelta(ctx, `${call.name}: ${execution.result.slice(0, 200)}`);
      }
      if (usedNative) {
        toolResultMessages.push({ role: "tool", content: execution.result, toolName: call.name });
      } else {
        toolResultMessages.push({ role: "user", content: `Tool ${call.name} result:\n${execution.result}\n\nContinue, or emit <<<FINISH>>> when done.` });
      }
    }

    ctx.messages.push(...toolResultMessages);

    if (finished) {
      return outcomeFrom("finished", finishSummary, iterations, ctx, null);
    }
  }

  return outcomeFrom("max_iterations", "", iterations, ctx, null);
}

function compactMessagesInPlace(messages: ChatMessage[]): number {
  const keepRecent = 4;
  const firstFoldable = 1;
  const lastFoldable = messages.length - keepRecent;
  if (lastFoldable - firstFoldable < 2) {
    return 0;
  }
  const middle = messages.slice(firstFoldable, lastFoldable);
  const condensed = middle
    .map((message) => {
      const label = message.role === "assistant" ? "assistant" : message.role === "tool" ? `tool(${message.toolName ?? "?"})` : message.role;
      const body = (message.content ?? "").replace(/\s+/g, " ").trim();
      return body.length > 0 ? `- ${label}: ${body.slice(0, 400)}` : null;
    })
    .filter((line): line is string => line !== null)
    .join("\n")
    .slice(0, 4000);
  const summary: ChatMessage = {
    role: "system",
    content: `Earlier conversation summary (older turns were compacted to save context):\n${condensed}`,
  };
  messages.splice(firstFoldable, middle.length, summary);
  return middle.length;
}

async function recordCompaction(
  ctx: {
    input: { workSession: WorkSessionRecord; task: TaskRecord; agentRun: AgentRunRecord };
    model: string;
    usageHolder: { value: ChatTokenUsage | null };
    contextWindow: number | null;
  },
  trigger: "auto" | "manual",
): Promise<void> {
  const now = new Date().toISOString();
  await emitEvent({
    workSessionId: ctx.input.workSession.id,
    eventName: "runtime.compaction.started",
    aggregateType: "agent_run",
    aggregateId: ctx.input.agentRun.id,
    payload: { message: `Ollama context compaction (${trigger}).`, trigger },
    producer: { module: "runtime-adapter", runtimeKind: ctx.input.agentRun.runtimeKind, role: ctx.input.agentRun.role },
    context: { taskId: ctx.input.task.id, agentRunId: ctx.input.agentRun.id },
  });
  await recordRuntimeUsage({
    workSessionId: ctx.input.workSession.id,
    agentRunId: ctx.input.agentRun.id,
    taskId: ctx.input.task.id,
    provider: "ollama",
    model: ctx.model,
    promptTokens: ctx.usageHolder.value?.promptTokens ?? null,
    outputTokens: ctx.usageHolder.value?.outputTokens ?? null,
    contextWindow: ctx.contextWindow,
    compactionTrigger: trigger,
    compactionAt: now,
  });
}

function outcomeFrom(
  status: LoopOutcome["status"],
  summary: string,
  iterations: number,
  ctx: { transcriptLines: string[]; transcriptTurns: TranscriptTurnRecord[]; mutatedPaths: Set<string> },
  errorMessage: string | null,
): LoopOutcome {
  return {
    status,
    summary,
    iterations,
    transcript: ctx.transcriptLines.join("\n\n"),
    transcriptTurns: ctx.transcriptTurns,
    mutatedPaths: [...ctx.mutatedPaths],
    errorMessage,
  };
}

async function emitDelta(
  ctx: {
    input: { workSession: WorkSessionRecord; task: TaskRecord; agentRun: AgentRunRecord };
  },
  text: string,
): Promise<void> {
  const summary = text.replace(/\s+/g, " ").trim().slice(0, 400);
  if (summary.length === 0) {
    return;
  }
  await emitEvent({
    workSessionId: ctx.input.workSession.id,
    eventName: "agent.process.output.delta",
    aggregateType: "agent_run",
    aggregateId: ctx.input.agentRun.id,
    payload: { stream: "stdout", text: summary, message: `stdout: ${summary}` },
    priority: "low",
    producer: { module: "runtime-adapter", runtimeKind: ctx.input.agentRun.runtimeKind, role: ctx.input.agentRun.role },
    context: { taskId: ctx.input.task.id, agentRunId: ctx.input.agentRun.id },
  });
}
