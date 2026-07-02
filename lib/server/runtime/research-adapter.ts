import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { saveArtifact } from "@/lib/server/artifacts";
import { emitEvent } from "@/lib/server/events";
import { logProcess } from "@/lib/server/logging";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { createOllamaClient, OllamaToolsUnsupportedError } from "@/lib/server/runtime/ollama-client";
import { resolveCodexCliBin } from "@/lib/server/runtime/codex-cli-resolver";
import { codexReadOnlySandboxArgs, codexReadOnlySandboxEnv, resolveCodexReadOnlySandbox, summarizeReadOnlyWorkspaceChanges } from "@/lib/server/runtime/codex-readonly-sandbox";
import { runCodexDoctor } from "@/lib/server/runtime/codex-doctor";
import { validateCodexModelReasoning } from "@/lib/server/runtime/codex-model-catalog";
import { resolveClaudeCodeBin } from "@/lib/server/runtime/claude-code-resolver";
import { runClaudeCodeDoctor } from "@/lib/server/runtime/claude-code-doctor";
import { validateClaudeModelEffort } from "@/lib/server/runtime/claude-model-catalog";
import { resolveAgyCliBin } from "@/lib/server/runtime/agy-cli-resolver";
import { runAgyDoctor } from "@/lib/server/runtime/agy-doctor";
import { applyAgyRuntimeModel } from "@/lib/server/runtime/agy-runtime-options";
import { registerProcess, unregisterProcess } from "@/lib/server/runtime/process-registry";
import { runProcess } from "@/lib/server/runtime/process-runner";
import { compareWorkspaceSnapshots, snapshotWorkspace } from "@/lib/server/runtime/workspace-diff";
import { boundedText, chatSummary, tailExcerpt } from "@/lib/server/text-bounds";
import { standardServiceTier } from "@/lib/shared/runtime-overrides";
import type { ChatMessage, ChatToolDef } from "@/lib/server/runtime/chat-model-client";
import type { ActivityKind, AgentRunRecord, ArtifactRecord, JsonObject, TranscriptTurnRecord, WorkSessionRecord } from "@/lib/shared/types";

export interface ResearchExecutionResult {
  type: "completed" | "failed";
  summary: string;
  reportArtifact: ArtifactRecord | null;
  logArtifact: ArtifactRecord | null;
  rawOutputBytes: number;
  transcript?: TranscriptTurnRecord[];
}

function extractMarkedBlock(text: string, startMarker: string, endMarker: string): string | null {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker);
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start + startMarker.length, end).trim();
}

function codexResearchIsolationArgs(): string[] {
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

function fallbackReport(input: { request: string; output: string }): string {
  const trimmed = input.output.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  return `# Research Report\n\nThe researcher did not produce a report body for this request:\n\n${input.request}`;
}

function fallbackSummary(report: string): string {
  const lines = report
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 6)
    .join("\n");
  return chatSummary(lines.length > 0 ? lines : report);
}

function agyPrintTimeoutArg(timeoutMs: number): string {
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
}

async function writeAgyResearchPrompt(input: { workspacePath: string; agentRunId: string; prompt: string }): Promise<string> {
  const dir = path.join(input.workspacePath, ".orchestrator");
  await mkdir(dir, { recursive: true });
  const fileName = `agy-research-prompt-${input.agentRunId}.md`;
  await writeFile(path.join(dir, fileName), input.prompt, "utf8");
  return `.orchestrator/${fileName}`;
}

const MAX_RESEARCH_READ_CHARS = 80_000;
const MAX_RESEARCH_SEARCH_FILE_BYTES = 1_000_000;
const MAX_RESEARCH_SEARCH_FILES = 1200;
const MAX_RESEARCH_SEARCH_MATCHES = 120;
const ignoredResearchNames = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".orchestrator",
  "node_modules",
  "__pycache__",
  "dist",
  "build",
  ".turbo",
]);

interface ResearchToolExecution {
  name: string;
  ok: boolean;
  result: string;
}

interface ResearchLoopOutcome {
  status: "finished" | "final_answer" | "max_iterations" | "aborted" | "model_error";
  summary: string;
  report: string;
  transcript: string;
  iterations: number;
  errorMessage: string | null;
}

function resolveInsideWorkspace(workspaceRoot: string, requested: unknown): string | null {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    return null;
  }
  const cleaned = requested.trim().replace(/^[/\\]+/, "");
  const resolved = path.resolve(workspaceRoot, cleaned);
  const rootResolved = path.resolve(workspaceRoot);
  const a = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const b = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  if (a !== b && !a.startsWith(b + path.sep)) {
    return null;
  }
  return resolved;
}

function relativeLabel(workspaceRoot: string, absolute: string): string {
  return path.relative(workspaceRoot, absolute).split(path.sep).join("/") || ".";
}

function ollamaResearchToolDefinitions(): ChatToolDef[] {
  return [
    {
      name: "list_dir",
      description: "List files and subdirectories inside the workspace. Use '.' for the workspace root.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative directory path." } } },
    },
    {
      name: "read_file",
      description: "Read UTF-8 file contents inside the workspace for research. This is read-only.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative file path." } }, required: ["path"] },
    },
    {
      name: "search_text",
      description: "Search text files inside the workspace for a literal query string.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal text to search for, case-insensitive." },
          path: { type: "string", description: "Optional workspace-relative directory to search. Defaults to '.'." },
        },
        required: ["query"],
      },
    },
    {
      name: "finish",
      description: "Finish research. Provide a concise chat summary and the full Markdown research report.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Concise user-facing Markdown summary." },
          report: { type: "string", description: "Complete Markdown research report with evidence and path references." },
        },
        required: ["summary", "report"],
      },
    },
  ];
}

async function walkResearchFiles(workspaceRoot: string, root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (output.length >= MAX_RESEARCH_SEARCH_FILES) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (output.length >= MAX_RESEARCH_SEARCH_FILES) {
        return;
      }
      if (ignoredResearchNames.has(entry.name)) {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        output.push(absolute);
      }
    }
  }
  await visit(root);
  return output.filter((file) => resolveInsideWorkspace(workspaceRoot, relativeLabel(workspaceRoot, file)) !== null);
}

