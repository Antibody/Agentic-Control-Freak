import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig, type AppConfig } from "@/lib/server/config";
import { saveArtifact } from "@/lib/server/artifacts";
import { emitEvent } from "@/lib/server/events";
import { logProcess } from "@/lib/server/logging";
import { buildCodexOrchestratorContext } from "@/lib/server/orchestrator-state";
import { renderRelevantPlaybooksForPrompt } from "@/lib/server/playbooks";
import { ensureWorkspaceAgentsMd } from "@/lib/server/runtime/agents-md";
import { resolveAgyCliBin } from "@/lib/server/runtime/agy-cli-resolver";
import { runAgyDoctor } from "@/lib/server/runtime/agy-doctor";
import { applyAgyRuntimeModel } from "@/lib/server/runtime/agy-runtime-options";
import { createAgentProcessEnv } from "@/lib/server/runtime/env";
import { registerProcess, unregisterProcess } from "@/lib/server/runtime/process-registry";
import { runProcess } from "@/lib/server/runtime/process-runner";
import { compareWorkspaceSnapshots, snapshotWorkspace } from "@/lib/server/runtime/workspace-diff";
import { boundedText, tailExcerpt } from "@/lib/server/text-bounds";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import type { AgentRunRecord, TaskRecord, WorkSessionRecord } from "@/lib/shared/types";
import type { RuntimeExecutionResult } from "@/lib/server/runtime/execution-result";