async function executeResearchTool(input: { workspaceRoot: string; name: string; args: Record<string, unknown> }): Promise<ResearchToolExecution> {
  const { workspaceRoot, name, args } = input;

  if (name === "finish") {
    return { name, ok: true, result: "Acknowledged finish." };
  }

  if (name === "list_dir") {
    const target = resolveInsideWorkspace(workspaceRoot, typeof args.path === "string" && args.path.trim().length > 0 ? args.path : ".");
    if (target === null) {
      return { name, ok: false, result: "Error: path is outside the workspace and was rejected." };
    }
    try {
      const entries = await readdir(target, { withFileTypes: true });
      const lines = entries
        .filter((entry) => !(entry.isDirectory() && ignoredResearchNames.has(entry.name)))
        .slice(0, 500)
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
      const label = relativeLabel(workspaceRoot, target);
      return { name, ok: true, result: lines.length > 0 ? `${label}:\n${lines.join("\n")}` : `${label}: (empty)` };
    } catch (error) {
      return { name, ok: false, result: `Error listing directory: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (name === "read_file") {
    const target = resolveInsideWorkspace(workspaceRoot, args.path);
    if (target === null) {
      return { name, ok: false, result: "Error: path is missing or outside the workspace." };
    }
    try {
      const fileStat = await stat(target);
      if (!fileStat.isFile()) {
        return { name, ok: false, result: "Error: path is not a file." };
      }
      const content = await readFile(target, "utf8");
      const bounded = content.length > MAX_RESEARCH_READ_CHARS
        ? `${content.slice(0, MAX_RESEARCH_READ_CHARS)}\n... [truncated ${content.length - MAX_RESEARCH_READ_CHARS} chars]`
        : content;
      return { name, ok: true, result: `${relativeLabel(workspaceRoot, target)}:\n${bounded}` };
    } catch (error) {
      return { name, ok: false, result: `Error reading file: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  if (name === "search_text") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (query.length === 0) {
      return { name, ok: false, result: "Error: query is required." };
    }
    const target = resolveInsideWorkspace(workspaceRoot, typeof args.path === "string" && args.path.trim().length > 0 ? args.path : ".");
    if (target === null) {
      return { name, ok: false, result: "Error: search path is outside the workspace." };
    }
    const lowered = query.toLowerCase();
    const matches: string[] = [];
    const files = await walkResearchFiles(workspaceRoot, target);
    for (const file of files) {
      if (matches.length >= MAX_RESEARCH_SEARCH_MATCHES) {
        break;
      }
      try {
        const fileStat = await stat(file);
        if (!fileStat.isFile() || fileStat.size > MAX_RESEARCH_SEARCH_FILE_BYTES) {
          continue;
        }
        const content = await readFile(file, "utf8");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].toLowerCase().includes(lowered)) {
            matches.push(`${relativeLabel(workspaceRoot, file)}:${index + 1}: ${lines[index].trim().slice(0, 500)}`);
            if (matches.length >= MAX_RESEARCH_SEARCH_MATCHES) {
              break;
            }
          }
        }
      } catch {
      }
    }
    return {
      name,
      ok: true,
      result: matches.length > 0
        ? `Matches for "${query}" (${matches.length}${matches.length >= MAX_RESEARCH_SEARCH_MATCHES ? "+" : ""}):\n${matches.join("\n")}`
        : `No matches for "${query}" under ${relativeLabel(workspaceRoot, target)}.`,
    };
  }

  return { name, ok: false, result: `Error: unknown read-only research tool '${name}'.` };
}

interface ResearchEnvelopeAction {
  kind: "read" | "list" | "search" | "finish";
  path?: string;
  query?: string;
  summary?: string;
  report?: string;
}

const researchSimpleDirectivePattern = /<<<(READ|LIST)\s+([^\n>]+?)\s*>>>+/g;
const researchSearchPattern = /<<<SEARCH\s+([^\n>]+?)\s*>>>+/g;
const researchFinishPattern = /<<<FINISH>>>+\r?\n?([\s\S]*?)(?:<<<END>>>+|$)/;

function parseResearchEnvelopeActions(content: string): ResearchEnvelopeAction[] {
  const actions: ResearchEnvelopeAction[] = [];
  let match: RegExpExecArray | null;

  researchSimpleDirectivePattern.lastIndex = 0;
  while ((match = researchSimpleDirectivePattern.exec(content)) !== null) {
    const kind = match[1].toLowerCase() === "read" ? "read" : "list";
    actions.push({ kind, path: match[2].trim() });
  }

  researchSearchPattern.lastIndex = 0;
  while ((match = researchSearchPattern.exec(content)) !== null) {
    actions.push({ kind: "search", query: match[1].trim() });
  }

  const finishMatch = researchFinishPattern.exec(content);
  if (finishMatch !== null) {
    const body = finishMatch[1].trim();
    const summary = extractMarkedBlock(body, "RESEARCH_SUMMARY_START", "RESEARCH_SUMMARY_END") ?? fallbackSummary(body);
    const report = extractMarkedBlock(body, "RESEARCH_REPORT_START", "RESEARCH_REPORT_END") ?? body;
    actions.push({ kind: "finish", summary, report });
  }

  return actions;
}

function researchEnvelopeActionToTool(action: ResearchEnvelopeAction): { name: string; args: Record<string, unknown> } {
  switch (action.kind) {
    case "read":
      return { name: "read_file", args: { path: action.path ?? "" } };
    case "list":
      return { name: "list_dir", args: { path: action.path ?? "." } };
    case "search":
      return { name: "search_text", args: { query: action.query ?? "", path: "." } };
    case "finish":
      return { name: "finish", args: { summary: action.summary ?? "", report: action.report ?? "" } };
  }
}

async function emitResearchDelta(input: { workSession: WorkSessionRecord; agentRun: AgentRunRecord; text: string }): Promise<void> {
  const summary = input.text.replace(/\s+/g, " ").trim().slice(0, 400);
  if (summary.length === 0) {
    return;
  }
  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.process.output.delta",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { stream: "stdout", text: summary, message: `stdout: ${summary}` },
    priority: "low",
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });
}

function activityKindForResearchTool(name: string): ActivityKind {
  if (name === "finish") return "preparing_report";
  return "researching_repo";
}

function researchToolTarget(args: Record<string, unknown>): string | null {
  if (typeof args.query === "string" && args.query.trim().length > 0) return `"${args.query.trim()}"`;
  if (typeof args.path === "string" && args.path.trim().length > 0) return args.path.trim();
  return null;
}

async function emitResearchToolActivity(input: {
  workSession: WorkSessionRecord;
  agentRun: AgentRunRecord;
  eventName: "tool.started" | "tool.completed" | "tool.failed";
  toolName: string;
  args: Record<string, unknown>;
  result?: { ok: boolean; result: string };
}): Promise<void> {
  const kind = activityKindForResearchTool(input.toolName);
  const label = kind === "preparing_report" ? "Preparing report" : "Researching repo";
  const target = researchToolTarget(input.args);
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
    workSessionId: input.workSession.id,
    eventName: input.eventName,
    aggregateType: "tool_run",
    aggregateId: input.agentRun.id,
    payload,
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });
}

export async function executeResearchWithCodexCli(input: {
  workSession: WorkSessionRecord;
  agentRun: AgentRunRecord;
}): Promise<ResearchExecutionResult> {
  const config = getConfig();
  const executable = await resolveCodexCliBin();
  await mkdir(input.workSession.activeWorktreePath, { recursive: true });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.started",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Checking Codex CLI availability for read-only research." },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const doctor = await runCodexDoctor();
  if (!doctor.available || !doctor.smokeExecPassed) {
    return {
      type: "failed",
      summary: `Codex CLI preflight failed: ${doctor.error ?? "smoke exec did not pass."}`,
      reportArtifact: null,
      logArtifact: null,
      rawOutputBytes: 0,
    };
  }

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.passed",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Codex CLI preflight passed for read-only research.", version: doctor.version ?? "" },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const prompt = `You are a read-only research agent inside a local orchestration app.

User research request:
${input.workSession.lastUserMessage}

Workspace to inspect:
${input.workSession.activeWorktreePath}

Rules:
- This is research/reporting work, not implementation.
- Do not create, edit, delete, move, or format files.
- Do not install packages.
- Do not start dev servers or previews.
- Inspect the repository/workspace with read-only commands only.
- If the workspace is empty or the request cannot be answered from local files, say so clearly.
- Produce a user-facing Markdown summary report for chat and a separate complete Markdown research artifact.
- The chat summary report is the primary user-visible deliverable. It must be useful on its own, not just a pointer to an artifact.
- The full report artifact must include repository/file structure evidence and relevant file contents or excerpts when available.

Output format:
RESEARCH_SUMMARY_START
Write the complete chat reply here in Markdown. Keep it concise but substantive:
- A short title.
- Direct answer or executive summary.
- Key findings with concrete path references where useful.
- Risks, unknowns, or limits.
- Practical next steps if relevant.
Do not say that you built an app, generated a preview, or created a UI.
RESEARCH_SUMMARY_END

RESEARCH_REPORT_START
Write the full Markdown research artifact here. Include:
- The original request and scope.
- Repository/file tree or relevant file structure.
- Detailed findings.
- Evidence with concrete file paths.
- Relevant file contents or excerpts when they support the findings.
- Risks, unknowns, and practical next steps.
Do not include implementation patches.
RESEARCH_REPORT_END`;

  logProcess("info", "research.prompt.prepared", {
    workSessionId: input.workSession.id,
    agentRunId: input.agentRun.id,
    promptChars: prompt.length,
  });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.prompt.prepared",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Prepared read-only research prompt.", promptChars: String(prompt.length) },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const rawCodexEffort = (input.workSession.runtimeOverrides?.reasoningEffort ?? config.codexReasoningEffort)?.trim();
  const codexRuntime = await validateCodexModelReasoning({
    model: input.workSession.runtimeOverrides?.model ?? (config.codexModel.trim() || null),
    reasoningEffort: rawCodexEffort === undefined || rawCodexEffort.length === 0 || rawCodexEffort === "minimal" ? null : rawCodexEffort,
    serviceTier: input.workSession.runtimeOverrides?.serviceTier ?? null,
  });
  const readOnlySandbox = resolveCodexReadOnlySandbox();
  const beforeSnapshot = readOnlySandbox.enforceNoChanges ? await snapshotWorkspace(input.workSession.activeWorktreePath) : null;
  const args = [
    "exec",
    "--cd",
    input.workSession.activeWorktreePath,
    ...codexReadOnlySandboxArgs(readOnlySandbox),
    "-c",
    'approval_policy="never"',
    ...codexResearchIsolationArgs(),
    "--skip-git-repo-check",
    "--color",
    "never",
  ];
  if (codexRuntime.model !== null) args.push("-m", codexRuntime.model);
  if (codexRuntime.reasoningEffort !== null) args.push("-c", `model_reasoning_effort="${codexRuntime.reasoningEffort}"`);
  if (codexRuntime.serviceTier === standardServiceTier) {
    args.push("-c", "service_tier=null");
  } else if (codexRuntime.serviceTier !== null) {
    args.push("-c", `service_tier="${codexRuntime.serviceTier}"`, "-c", "features.fast_mode=true");
  }
  args.push(...config.codexExtraArgs, "-");

  const result = await runProcess({
    command: executable.command,
    args,
    cwd: input.workSession.activeWorktreePath,
    timeoutMs: config.codexTimeoutMs,
    stdin: prompt,
    env: createSanitizedProcessEnv({
      ...codexReadOnlySandboxEnv(readOnlySandbox),
      CODEX_APPROVAL_POLICY: "never",
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
          payload: { message: "Codex CLI research process started.", pid: pid === null ? "" : String(pid) },
          producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
          context: { agentRunId: input.agentRun.id },
        });
      },
      onExit: (processResult) => {
        void emitEvent({
          workSessionId: input.workSession.id,
          eventName: "agent.process.exited",
          aggregateType: "agent_run",
          aggregateId: input.agentRun.id,
          payload: {
            message: processResult.timedOut
              ? "Codex CLI research process timed out."
              : `Codex CLI research process exited with code ${processResult.exitCode === null ? "unknown" : String(processResult.exitCode)}.`,
            exitCode: processResult.exitCode === null ? "" : String(processResult.exitCode),
            timedOut: processResult.timedOut,
          },
          priority: processResult.exitCode === 0 && !processResult.timedOut ? "normal" : "high",
          producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
          context: { agentRunId: input.agentRun.id },
        });
      },
    },
  });

  const output = `${result.stdout}\n${result.stderr}`;
  const logArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `codex-cli-research-${input.agentRun.id}.md`,
    content: `# Codex CLI research transcript\n\n## Command\n${executable.command} ${args.join(" ")}\n\n## Exit code\n${result.exitCode === null ? "null" : String(result.exitCode)}\n\n## Timed out\n${result.timedOut ? "yes" : "no"}\n\n## Stdout\n${result.stdout}\n\n## Stderr\n${result.stderr}\n\n## Prompt\n${prompt}\n`,
    metadata: {
      agentRunId: input.agentRun.id,
      provider: "codex-cli",
      artifactRole: "research_transcript",
      reportType: "research_transcript",
      sandboxMode: readOnlySandbox.sandboxMode,
      sandboxFallbackReason: readOnlySandbox.reason ?? "",
      exitCode: result.exitCode ?? "null",
      timedOut: result.timedOut,
    },
  });

  if (beforeSnapshot !== null) {
    const afterSnapshot = await snapshotWorkspace(input.workSession.activeWorktreePath);
    const changes = await compareWorkspaceSnapshots({
      workspacePath: input.workSession.activeWorktreePath,
      before: beforeSnapshot,
      after: afterSnapshot,
    });
    if (changes.length > 0) {
      return {
        type: "failed",
        summary: boundedText(`${summarizeReadOnlyWorkspaceChanges(changes)} Full transcript artifact: ${logArtifact.id}.`),
        reportArtifact: null,
        logArtifact,
        rawOutputBytes: Buffer.byteLength(output, "utf8"),
      };
    }
  }

  if (result.exitCode !== 0 || result.timedOut) {
    const summary = result.timedOut
      ? `Research timed out after ${config.codexTimeoutMs}ms. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(output).length > 0 ? ` Last output excerpt:\n${tailExcerpt(output)}` : ""}`
      : `Research failed with exit code ${result.exitCode === null ? "unknown" : String(result.exitCode)}. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(result.stderr || result.stdout).length > 0 ? ` Last output excerpt:\n${tailExcerpt(result.stderr || result.stdout)}` : ""}`;
    return {
      type: "failed",
      summary: boundedText(summary),
      reportArtifact: null,
      logArtifact,
      rawOutputBytes: Buffer.byteLength(output, "utf8"),
    };
  }

  const report = extractMarkedBlock(output, "RESEARCH_REPORT_START", "RESEARCH_REPORT_END") ?? fallbackReport({
    request: input.workSession.lastUserMessage,
    output,
  });
  const summary = extractMarkedBlock(output, "RESEARCH_SUMMARY_START", "RESEARCH_SUMMARY_END") ?? fallbackSummary(report);
  const reportArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "report",
    fileName: `research-report-${input.agentRun.id}.md`,
    content: report,
    metadata: {
      agentRunId: input.agentRun.id,
      artifactRole: "research_full_report",
      reportType: "research",
      request: input.workSession.lastUserMessage,
      transcriptArtifactId: logArtifact.id,
    },
  });

  return {
    type: "completed",
    summary,
    reportArtifact,
    logArtifact,
    rawOutputBytes: Buffer.byteLength(output, "utf8"),
  };
}