function metadataString(task: TaskRecord, key: string, fallback: string): string {
  const value = task.metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function metadataStringList(task: TaskRecord, key: string): string[] {
  const value = task.metadata[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function bulletList(values: string[], fallback: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function buildSteeringBlock(sessionNote: string, taskNote: string): string {
  return [
    sessionNote.trim().length > 0 ? `User steering (applies to every task; honor unless it conflicts with a hard constraint above):\n${sessionNote.trim()}` : "",
    taskNote.trim().length > 0 ? `Steering for this specific task:\n${taskNote.trim()}` : "",
  ].filter((entry) => entry.length > 0).join("\n\n");
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

interface ResolvedAgyRuntime {
  model: string | null;
  timeoutMs: number;
}

function resolveAgyRuntime(workSession: WorkSessionRecord, config: AppConfig): ResolvedAgyRuntime {
  return {
    model: workSession.runtimeOverrides?.model ?? null,
    timeoutMs: workSession.runtimeOverrides?.timeoutMs ?? config.agyTimeoutMs,
  };
}

function printTimeoutArg(timeoutMs: number): string {
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
}

function buildAgyArgs(input: {
  config: AppConfig;
  runtime: ResolvedAgyRuntime;
  workspacePath: string;
  prompt: string;
}): string[] {
  const args: string[] = [
    "--add-dir",
    input.workspacePath,
    "--print-timeout",
    printTimeoutArg(input.runtime.timeoutMs),
  ];
  if (input.config.agySandbox) {
    args.push("--sandbox");
  }
  if (input.config.agyDangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  args.push(...input.config.agyExtraArgs);
  args.push("--print", input.prompt);
  return args;
}

async function writePromptFile(input: { workspacePath: string; fileStem: string; prompt: string }): Promise<string> {
  const dir = path.join(input.workspacePath, ".orchestrator");
  await mkdir(dir, { recursive: true });
  const fileName = `${input.fileStem}.md`;
  const absolutePath = path.join(dir, fileName);
  await writeFile(absolutePath, input.prompt, "utf8");
  return `.orchestrator/${fileName}`;
}

function extractAgySummary(stdout: string): string {
  const text = stdout.trim();
  return text.length > 0 ? text : "AGY completed successfully.";
}

export async function executeWithAgy(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  agentRun: AgentRunRecord;
}): Promise<RuntimeExecutionResult> {
  const config = getConfig();
  const workspacePath = input.workSession.activeWorktreePath;
  await assertSafeWorkspace(workspacePath, { operation: "AGY execution" });
  await mkdir(workspacePath, { recursive: true });
  await ensureWorkspaceAgentsMd(workspacePath);
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.started",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Checking AGY CLI availability." },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });

  const doctor = await runAgyDoctor();
  if (!doctor.available || !doctor.smokeExecPassed) {
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "agent.preflight.failed",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { message: doctor.error ?? "AGY CLI preflight did not pass.", version: doctor.version ?? "" },
      priority: "high",
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });
    return {
      type: "failed",
      summary: `AGY CLI preflight failed: ${doctor.error ?? "agy --version did not pass."}`,
      codeChanges: [],
      failureKind: "environment_failure",
    };
  }
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.passed",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: doctor.error ?? "AGY CLI preflight passed.", version: doctor.version ?? "" },
    producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { taskId: input.task.id, agentRunId: input.agentRun.id },
  });

  const beforeSnapshot = await snapshotWorkspace(workspacePath);
  const taskKind = metadataString(input.task, "taskKind", "modify");
  const riskLevel = metadataString(input.task, "riskLevel", "low");
  const objective = metadataString(input.task, "objective", input.task.description);
  const targetFiles = metadataStringList(input.task, "targetFiles");
  const expectedChanges = metadataStringList(input.task, "expectedChanges");
  const verificationHints = metadataStringList(input.task, "verificationHints");
  const dependencyResearchSummary = metadataString(input.task, "dependencyResearchSummary", "No dependency research report is attached to this task.");
  const dependencyInstallSummary = metadataString(input.task, "dependencyInstallSummary", "");
  const dispatchRetryContext = metadataString(input.task, "dispatchRetryContext", "");
  const dispatchContinuityContext = metadataString(input.task, "dispatchContinuityContext", "");
  const priorResearchContext = metadataString(input.task, "priorResearchContext", "");
  const skillsBlock = metadataString(input.task, "activatedSkillPrompt", "");
  const orchestratorContext = await buildCodexOrchestratorContext(input.workSession.id);
  const playbooksBlock = await renderRelevantPlaybooksForPrompt({ workSession: input.workSession, task: input.task });
  const runtime = resolveAgyRuntime(input.workSession, config);
  const modelApplication = await applyAgyRuntimeModel(runtime.model);
  if (modelApplication.error !== null) {
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "agent.preflight.failed",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { message: `Unable to apply AGY model '${modelApplication.model ?? "inherit"}': ${modelApplication.error}`, settingsPath: modelApplication.settingsPath },
      priority: "high",
      producer: { module: "runtime-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { taskId: input.task.id, agentRunId: input.agentRun.id },
    });
    return {
      type: "failed",
      summary: `AGY CLI model selection failed before launch: ${modelApplication.error}`,
      codeChanges: [],
      failureKind: "environment_failure",
    };
  }
  const executable = await resolveAgyCliBin();
  const steering = buildSteeringBlock(input.workSession.steeringNote, metadataString(input.task, "steeringNote", ""));
  const prompt = `You are executing one task inside a closed dev loop.

Original user goal:
${input.workSession.lastUserMessage}

Workspace:
${workspacePath}

Current task:
${input.task.title}

Task description:
${input.task.description}

Task objective:
${objective}

Task kind: ${taskKind}
Risk level: ${riskLevel}

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

Work directly in the workspace when the task requires code changes. Keep edits scoped to the original user goal and this task.
Do not run dependency installs, dev servers, or formal verification. The orchestrator owns dependency install, verification, and preview.
Do not create background subagents or branches. Work in this AGY print-mode turn only.

${orchestratorContext}
${steering.length > 0 ? `\n${steering}\n` : ""}
After working, print a concise summary, list files changed, and list verification steps you recommend.`;
  const promptPath = await writePromptFile({
    workspacePath,
    fileStem: `agy-task-${input.agentRun.id}`,
    prompt,
  });
  const launcherPrompt = `Read ${promptPath} in this workspace and execute the task exactly. Do not edit files outside this workspace. Print the final concise summary requested in that file.`;

  logProcess("info", "agy.prompt.prepared", {
    workSessionId: input.workSession.id,
    taskId: input.task.id,
    agentRunId: input.agentRun.id,
    taskTitle: input.task.title,
    promptChars: prompt.length,
    promptPath,
  });

  const outputEmitter = createBufferedOutputEmitter(input);
  const abortController = new AbortController();
  registerProcess({
    agentRunId: input.agentRun.id,
    workSessionId: input.workSession.id,
    abort: (reason?: string) => abortController.abort(reason),
  });
  let result: Awaited<ReturnType<typeof runProcess>>;
  const args = buildAgyArgs({ config, runtime, workspacePath, prompt: launcherPrompt });
  try {
    result = await runProcess({
      command: executable.command,
      args,
      cwd: workspacePath,
      timeoutMs: runtime.timeoutMs + 15_000,
      signal: abortController.signal,
      env: createAgentProcessEnv({
        AGY_CLI_DISABLE_AUTO_UPDATE: "true",
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
            payload: { message: "AGY CLI process started.", pid: pid === null ? "" : String(pid) },
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
                ? "AGY CLI process timed out."
                : `AGY CLI process exited with code ${processResult.exitCode === null ? "unknown" : String(processResult.exitCode)}.`,
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
  } finally {
    unregisterProcess(input.agentRun.id);
  }

  await outputEmitter.flush();
  const afterSnapshot = await snapshotWorkspace(workspacePath);
  const codeChanges = await compareWorkspaceSnapshots({
    workspacePath,
    before: beforeSnapshot,
    after: afterSnapshot,
  });

  const report = `# AGY execution report

## Command
${executable.command} ${args.join(" ")}

## Model
${modelApplication.model ?? "AGY settings default"}${modelApplication.changed ? " (applied to AGY settings before launch)" : ""}

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

## Prompt file
${promptPath}

## Prompt
${prompt}
`;

  const logArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `agy-task-${input.task.ordinal}.md`,
    content: report,
    metadata: {
      taskId: input.task.id,
      agentRunId: input.agentRun.id,
      provider: "antigravity-cli",
      model: modelApplication.model ?? "settings-default",
      modelSettingsChanged: modelApplication.changed,
      exitCode: result.exitCode ?? "null",
      timedOut: result.timedOut,
      sandbox: config.agySandbox,
      dangerouslySkipPermissions: config.agyDangerouslySkipPermissions,
    },
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const rawOutputBytes = Buffer.byteLength(output, "utf8");
  if (result.aborted) {
    const interruptedBySteering = abortController.signal.reason === "steering";
    return {
      type: "failed",
      summary: interruptedBySteering
        ? `AGY CLI run was interrupted to apply new user steering. Full transcript artifact: ${logArtifact.id}.`
        : `AGY CLI run was aborted by the user. Full transcript artifact: ${logArtifact.id}.`,
      codeChanges,
      failureKind: interruptedBySteering ? "interrupted_by_user_steering" : "aborted",
      logArtifactId: logArtifact.id,
      rawOutputBytes,
    };
  }

  if (result.exitCode !== 0 || result.timedOut) {
    return {
      type: "failed",
      summary: boundedText(
        result.timedOut
          ? `AGY CLI timed out after ${runtime.timeoutMs}ms. ${codeChanges.length} changed file(s) were captured. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(output).length > 0 ? ` Last output excerpt:\n${tailExcerpt(output)}` : ""}`
          : `AGY CLI failed with exit code ${result.exitCode === null ? "unknown" : String(result.exitCode)}. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(output).length > 0 ? ` Last output excerpt:\n${tailExcerpt(output)}` : ""}`,
      ),
      codeChanges,
      failureKind: result.timedOut ? "timeout" : "runtime_failure",
      timedOut: result.timedOut,
      logArtifactId: logArtifact.id,
      rawOutputBytes,
      continuationRecommended: result.timedOut && codeChanges.length > 0,
    };
  }

  if (output.trim().length === 0 && codeChanges.length === 0) {
    return {
      type: "failed",
      summary: `AGY CLI exited successfully but produced no output and no workspace changes. This usually means print mode could not complete the turn before its internal timeout or was blocked by authentication/permissions. Full transcript artifact: ${logArtifact.id}.`,
      codeChanges,
      failureKind: "runtime_failure",
      logArtifactId: logArtifact.id,
      rawOutputBytes,
    };
  }

  const summary = boundedText(output.trim().length > 0 ? extractAgySummary(output) : `AGY CLI completed with ${codeChanges.length} changed file(s).`);
  return {
    type: "completed",
    summary,
    codeChanges,
    logArtifactId: logArtifact.id,
    rawOutputBytes,
    transcript: [{
      provider: "antigravity",
      model: input.agentRun.model,
      role: input.agentRun.role,
      finalText: summary,
      ts: new Date().toISOString(),
    }],
  };
}