export async function executeResearchWithClaudeCode(input: {
  workSession: WorkSessionRecord;
  agentRun: AgentRunRecord;
}): Promise<ResearchExecutionResult> {
  const config = getConfig();
  const executable = await resolveClaudeCodeBin();
  await mkdir(input.workSession.activeWorktreePath, { recursive: true });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.started",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Checking Claude Code availability for read-only research." },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const doctor = await runClaudeCodeDoctor({ force: true });
  if (!doctor.available || !doctor.smokeExecPassed) {
    return {
      type: "failed",
      summary: `Claude Code preflight failed: ${doctor.error ?? "smoke exec did not pass."}`,
      reportArtifact: null,
      logArtifact: null,
      rawOutputBytes: 0,
    };
  }
  if (doctor.authenticated === false && !config.claudeBare && (process.env.ANTHROPIC_API_KEY ?? "").trim().length === 0) {
    const message = "Claude Code is installed but not logged in. Run `claude auth login` (or `claude setup-token`), or set ANTHROPIC_API_KEY.";
    await emitEvent({
      workSessionId: input.workSession.id,
      eventName: "agent.preflight.failed",
      aggregateType: "agent_run",
      aggregateId: input.agentRun.id,
      payload: { message, version: doctor.version ?? "" },
      priority: "high",
      producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
      context: { agentRunId: input.agentRun.id },
    });
    return {
      type: "failed",
      summary: `Claude Code preflight failed: ${message}`,
      reportArtifact: null,
      logArtifact: null,
      rawOutputBytes: 0,
    };
  }

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.passed",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: doctor.error ?? "Claude Code preflight passed for read-only research.", version: doctor.version ?? "" },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const prompt = `You are a read-only research agent inside a local orchestration app.

User research request:
${input.workSession.lastUserMessage}

Workspace to inspect:
${input.workSession.activeWorktreePath}

Rules:
- This is research/reporting work, not implementation.
- Do not create, edit, delete, move, or format files.
- Do not install packages.
- Do not start dev servers or previews.
- Inspect the repository/workspace with read-only tools only.
- If the workspace is empty or the request cannot be answered from local files, say so clearly.
- Produce a user-facing Markdown summary report for chat and a separate complete Markdown research artifact.

Output format:
RESEARCH_SUMMARY_START
Write the complete chat reply here in Markdown.
RESEARCH_SUMMARY_END

RESEARCH_REPORT_START
Write the full Markdown research artifact here. Include scope, evidence with concrete file paths, risks, unknowns, and practical next steps.
RESEARCH_REPORT_END`;

  const args = [
    "-p",
    "--input-format",
    "text",
    "--output-format",
    "text",
    "--no-session-persistence",
    "--permission-mode",
    "plan",
    "--tools",
    "Read,Glob,Grep",
  ];
  if (config.claudeBare) {
    args.push("--bare");
  }
  const runtime = await validateClaudeModelEffort({
    model: input.workSession.runtimeOverrides?.model ?? (config.claudeModel.trim() || null),
    reasoningEffort: input.workSession.runtimeOverrides?.reasoningEffort ?? (config.claudeEffort.trim() || null),
    serviceTier: null,
  });
  if (runtime.model !== null) {
    args.push("--model", runtime.model);
  }
  if (runtime.reasoningEffort !== null) {
    args.push("--effort", runtime.reasoningEffort);
  }
  args.push(...config.claudeExtraArgs);

  const abortController = new AbortController();
  registerProcess({
    agentRunId: input.agentRun.id,
    workSessionId: input.workSession.id,
    abort: (reason?: string) => abortController.abort(reason),
  });
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess({
      command: executable.command,
      args,
      cwd: input.workSession.activeWorktreePath,
      timeoutMs: input.workSession.runtimeOverrides?.timeoutMs ?? config.claudeTimeoutMs,
      stdin: prompt,
      signal: abortController.signal,
      env: createSanitizedProcessEnv({ CI: "true", NEXT_TELEMETRY_DISABLED: "1" }),
      progress: {
        onStart: (pid) => {
          void emitEvent({
            workSessionId: input.workSession.id,
            eventName: "agent.process.started",
            aggregateType: "agent_run",
            aggregateId: input.agentRun.id,
            payload: { message: "Claude Code research process started.", pid: pid === null ? "" : String(pid) },
            producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
            context: { agentRunId: input.agentRun.id },
          });
        },
        onExit: (processResult) => {
          void emitEvent({
            workSessionId: input.workSession.id,
            eventName: "agent.process.exited",
            aggregateType: "agent_run",
            aggregateId: input.agentRun.id,
            payload: {
              message: processResult.timedOut
                ? "Claude Code research process timed out."
                : `Claude Code research process exited with code ${processResult.exitCode === null ? "unknown" : String(processResult.exitCode)}.`,
              exitCode: processResult.exitCode === null ? "" : String(processResult.exitCode),
              timedOut: processResult.timedOut,
            },
            priority: processResult.exitCode === 0 && !processResult.timedOut ? "normal" : "high",
            producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
            context: { agentRunId: input.agentRun.id },
          });
        },
      },
    });
  } finally {
    unregisterProcess(input.agentRun.id);
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const logArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `claude-code-research-${input.agentRun.id}.md`,
    content: `# Claude Code research transcript\n\n## Command\n${executable.command} ${args.join(" ")}\n\n## Exit code\n${result.exitCode === null ? "null" : String(result.exitCode)}\n\n## Timed out\n${result.timedOut ? "yes" : "no"}\n\n## Aborted\n${result.aborted ? "yes" : "no"}\n\n## Stdout\n${result.stdout}\n\n## Stderr\n${result.stderr}\n\n## Prompt\n${prompt}\n`,
    metadata: {
      agentRunId: input.agentRun.id,
      provider: "claude-code",
      artifactRole: "research_transcript",
      reportType: "research_transcript",
      exitCode: result.exitCode ?? "null",
      timedOut: result.timedOut,
    },
  });

  if (result.exitCode !== 0 || result.timedOut || result.aborted) {
    const summary = result.aborted
      ? `Research was aborted. Full transcript artifact: ${logArtifact.id}.`
      : result.timedOut
        ? `Research timed out after ${config.claudeTimeoutMs}ms. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(output).length > 0 ? ` Last output excerpt:\n${tailExcerpt(output)}` : ""}`
        : `Research failed with exit code ${result.exitCode === null ? "unknown" : String(result.exitCode)}. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(output).length > 0 ? ` Last output excerpt:\n${tailExcerpt(output)}` : ""}`;
    return { type: "failed", summary: boundedText(summary), reportArtifact: null, logArtifact, rawOutputBytes: Buffer.byteLength(output, "utf8") };
  }

  const report = extractMarkedBlock(output, "RESEARCH_REPORT_START", "RESEARCH_REPORT_END") ?? fallbackReport({ request: input.workSession.lastUserMessage, output });
  const summary = extractMarkedBlock(output, "RESEARCH_SUMMARY_START", "RESEARCH_SUMMARY_END") ?? fallbackSummary(report);
  const reportArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "report",
    fileName: `research-report-${input.agentRun.id}.md`,
    content: report,
    metadata: {
      agentRunId: input.agentRun.id,
      artifactRole: "research_full_report",
      reportType: "research",
      request: input.workSession.lastUserMessage,
      transcriptArtifactId: logArtifact.id,
    },
  });

  return { type: "completed", summary, reportArtifact, logArtifact, rawOutputBytes: Buffer.byteLength(output, "utf8") };
}

export async function executeResearchWithAgy(input: {
  workSession: WorkSessionRecord;
  agentRun: AgentRunRecord;
}): Promise<ResearchExecutionResult> {
  const config = getConfig();
  const executable = await resolveAgyCliBin();
  const workspacePath = input.workSession.activeWorktreePath;
  await mkdir(workspacePath, { recursive: true });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.started",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Checking AGY CLI availability for read-only research." },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const doctor = await runAgyDoctor();
  if (!doctor.available || !doctor.smokeExecPassed) {
    return {
      type: "failed",
      summary: `AGY CLI preflight failed: ${doctor.error ?? "agy --version did not pass."}`,
      reportArtifact: null,
      logArtifact: null,
      rawOutputBytes: 0,
    };
  }

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.passed",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: doctor.error ?? "AGY CLI preflight passed for read-only research.", version: doctor.version ?? "" },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const modelApplication = await applyAgyRuntimeModel(input.workSession.runtimeOverrides?.model ?? null);
  if (modelApplication.error !== null) {
    return {
      type: "failed",
      summary: `AGY CLI model selection failed before research launch: ${modelApplication.error}`,
      reportArtifact: null,
      logArtifact: null,
      rawOutputBytes: 0,
    };
  }

  const prompt = `You are a read-only research agent inside a local orchestration app.

User research request:
${input.workSession.lastUserMessage}

Workspace to inspect:
${workspacePath}

Rules:
- This is research/reporting work, not implementation.
- Do not create, edit, delete, move, or format files.
- Do not install packages.
- Do not start dev servers or previews.
- Inspect the repository/workspace with read-only tools only.
- Do not create background subagents or branches.
- If the workspace is empty or the request cannot be answered from local files, say so clearly.
- Produce a user-facing Markdown summary report for chat and a separate complete Markdown research artifact.

Output format:
RESEARCH_SUMMARY_START
Write the complete chat reply here in Markdown.
RESEARCH_SUMMARY_END

RESEARCH_REPORT_START
Write the full Markdown research artifact here. Include scope, evidence with concrete file paths, risks, unknowns, and practical next steps.
RESEARCH_REPORT_END`;
  const promptPath = await writeAgyResearchPrompt({ workspacePath, agentRunId: input.agentRun.id, prompt });
  const launcherPrompt = `Read ${promptPath} in this workspace and follow it exactly. This is read-only research; do not edit files. Print the marked summary and report blocks.`;
  const timeoutMs = input.workSession.runtimeOverrides?.timeoutMs ?? config.agyTimeoutMs;
  const args = [
    "--add-dir",
    workspacePath,
    "--print-timeout",
    agyPrintTimeoutArg(timeoutMs),
  ];
  if (config.agySandbox) {
    args.push("--sandbox");
  }
  if (config.agyDangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  args.push(...config.agyExtraArgs, "--print", launcherPrompt);

  const abortController = new AbortController();
  registerProcess({
    agentRunId: input.agentRun.id,
    workSessionId: input.workSession.id,
    abort: (reason?: string) => abortController.abort(reason),
  });
  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess({
      command: executable.command,
      args,
      cwd: workspacePath,
      timeoutMs: timeoutMs + 15_000,
      signal: abortController.signal,
      env: createSanitizedProcessEnv({
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
            payload: { message: "AGY CLI research process started.", pid: pid === null ? "" : String(pid) },
            producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
            context: { agentRunId: input.agentRun.id },
          });
        },
        onExit: (processResult) => {
          void emitEvent({
            workSessionId: input.workSession.id,
            eventName: "agent.process.exited",
            aggregateType: "agent_run",
            aggregateId: input.agentRun.id,
            payload: {
              message: processResult.timedOut
                ? "AGY CLI research process timed out."
                : `AGY CLI research process exited with code ${processResult.exitCode === null ? "unknown" : String(processResult.exitCode)}.`,
              exitCode: processResult.exitCode === null ? "" : String(processResult.exitCode),
              timedOut: processResult.timedOut,
            },
            priority: processResult.exitCode === 0 && !processResult.timedOut ? "normal" : "high",
            producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
            context: { agentRunId: input.agentRun.id },
          });
        },
      },
    });
  } finally {
    unregisterProcess(input.agentRun.id);
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const logArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `agy-research-${input.agentRun.id}.md`,
    content: `# AGY research transcript\n\n## Command\n${executable.command} ${args.join(" ")}\n\n## Model\n${modelApplication.model ?? "AGY settings default"}${modelApplication.changed ? " (applied to AGY settings before launch)" : ""}\n\n## Exit code\n${result.exitCode === null ? "null" : String(result.exitCode)}\n\n## Timed out\n${result.timedOut ? "yes" : "no"}\n\n## Aborted\n${result.aborted ? "yes" : "no"}\n\n## Stdout\n${result.stdout}\n\n## Stderr\n${result.stderr}\n\n## Prompt file\n${promptPath}\n\n## Prompt\n${prompt}\n`,
    metadata: {
      agentRunId: input.agentRun.id,
      provider: "antigravity-cli",
      artifactRole: "research_transcript",
      reportType: "research_transcript",
      model: modelApplication.model ?? "settings-default",
      modelSettingsChanged: modelApplication.changed,
      exitCode: result.exitCode ?? "null",
      timedOut: result.timedOut,
    },
  });

  if (result.exitCode !== 0 || result.timedOut || result.aborted || output.trim().length === 0) {
    const summary = result.aborted
      ? `Research was aborted. Full transcript artifact: ${logArtifact.id}.`
      : result.timedOut
        ? `Research timed out after ${timeoutMs}ms. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(output).length > 0 ? ` Last output excerpt:\n${tailExcerpt(output)}` : ""}`
        : result.exitCode !== 0
          ? `Research failed with exit code ${result.exitCode === null ? "unknown" : String(result.exitCode)}. Full transcript artifact: ${logArtifact.id}.${tailExcerpt(output).length > 0 ? ` Last output excerpt:\n${tailExcerpt(output)}` : ""}`
          : `AGY research exited successfully but produced no output. Full transcript artifact: ${logArtifact.id}.`;
    return { type: "failed", summary: boundedText(summary), reportArtifact: null, logArtifact, rawOutputBytes: Buffer.byteLength(output, "utf8") };
  }

  const report = extractMarkedBlock(output, "RESEARCH_REPORT_START", "RESEARCH_REPORT_END") ?? fallbackReport({ request: input.workSession.lastUserMessage, output });
  const summary = extractMarkedBlock(output, "RESEARCH_SUMMARY_START", "RESEARCH_SUMMARY_END") ?? fallbackSummary(report);
  const reportArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "report",
    fileName: `research-report-${input.agentRun.id}.md`,
    content: report,
    metadata: {
      agentRunId: input.agentRun.id,
      provider: "antigravity-cli",
      artifactRole: "research_full_report",
      reportType: "research",
      request: input.workSession.lastUserMessage,
      transcriptArtifactId: logArtifact.id,
    },
  });

  return { type: "completed", summary, reportArtifact, logArtifact, rawOutputBytes: Buffer.byteLength(output, "utf8") };
}

export async function executeResearchWithOllama(input: {
  workSession: WorkSessionRecord;
  agentRun: AgentRunRecord;
}): Promise<ResearchExecutionResult> {
  const config = getConfig();
  const workspaceRoot = input.workSession.activeWorktreePath;
  const client = createOllamaClient();
  const model = input.workSession.runtimeOverrides?.model ?? (config.ollamaModel.trim().length > 0 ? config.ollamaModel.trim() : null);
  await mkdir(workspaceRoot, { recursive: true });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.started",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Checking Ollama availability for read-only research." },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const doctor = await client.doctor();
  if (!doctor.available || model === null) {
    const reason = model === null
      ? "No Ollama model is configured. Set OLLAMA_MODEL or choose a model in the Runtime drawer."
      : doctor.error ?? "Ollama is not reachable.";
    return {
      type: "failed",
      summary: `Ollama research preflight failed: ${reason}`,
      reportArtifact: null,
      logArtifact: null,
      rawOutputBytes: 0,
    };
  }

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.preflight.passed",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: `Ollama reachable with ${doctor.modelCount} model(s).`, version: doctor.version ?? "" },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const systemPrompt = `You are a read-only research agent inside a local orchestration app.

Rules:
- This is research/reporting work, not implementation.
- Do not create, edit, delete, move, or format files.
- Do not install packages.
- Do not start dev servers or previews.
- Use only the read-only tools offered to inspect the workspace.
- If the workspace is empty or the request cannot be answered from local files, say so clearly.
- Produce a user-facing Markdown summary and a separate complete Markdown research artifact.
- The full report must include repository/file structure evidence and concrete path references where useful.

Act in one of two ways:
1) Native tool calls: list_dir(path), read_file(path), search_text(query, path), finish(summary, report).
2) Text directives if native tools are unavailable:
<<<LIST .>>>
<<<READ relative/path.ext>>>
<<<SEARCH literal text>>>
<<<FINISH>>>
RESEARCH_SUMMARY_START
Markdown summary for chat.
RESEARCH_SUMMARY_END
RESEARCH_REPORT_START
Full Markdown research artifact.
RESEARCH_REPORT_END
<<<END>>>`;

  const userPrompt = `User research request:
${input.workSession.lastUserMessage}

Workspace to inspect:
${workspaceRoot}

Start by listing the workspace root. Then inspect only the files needed to answer the request. Finish with both a concise chat summary and a complete Markdown report.`;

  const toolsMode = config.ollamaToolsMode;
  const offerNativeTools = toolsMode !== "envelope";
  const tools = offerNativeTools ? ollamaResearchToolDefinitions() : undefined;
  const timeoutMs = input.workSession.runtimeOverrides?.timeoutMs ?? config.ollamaTimeoutMs;
  const temperature = input.workSession.runtimeOverrides?.temperature ?? config.ollamaTemperature;
  const numCtx = input.workSession.runtimeOverrides?.numCtx ?? config.ollamaNumCtx;

  logProcess("info", "research.ollama.prompt.prepared", {
    workSessionId: input.workSession.id,
    agentRunId: input.agentRun.id,
    model,
    toolsMode,
    promptChars: systemPrompt.length + userPrompt.length,
  });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.prompt.prepared",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: "Prepared Ollama read-only research prompt.", promptChars: String(systemPrompt.length + userPrompt.length) },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const abortController = new AbortController();
  registerProcess({
    agentRunId: input.agentRun.id,
    workSessionId: input.workSession.id,
    abort: (reason?: string) => abortController.abort(reason),
  });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.process.started",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: { message: `Ollama research loop started (model ${model}).`, pid: "" },
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  let outcome: ResearchLoopOutcome;
  try {
    outcome = await runOllamaResearchLoop({
      input,
      model,
      client,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      workspaceRoot,
      tools,
      offerNativeTools,
      toolsMode,
      timeoutMs,
      temperature,
      numCtx,
      keepAlive: config.ollamaKeepAlive,
      maxIterations: config.ollamaMaxIterations,
      abortController,
    });
  } finally {
    unregisterProcess(input.agentRun.id);
  }

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: "agent.process.exited",
    aggregateType: "agent_run",
    aggregateId: input.agentRun.id,
    payload: {
      message: `Ollama research loop ended (${outcome.status}) after ${outcome.iterations} iteration(s).`,
      exitCode: outcome.status === "finished" || outcome.status === "final_answer" ? "0" : "",
      timedOut: false,
    },
    priority: outcome.status === "aborted" || outcome.status === "model_error" ? "high" : "normal",
    producer: { module: "research-adapter", runtimeKind: input.agentRun.runtimeKind, role: input.agentRun.role },
    context: { agentRunId: input.agentRun.id },
  });

  const transcriptContent = `# Ollama research transcript

## Model
${model}

## Outcome
${outcome.status} (${outcome.iterations} iteration(s))${outcome.errorMessage !== null ? `\nError: ${outcome.errorMessage}` : ""}

## Transcript
${outcome.transcript}

## System Prompt
${systemPrompt}

## User Prompt
${userPrompt}
`;

  const logArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `ollama-research-${input.agentRun.id}.md`,
    content: transcriptContent,
    metadata: {
      agentRunId: input.agentRun.id,
      provider: "ollama",
      model,
      artifactRole: "research_transcript",
      reportType: "research_transcript",
      outcome: outcome.status,
      iterations: outcome.iterations,
    },
  });

  if (outcome.status === "aborted") {
    return {
      type: "failed",
      summary: `Ollama research was aborted by the user. Transcript artifact: ${logArtifact.id}.`,
      reportArtifact: null,
      logArtifact,
      rawOutputBytes: Buffer.byteLength(transcriptContent, "utf8"),
    };
  }

  if (outcome.status === "model_error") {
    return {
      type: "failed",
      summary: boundedText(`Ollama research model error: ${outcome.errorMessage ?? "unknown error"}. Transcript artifact: ${logArtifact.id}.`),
      reportArtifact: null,
      logArtifact,
      rawOutputBytes: Buffer.byteLength(transcriptContent, "utf8"),
    };
  }

  const report = outcome.report.trim().length > 0
    ? outcome.report
    : fallbackReport({ request: input.workSession.lastUserMessage, output: outcome.transcript });
  const summary = outcome.summary.trim().length > 0 ? outcome.summary : fallbackSummary(report);
  const reportArtifact = await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "report",
    fileName: `research-report-${input.agentRun.id}.md`,
    content: report,
    metadata: {
      agentRunId: input.agentRun.id,
      provider: "ollama",
      model,
      artifactRole: "research_full_report",
      reportType: "research",
      request: input.workSession.lastUserMessage,
      transcriptArtifactId: logArtifact.id,
    },
  });

  return {
    type: "completed",
    summary,
    reportArtifact,
    logArtifact,
    rawOutputBytes: Buffer.byteLength(transcriptContent, "utf8"),
  };
}

async function runOllamaResearchLoop(ctx: {
  input: { workSession: WorkSessionRecord; agentRun: AgentRunRecord };
  model: string;
  client: ReturnType<typeof createOllamaClient>;
  messages: ChatMessage[];
  workspaceRoot: string;
  tools: ChatToolDef[] | undefined;
  offerNativeTools: boolean;
  toolsMode: "auto" | "native" | "envelope";
  timeoutMs: number;
  temperature: number | null;
  numCtx: number | null;
  keepAlive: string;
  maxIterations: number;
  abortController: AbortController;
}): Promise<ResearchLoopOutcome> {
  const transcriptLines: string[] = [];
  let iterations = 0;
  let toolsEnabled = ctx.offerNativeTools;
  let noActionNudges = 0;

  for (let i = 0; i < ctx.maxIterations; i += 1) {
    if (ctx.abortController.signal.aborted) {
      return researchOutcomeFrom("aborted", "", "", iterations, transcriptLines, null);
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
        return researchOutcomeFrom("aborted", "", "", iterations, transcriptLines, null);
      }
      if (error instanceof OllamaToolsUnsupportedError && toolsEnabled) {
        toolsEnabled = false;
        iterations -= 1;
        i -= 1;
        transcriptLines.push(`### Notice: model '${ctx.model}' does not support tool calls; switching to directive mode.`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      transcriptLines.push(`### Iteration ${iterations}: model error\n${message}`);
      return researchOutcomeFrom("model_error", "", "", iterations, transcriptLines, message);
    }

    ctx.messages.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
    transcriptLines.push(`### Iteration ${iterations}: assistant\n${turn.content.slice(0, 4000)}`);

    const markedSummary = extractMarkedBlock(turn.content, "RESEARCH_SUMMARY_START", "RESEARCH_SUMMARY_END");
    const markedReport = extractMarkedBlock(turn.content, "RESEARCH_REPORT_START", "RESEARCH_REPORT_END");
    if (markedSummary !== null && markedReport !== null && turn.toolCalls.length === 0) {
      await emitResearchDelta({ workSession: ctx.input.workSession, agentRun: ctx.input.agentRun, text: markedSummary });
      return researchOutcomeFrom("final_answer", markedSummary, markedReport, iterations, transcriptLines, null);
    }

    const usedNative = turn.toolCalls.length > 0;
    const calls = usedNative
      ? turn.toolCalls.map((call) => ({ name: call.name, args: call.arguments }))
      : (toolsEnabled && ctx.toolsMode === "native" ? [] : parseResearchEnvelopeActions(turn.content).map(researchEnvelopeActionToTool));

    if (calls.length === 0) {
      if (noActionNudges < 2) {
        noActionNudges += 1;
        transcriptLines.push(`### Iteration ${iterations}: no actionable output; nudging to inspect or finish (${noActionNudges}).`);
        ctx.messages.push({
          role: "user",
          content: "Use read-only tools or directives to inspect files. If you have enough evidence, finish now with RESEARCH_SUMMARY_START/END and RESEARCH_REPORT_START/END.",
        });
        continue;
      }
      await emitResearchDelta({ workSession: ctx.input.workSession, agentRun: ctx.input.agentRun, text: turn.content });
      return researchOutcomeFrom("final_answer", fallbackSummary(turn.content), turn.content, iterations, transcriptLines, null);
    }

    const toolResultMessages: ChatMessage[] = [];
    let finished = false;
    let finishSummary = "";
    let finishReport = "";

    for (const call of calls) {
      if (call.name === "finish") {
        finished = true;
        finishSummary = typeof call.args.summary === "string" ? call.args.summary : "";
        finishReport = typeof call.args.report === "string" ? call.args.report : "";
        if (finishSummary.trim().length === 0) {
          finishSummary = markedSummary ?? fallbackSummary(finishReport || turn.content);
        }
        if (finishReport.trim().length === 0) {
          finishReport = markedReport ?? turn.content;
        }
        transcriptLines.push(`### Iteration ${iterations}: finish\n${finishSummary.slice(0, 1000)}`);
        await emitResearchToolActivity({
          workSession: ctx.input.workSession,
          agentRun: ctx.input.agentRun,
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
      await emitResearchToolActivity({
        workSession: ctx.input.workSession,
        agentRun: ctx.input.agentRun,
        eventName: "tool.started",
        toolName: call.name,
        args: call.args,
      });
      const execution = await executeResearchTool({ workspaceRoot: ctx.workspaceRoot, name: call.name, args: call.args });
      await emitResearchToolActivity({
        workSession: ctx.input.workSession,
        agentRun: ctx.input.agentRun,
        eventName: execution.ok ? "tool.completed" : "tool.failed",
        toolName: call.name,
        args: call.args,
        result: execution,
      });
      transcriptLines.push(`### Iteration ${iterations}: tool ${call.name}\n${execution.result.slice(0, 2000)}`);
      if (usedNative) {
        toolResultMessages.push({ role: "tool", content: execution.result, toolName: call.name });
      } else {
        toolResultMessages.push({ role: "user", content: `Tool ${call.name} result:\n${execution.result}\n\nContinue researching, or emit <<<FINISH>>> when done.` });
      }
      await emitResearchDelta({ workSession: ctx.input.workSession, agentRun: ctx.input.agentRun, text: `${call.name}: ${execution.result}` });
    }

    ctx.messages.push(...toolResultMessages);
    if (finished) {
      await emitResearchDelta({ workSession: ctx.input.workSession, agentRun: ctx.input.agentRun, text: finishSummary });
      return researchOutcomeFrom("finished", finishSummary, finishReport, iterations, transcriptLines, null);
    }
  }

  return researchOutcomeFrom("max_iterations", "", "", iterations, transcriptLines, null);
}

function researchOutcomeFrom(
  status: ResearchLoopOutcome["status"],
  summary: string,
  report: string,
  iterations: number,
  transcriptLines: string[],
  errorMessage: string | null,
): ResearchLoopOutcome {
  return {
    status,
    summary,
    report,
    iterations,
    transcript: transcriptLines.join("\n\n"),
    errorMessage,
  };
}
