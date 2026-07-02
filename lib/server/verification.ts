import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { npmMaxSatisfyingVersion } from "@/lib/server/dependency-research";
import { saveArtifact } from "@/lib/server/artifacts";
import { emitEvent } from "@/lib/server/events";
import { eslintFlatConfigFiles } from "@/lib/server/next-eslint-config";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolveDotnetCommand } from "@/lib/server/runtime/dotnet-resolver";
import { resolvePackageManagerCommand, type PackageManagerName } from "@/lib/server/runtime/package-manager-resolver";
import { resolveComposerCommand, resolvePhpCommand } from "@/lib/server/runtime/php-resolver";
import { readExperimentManifest } from "@/lib/server/ml/experiment-manifest";
import { analyzeRequirements, ensureCudaTorch, verifyVenvTorchInstall } from "@/lib/server/ml/ml-installer";
import { mlCacheEnv } from "@/lib/server/ml/ml-env";
import { ensurePythonWorkspaceEnvironment, pythonWorkspaceEnv } from "@/lib/server/runtime/python-environment";
import { resolvePythonCommand } from "@/lib/server/runtime/python-resolver";
import { resolveRscriptCommand } from "@/lib/server/runtime/r-resolver";
import { rLibraryDir } from "@/lib/server/runtime/r-environment";
import { runProcess, runShellCommand, type ProcessEnvironment, type ProcessResult } from "@/lib/server/runtime/process-runner";
import { traced } from "@/lib/server/tracing";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import { classifyProductIntent, isPlainStaticWebPageRequest, isSingleFileHtmlRequest, validateRequestIntentCoverage } from "@/lib/shared/request-intent";
import { filterBuildVerificationCommands, isBuildVerificationCommand, userExplicitlyRequestedBuildVerification } from "@/lib/shared/verification-commands";
import type { Identifier, StackDecision, VerificationCommandResult, VerificationFailureKind, WorkSessionRecord } from "@/lib/shared/types";

export type VerificationPhase = "workspace" | "install" | "command" | "package_imports" | "structural" | "functional" | "geometry" | "visual";

export interface VerificationCheck {
  phase: VerificationPhase;
  status: "passed" | "failed" | "skipped";
  failureKind: VerificationFailureKind;
  message: string;
}

interface VerificationProgressContext {
  workSessionId: Identifier;
  verificationRunId?: Identifier;
  planId?: Identifier;
}

const javaVerificationClassesDir = path.join(".orchestrator", "java-verify-classes");

export interface VerificationExecutionResult {
  status: "passed" | "failed";
  failureKind: VerificationFailureKind;
  summary: string;
  rawOutput: string;
  commands: string[];
  checks: VerificationCheck[];
  commandResults: VerificationCommandResult[];
}

function boundedVerificationOutput(text: string, max = 4000): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= max) return trimmed;
  const headLen = Math.floor(max * 0.6);
  const tailLen = max - headLen;
  const omitted = trimmed.length - headLen - tailLen;
  return `${trimmed.slice(0, headLen)}\n…(${omitted} characters omitted)…\n${trimmed.slice(-tailLen)}`;
}

function createVerificationEnv(overrides: ProcessEnvironment = {}): ProcessEnvironment {
  return createSanitizedProcessEnv({
    CI: "true",
    NEXT_TELEMETRY_DISABLED: "1",
    ...overrides,
  });
}

async function directoryExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function listPublicHtmlPages(workspacePath: string): Promise<Array<{ file: string; route: string; name: string }>> {
  const publicDir = path.join(workspacePath, "public");
  let entries;
  try {
    entries = await readdir(publicDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".html"))
    .map((entry) => {
      const stem = entry.name.replace(/\.html$/i, "");
      const route = stem.toLowerCase() === "index" ? "/" : `/${stem}`;
      const name = stem
        .split(/[-_\s]+/)
        .filter((part) => part.length > 0)
        .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(" ") || "Root";
      return { file: `public/${entry.name}`, route, name };
    })
    .sort((a, b) => a.route.localeCompare(b.route));
}

async function workspaceHasAnyFile(workspacePath: string, fileNames: string[]): Promise<boolean> {
  for (const fileName of fileNames) {
    if (await fileExists(path.join(workspacePath, fileName))) {
      return true;
    }
  }
  return false;
}

const eslintRcFiles = [".eslintrc", ".eslintrc.json", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.yaml", ".eslintrc.yml"];

async function createVerificationCommandEnv(workspacePath: string): Promise<ProcessEnvironment> {
  const hasLegacyEslintConfig = await workspaceHasAnyFile(workspacePath, eslintRcFiles);
  const hasFlatEslintConfig = await workspaceHasAnyFile(workspacePath, eslintFlatConfigFiles);
  return createVerificationEnv(hasLegacyEslintConfig && !hasFlatEslintConfig
    ? { ESLINT_USE_FLAT_CONFIG: "false" }
    : {});
}

function commandRequiresPackageScripts(command: string): boolean {
  return /^(npm|pnpm|yarn|bun)\s+/.test(command.trim());
}

function commandRequiresPython(command: string): boolean {
  return /^(python3?|py)\s+/.test(command.trim());
}

function commandRequiresR(command: string): boolean {
  return /^Rscript(?:\.exe)?\s+/i.test(command.trim());
}

function structuredRCommand(command: string): { args: string[] } | null {
  const head = command.trim().match(/^Rscript(?:\.exe)?\s+([\s\S]+)$/i);
  if (head === null) {
    return null;
  }
  const rest = head[1] ?? "";
  const marker = rest.match(/(^|\s)-e\s+/);
  if (marker !== null) {
    const before = rest.slice(0, marker.index ?? 0).trim();
    const expr = rest.slice((marker.index ?? 0) + marker[0].length);
    const flagTokens = before.length > 0 ? before.split(/\s+/) : [];
    return { args: [...flagTokens, "-e", expr] };
  }
  const tokens = tokenizeCommand(rest);
  if (tokens === null || tokens.some((token) => /[<>|&;]/.test(token))) {
    return null;
  }
  return { args: tokens };
}

function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (quote !== null) {
    return null;
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

function asFilePathArg(file: string): string {
  return file.replace(/\\/g, "/").startsWith("-") ? `./${file}` : file;
}

function structuredPythonCommand(command: string): { command: string; args: string[] } | null {
  const tokens = tokenizeCommand(command.trim());
  if (tokens === null || tokens.length === 0) {
    return null;
  }

  const executable = tokens[0] ?? "";
  if (!/^(?:python3?|py)(?:\.exe)?$/i.test(executable)) {
    return null;
  }
  if (tokens.some((token) => /[<>|&]/.test(token))) {
    return null;
  }
  return { command: executable, args: tokens.slice(1) };
}

function structuredPhpCommand(command: string): { tool: "php" | "composer"; args: string[] } | null {
  const tokens = tokenizeCommand(command.trim());
  if (tokens === null || tokens.length === 0) {
    return null;
  }
  if (tokens.some((token) => /[<>|&;]/.test(token))) {
    return null;
  }

  const executable = tokens[0] ?? "";
  if (/^php(?:\.(?:exe|cmd|bat))?$/i.test(executable)) {
    return { tool: "php", args: tokens.slice(1) };
  }
  if (/^composer(?:\.(?:exe|cmd|bat))?$/i.test(executable)) {
    return { tool: "composer", args: tokens.slice(1) };
  }
  return null;
}

function structuredNativeCommand(command: string): { command: string; args: string[] } | null {
  const tokens = tokenizeCommand(command.trim());
  if (tokens === null || tokens.length === 0) {
    return null;
  }
  if (tokens.some((token) => /[<>|&;]/.test(token))) {
    return null;
  }

  const executable = tokens[0] ?? "";
  if (!/^(?:javac|java|dotnet)(?:\.exe)?$/i.test(executable)) {
    return null;
  }
  return { command: executable, args: tokens.slice(1) };
}

async function prepareStructuredNativeCommand(input: {
  command: string;
  args: string[];
  cwd: string;
}): Promise<{ command: string; args: string[] }> {
  if (/^(?:dotnet)(?:\.exe)?$/i.test(input.command)) {
    return {
      command: input.command,
      args: prepareDotnetVerificationArgs(input.args),
    };
  }
  if (!/^(?:javac)(?:\.exe)?$/i.test(input.command)) {
    return input;
  }
  const outputDirIndex = input.args.findIndex((arg) => arg === "-d");
  if (outputDirIndex >= 0) {
    const outputDir = input.args[outputDirIndex + 1];
    if (outputDir !== undefined && !outputDir.startsWith("-")) {
      await mkdir(path.join(input.cwd, outputDir), { recursive: true });
    }
    return input;
  }

  await rm(path.join(input.cwd, javaVerificationClassesDir), { recursive: true, force: true });
  await mkdir(path.join(input.cwd, javaVerificationClassesDir), { recursive: true });
  return {
    command: input.command,
    args: ["-d", javaVerificationClassesDir, ...input.args],
  };
}

function prepareDotnetVerificationArgs(args: string[]): string[] {
  const verb = args[0]?.toLowerCase();
  if (verb !== "build") {
    return args;
  }
  const hasUseAppHost = args.some((arg) => /^[-/]p:UseAppHost=/i.test(arg) || /^[-/]property:UseAppHost=/i.test(arg));
  return hasUseAppHost ? args : [...args, "/p:UseAppHost=false"];
}

async function runVerificationCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env: ProcessEnvironment;
  signal?: AbortSignal;
  progress?: Parameters<typeof runProcess>[0]["progress"];
}): Promise<Awaited<ReturnType<typeof runProcess>>> {
  throwIfAborted(input.signal);
  const structured = structuredPythonCommand(input.command);
  if (structured !== null) {
    const python = await resolvePythonCommand(input.cwd);
    return runProcess({
      command: python.command,
      args: structured.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env: input.env,
      signal: input.signal,
      progress: input.progress,
    });
  }

  const rCommand = structuredRCommand(input.command);
  if (rCommand !== null) {
    const rscript = await resolveRscriptCommand();
    return runProcess({
      command: rscript.command,
      args: rCommand.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env: { ...input.env, R_LIBS_USER: rLibraryDir(input.cwd) },
      signal: input.signal,
      progress: input.progress,
    });
  }

  const php = structuredPhpCommand(input.command);
  if (php !== null) {
    const resolution = php.tool === "composer" ? await resolveComposerCommand() : await resolvePhpCommand();
    return runProcess({
      command: resolution.command,
      args: php.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env: input.env,
      signal: input.signal,
      progress: input.progress,
    });
  }

  const native = structuredNativeCommand(input.command);
  if (native !== null) {
    const prepared = await prepareStructuredNativeCommand({ ...native, cwd: input.cwd });
    if (/^(?:dotnet)(?:\.exe)?$/i.test(prepared.command)) {
      const dotnet = await resolveDotnetCommand();
      return runProcess({
        command: dotnet.command,
        args: prepared.args,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        env: input.env,
        signal: input.signal,
        progress: input.progress,
      });
    }
    return runProcess({
      command: prepared.command,
      args: prepared.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
      env: input.env,
      signal: input.signal,
      progress: input.progress,
    });
  }

  return runShellCommand(input);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    throw new DOMException("Operation aborted by user.", "AbortError");
  }
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

function createVerificationOutputEmitter(input: {
  progress: VerificationProgressContext;
  command: string;
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
      workSessionId: input.progress.workSessionId,
      eventName: "verification.command.output.delta",
      aggregateType: "verification_run",
      aggregateId: input.progress.verificationRunId ?? null,
      payload: {
        command: input.command,
        stream,
        text: summary,
        message: `${stream}: ${summary}`,
      },
      priority: "low",
      producer: { module: "verification-engine", runtimeKind: "codex", role: "verifier" },
      context: { planId: input.progress.planId, verificationRunId: input.progress.verificationRunId },
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

async function emitVerificationCommandEvent(input: {
  progress?: VerificationProgressContext;
  eventName: "verification.command.started" | "verification.command.passed" | "verification.command.skipped" | "verification.command.failed";
  command: string;
  message: string;
  exitCode?: number | null;
  timedOut?: boolean;
}): Promise<void> {
  if (input.progress === undefined) {
    return;
  }
  await emitEvent({
    workSessionId: input.progress.workSessionId,
    eventName: input.eventName,
    aggregateType: "verification_run",
    aggregateId: input.progress.verificationRunId ?? null,
    payload: {
      command: input.command,
      message: input.message,
      exitCode: input.exitCode === undefined || input.exitCode === null ? "" : String(input.exitCode),
      timedOut: input.timedOut ?? false,
    },
    priority: input.eventName === "verification.command.failed" ? "high" : "normal",
    producer: { module: "verification-engine", runtimeKind: "codex", role: "verifier" },
    context: { planId: input.progress.planId, verificationRunId: input.progress.verificationRunId },
  });
}

const ignoredPythonVerificationDirectories = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".orchestrator",
  ".pytest_cache",
  ".venv",
  "build",
  "dist",
  "env",
  "node_modules",
  "tests",
  "venv",
  "__pycache__",
]);
const ignoredPythonVerificationScriptNames = new Set(["__init__.py", "conftest.py"]);

function shellQuote(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

async function collectPythonScriptFiles(workspacePath: string, current = "", depth = 0): Promise<string[]> {
  if (depth > 3) {
    return [];
  }

  let entries;
  try {
    entries = await readdir(path.join(workspacePath, current), { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (ignoredPythonVerificationDirectories.has(entry.name)) {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectPythonScriptFiles(workspacePath, relative, depth + 1));
      continue;
    }
    if (
      entry.name.endsWith(".py")
      && !ignoredPythonVerificationScriptNames.has(entry.name)
      && !/^test_.*\.py$/.test(entry.name)
      && !/_test\.py$/.test(entry.name)
    ) {
      files.push(relative.replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

function scorePythonVerificationEntrypoint(file: string, source: string): number {
  const name = path.basename(file);
  let score = 0;

  if (file === "main.py") score += 100;
  if (file === "app.py") score += 50;
  if (!file.includes("/")) score += 25;
  if (/if\s+__name__\s*==\s*["']__main__["']/.test(source)) score += 45;
  if (/\bmatplotlib\b|\bpyplot\b|\bplt\./.test(source)) score += 20;
  if (/^(test_|.*_test\.py$)/.test(name)) score -= 60;

  return score;
}

async function findPythonVerificationEntrypoint(workspacePath: string): Promise<string | null> {
  const files = await collectPythonScriptFiles(workspacePath);
  if (files.length === 0) {
    return null;
  }

  const scored = await Promise.all(files.map(async (file) => {
    const source = await readFile(path.join(workspacePath, file), "utf8").catch(() => "");
    return { file, score: scorePythonVerificationEntrypoint(file, source) };
  }));
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored[0]?.file ?? null;
}

async function defaultPythonVerificationCommands(workspacePath: string): Promise<string[]> {
  const experiment = await readExperimentManifest(workspacePath);
  if (experiment !== null) {
    const entry = asFilePathArg(experiment.entrypoint);
    return [
      `python -m py_compile ${shellQuote(entry)}`,
      `python ${shellQuote(entry)} --smoke`,
      `python -c "import json,sys; r=json.load(open('smoke_report.json')); sys.exit(0 if r.get('passed') else 1)"`,
    ];
  }
  if (await fileExists(path.join(workspacePath, "manage.py"))) {
    return [
      "python -m py_compile manage.py",
      "python manage.py check",
      "python manage.py makemigrations --check --dry-run",
      "python manage.py migrate --plan --noinput",
    ];
  }
  if (await fileExists(path.join(workspacePath, "app.py"))) {
    return ["python -m py_compile app.py"];
  }
  const scriptPath = await findPythonVerificationEntrypoint(workspacePath);
  if (scriptPath !== null) {
    return [`python -m py_compile ${shellQuote(asFilePathArg(scriptPath))}`];
  }
  return [];
}

function isRLibraryPath(file: string): boolean {
  return /(^|\/)(\.rlib|renv|packrat|\.Rproj\.user)\//.test(file);
}

async function findRVerificationEntrypoint(workspacePath: string): Promise<string | null> {
  const files = (await collectWorkspaceFilesMatching(workspacePath, (entry) => /\.[rR]$/.test(entry)))
    .filter((file) => !isRLibraryPath(file));
  if (files.length === 0) {
    return null;
  }
  const shinyNames = new Set(["app.r", "ui.r", "server.r", "global.r"]);
  const score = (file: string): number => {
    const name = path.basename(file).toLowerCase();
    let value = 0;
    if (name === "main.r") value += 100;
    if (!file.includes("/")) value += 25;
    if (/^test[-_]|[-_]test\.r$/.test(name)) value -= 60;
    if (shinyNames.has(name)) value -= 120;
    return value;
  };
  const sorted = [...files].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  const best = sorted[0];
  return best !== undefined && score(best) >= 0 ? best : null;
}

async function defaultRVerificationCommands(workspacePath: string): Promise<string[]> {
  const parseCommand = (file: string): string => `Rscript -e invisible(parse(file="${file.replace(/\\/g, "/")}"))`;
  if (await fileExists(path.join(workspacePath, "app.R"))) {
    return [parseCommand("app.R")];
  }
  const hasUi = await fileExists(path.join(workspacePath, "ui.R"));
  const hasServerR = await fileExists(path.join(workspacePath, "server.R"));
  if (hasUi && hasServerR) {
    return [parseCommand("ui.R"), parseCommand("server.R")];
  }
  const entrypoint = await findRVerificationEntrypoint(workspacePath);
  if (entrypoint !== null) {
    return [parseCommand(entrypoint)];
  }
  return [];
}

async function workspaceContainsFileMatching(workspacePath: string, predicate: (fileName: string) => boolean): Promise<boolean> {
  const entries = await readdir(workspacePath).catch(() => []);
  return entries.some(predicate);
}

function isDotnetProjectFile(file: string): boolean {
  return file.endsWith(".csproj") || file.endsWith(".sln");
}

async function collectWorkspaceFilesMatching(workspacePath: string, predicate: (fileName: string) => boolean, current = "", depth = 0): Promise<string[]> {
  if (depth > 8) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(path.join(workspacePath, current), { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (ignoredSourceDirectories.has(entry.name)) {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectWorkspaceFilesMatching(workspacePath, predicate, relative, depth + 1));
      continue;
    }
    if (predicate(entry.name)) {
      files.push(relative.replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

async function dotnetVerificationCommands(workspacePath: string): Promise<string[]> {
  const projectFiles = await collectWorkspaceFilesMatching(workspacePath, isDotnetProjectFile);
  const solutionFiles = projectFiles.filter((file) => file.endsWith(".sln"));
  const buildTargets = solutionFiles.length > 0 ? solutionFiles : projectFiles.filter((file) => file.endsWith(".csproj"));
  return buildTargets.map((file) => `dotnet build ${shellQuote(asFilePathArg(file))}`);
}

function isRazorPageFile(file: string): boolean {
  return /^Pages\/.+\.cshtml$/i.test(file.replace(/\\/g, "/"));
}

async function collectRazorPageFiles(workspacePath: string): Promise<string[]> {
  return collectWorkspaceFilesMatching(workspacePath, (entry) => entry.toLowerCase().endsWith(".cshtml"));
}

function isPhpLintCandidate(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (parts.some((part) => part === "vendor" || part === "storage" || part === "node_modules" || part === ".orchestrator")) {
    return false;
  }
  if (normalized.startsWith("bootstrap/cache/")) {
    return false;
  }
  if (normalized === "artisan") {
    return true;
  }
  if (!normalized.toLowerCase().endsWith(".php")) {
    return false;
  }
  if (!normalized.includes("/")) {
    return true;
  }
  return /^(public|routes|bootstrap|app|config)\//.test(normalized);
}

function phpLintPriority(file: string): number {
  const normalized = file.replace(/\\/g, "/");
  if (normalized === "public/index.php") return 0;
  if (normalized === "index.php") return 1;
  if (normalized === "bootstrap/app.php") return 2;
  if (normalized.startsWith("routes/")) return 3;
  if (normalized.startsWith("app/")) return 4;
  if (normalized.startsWith("config/")) return 5;
  if (normalized.startsWith("public/")) return 6;
  return 10;
}

async function phpVerificationCommands(workspacePath: string): Promise<string[]> {
  const files = await collectWorkspaceFilesMatching(
    workspacePath,
    (entry) => entry.toLowerCase().endsWith(".php") || entry === "artisan",
  );
  const lintTargets = files
    .filter(isPhpLintCandidate)
    .sort((left, right) => phpLintPriority(left) - phpLintPriority(right) || left.localeCompare(right))
    .slice(0, 64);
  const commands = (await fileExists(path.join(workspacePath, "composer.json"))) ? ["composer install --no-interaction"] : [];
  if (lintTargets.length > 0) {
    commands.push(...lintTargets.map((file) => `php -l ${shellQuote(asFilePathArg(file))}`));
  } else if (await fileExists(path.join(workspacePath, "public", "index.php"))) {
    commands.push("php -l public/index.php");
  } else if (await fileExists(path.join(workspacePath, "index.php"))) {
    commands.push("php -l index.php");
  }
  return Array.from(new Set(commands));
}

function razorUsesMvcTagHelpers(source: string): boolean {
  return /\basp-[a-z0-9-]+\s*=/.test(source) || /\b(?:href|src)\s*=\s*["']~\//i.test(source);
}

function razorUsesUnqualifiedModel(source: string): boolean {
  const match = source.match(/^\s*@model\s+([A-Za-z_][\w]*(?:<[^>\r\n]+>)?)\s*$/m);
  return match !== null && !match[1].includes(".");
}

async function defaultPolyglotVerificationCommands(workspacePath: string): Promise<string[]> {
  if (await fileExists(path.join(workspacePath, "go.mod")) || await workspaceContainsFileMatching(workspacePath, (entry) => entry.endsWith(".go"))) {
    return ["go test ./...", "go vet ./..."];
  }
  if (await fileExists(path.join(workspacePath, "Cargo.toml"))) {
    return ["cargo check", "cargo test"];
  }
  const dotnetCommands = await dotnetVerificationCommands(workspacePath);
  if (dotnetCommands.length > 0) {
    return dotnetCommands;
  }
  if (await fileExists(path.join(workspacePath, "pom.xml"))) {
    return ["mvn test"];
  }
  if (await fileExists(path.join(workspacePath, "build.gradle")) || await fileExists(path.join(workspacePath, "build.gradle.kts"))) {
    return ["gradle test"];
  }
  const javaFiles = await collectWorkspaceFilesMatching(workspacePath, (entry) => entry.endsWith(".java"));
  if (javaFiles.length > 0) {
    return [`javac -d ${shellQuote(javaVerificationClassesDir)} ${javaFiles.map((file) => shellQuote(asFilePathArg(file))).join(" ")}`];
  }
  if (await fileExists(path.join(workspacePath, "composer.json")) || await fileExists(path.join(workspacePath, "public", "index.php")) || await fileExists(path.join(workspacePath, "index.php"))) {
    return phpVerificationCommands(workspacePath);
  }
  if (await fileExists(path.join(workspacePath, "Gemfile"))) {
    return ["bundle install", "ruby -c app.rb"];
  }
  if (await fileExists(path.join(workspacePath, "app.rb"))) {
    return ["ruby -c app.rb"];
  }
  const rCommands = await defaultRVerificationCommands(workspacePath);
  if (rCommands.length > 0) {
    return rCommands;
  }
  return defaultPythonVerificationCommands(workspacePath);
}

async function verificationCommandsForWorkspace(workspacePath: string, configuredCommands: string[]): Promise<string[]> {
  if (await fileExists(path.join(workspacePath, "manage.py"))) {
    const defaultCommands = await defaultPythonVerificationCommands(workspacePath);
    const compatiblePythonCommands = configuredCommands.filter(commandRequiresPython);
    return Array.from(new Set([...compatiblePythonCommands, ...defaultCommands]));
  }

  if (await fileExists(path.join(workspacePath, "app.py"))) {
    const compatiblePythonCommands = configuredCommands.filter(commandRequiresPython);
    return compatiblePythonCommands.length > 0 ? compatiblePythonCommands : await defaultPythonVerificationCommands(workspacePath);
  }

  const hasJavaWorkspace =
    await fileExists(path.join(workspacePath, "pom.xml")) ||
    await fileExists(path.join(workspacePath, "build.gradle")) ||
    await fileExists(path.join(workspacePath, "build.gradle.kts")) ||
    (await collectWorkspaceFilesMatching(workspacePath, (entry) => entry.endsWith(".java"))).length > 0;
  if (hasJavaWorkspace) {
    const compatibleJavaCommands = configuredCommands.filter((command) => /^(javac|java|mvn|gradle|\.\\mvnw|\.\/mvnw|\.\\gradlew|\.\/gradlew)\b/.test(command.trim()));
    return compatibleJavaCommands.length > 0 ? compatibleJavaCommands : await defaultPolyglotVerificationCommands(workspacePath);
  }

  const hasPhpWorkspace =
    await fileExists(path.join(workspacePath, "composer.json")) ||
    await fileExists(path.join(workspacePath, "public", "index.php")) ||
    await fileExists(path.join(workspacePath, "index.php")) ||
    (await collectWorkspaceFilesMatching(workspacePath, (entry) => entry.toLowerCase().endsWith(".php"))).length > 0;
  if (hasPhpWorkspace) {
    const compatiblePhpCommands = configuredCommands.filter((command) => /^(php|composer)(?:\.(?:exe|cmd|bat))?(?:\s|$)/i.test(command.trim()));
    return Array.from(new Set([...compatiblePhpCommands, ...(await phpVerificationCommands(workspacePath))]));
  }

  const hasRWorkspace =
    await fileExists(path.join(workspacePath, "app.R")) ||
    await fileExists(path.join(workspacePath, "main.R")) ||
    await fileExists(path.join(workspacePath, "DESCRIPTION")) ||
    (await collectWorkspaceFilesMatching(workspacePath, (entry) => /\.[rR]$/.test(entry))).some((file) => !isRLibraryPath(file));
  if (hasRWorkspace) {
    const compatibleRCommands = configuredCommands.filter(commandRequiresR);
    return compatibleRCommands.length > 0 ? compatibleRCommands : await defaultRVerificationCommands(workspacePath);
  }

  if (configuredCommands.length === 0) {
    return defaultPolyglotVerificationCommands(workspacePath);
  }

  const dotnetCommands = await dotnetVerificationCommands(workspacePath);
  if (await fileExists(path.join(workspacePath, "package.json"))) {
    return Array.from(new Set([...configuredCommands, ...dotnetCommands]));
  }

  const compatibleCommands = configuredCommands.filter((command) =>
    /^(python|py|go|cargo|dotnet|mvn|gradle|php|composer|ruby|bundle)(?:\.(?:exe|cmd|bat))?\s+/i.test(command.trim())
  );
  if (compatibleCommands.length > 0) {
    return compatibleCommands;
  }

  const defaultCommands = await defaultPolyglotVerificationCommands(workspacePath);
  return defaultCommands.length > 0 ? defaultCommands : configuredCommands;
}

async function readPackageJson(workspacePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readJsonFile(pathname: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(pathname, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readTextIfExists(pathname: string): Promise<string | null> {
  try {
    return await readFile(pathname, "utf8");
  } catch {
    return null;
  }
}

function recordKeys(value: unknown): string[] {
  return isObject(value) ? Object.keys(value) : [];
}

function packageDependencyNames(packageJson: Record<string, unknown> | null): Set<string> {
  if (packageJson === null) {
    return new Set();
  }
  return new Set([...recordKeys(packageJson.dependencies), ...recordKeys(packageJson.devDependencies)]);
}

function packageDependencyEntries(packageJson: Record<string, unknown>): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const group of [packageJson.dependencies, packageJson.devDependencies]) {
    if (!isObject(group)) {
      continue;
    }
    for (const [name, version] of Object.entries(group)) {
      if (typeof version === "string") {
        entries.push([name, version]);
      }
    }
  }
  return entries;
}

function nodeModulePackageJsonPath(workspacePath: string, packageName: string): string {
  return path.join(workspacePath, "node_modules", ...packageName.split("/"), "package.json");
}

async function installedPackageVersion(workspacePath: string, packageName: string): Promise<string | null> {
  try {
    const packageJson = JSON.parse(await readFile(nodeModulePackageJsonPath(workspacePath, packageName), "utf8")) as Record<string, unknown>;
    return typeof packageJson.version === "string" ? packageJson.version : null;
  } catch {
    return null;
  }
}

function exactVersionFromSpec(versionSpec: string): string | null {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/.test(versionSpec) ? versionSpec : null;
}

async function packageDependenciesAreInstalled(workspacePath: string, packageJson: Record<string, unknown>): Promise<boolean> {
  const dependencies = packageDependencyEntries(packageJson);
  if (dependencies.length === 0) {
    return true;
  }
  if (!(await directoryExists(path.join(workspacePath, "node_modules")))) {
    return false;
  }
  for (const [dependency, versionSpec] of dependencies) {
    const installedVersion = await installedPackageVersion(workspacePath, dependency);
    if (installedVersion === null) {
      return false;
    }
    const exactVersion = exactVersionFromSpec(versionSpec);
    if (exactVersion !== null && installedVersion !== exactVersion) {
      return false;
    }
  }
  return true;
}

function packageScriptValues(packageJson: Record<string, unknown> | null): string[] {
  if (packageJson === null || !isObject(packageJson.scripts)) {
    return [];
  }
  return Object.values(packageJson.scripts).filter((value): value is string => typeof value === "string");
}

function workspaceUsesBundledHtmlEntry(packageJson: Record<string, unknown> | null): boolean {
  const dependencies = packageDependencyNames(packageJson);
  const scripts = packageScriptValues(packageJson);
  return dependencies.has("vite") || dependencies.has("next") || scripts.some((script) => /\b(vite|next)\b/.test(script));
}

function packageUsesFrontendFramework(packageJson: Record<string, unknown> | null): boolean {
  const dependencies = packageDependencyNames(packageJson);
  const scripts = packageScriptValues(packageJson);
  return (
    ["next", "vite", "react", "react-dom", "@vitejs/plugin-react", "vue", "svelte", "@angular/core", "astro", "@remix-run/react"].some((dependency) => dependencies.has(dependency)) ||
    scripts.some((script) => /\b(next|vite|astro|remix)\b/.test(script))
  );
}

function includesRouteLink(html: string, href: string): boolean {
  return new RegExp(`<a\\b[^>]*href=["']${href.replace("/", "\\/")}["']`, "i").test(html);
}

function includesAssetReference(html: string, attribute: "href" | "src", value: string): boolean {
  return new RegExp(`${attribute}=["']${escapeRegExp(value)}["']`, "i").test(html);
}

function includesRootAssetReference(html: string, attribute: "href" | "src", pathname: string): boolean {
  const bare = pathname.replace(/^\//, "");
  return [
    pathname,
    bare,
    `./${bare}`,
  ].some((candidate) => includesAssetReference(html, attribute, candidate));
}

const ignoredSourceDirectories = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".turbo",
  ".orchestrator",
  ".venv",
  "__pycache__",
  "dist",
  "node_modules",
  "out",
  "storage",
  "vendor",
  "venv",
]);
const sourceFilePattern = /\.(?:css|cjs|mjs|js|jsx|ts|tsx)$/;
const intentSourceFilePattern = /\.(?:css|cjs|html|mjs|js|jsx|py|ts|tsx)$/;
const maxIntentSourceBytes = 500_000;
const nodeBuiltins = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
]);

function packageNameFromImportSpecifier(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.length === 0 || /^(?:https?:)?\/\//.test(specifier)) {
    return null;
  }
  if (specifier.startsWith("node:")) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope !== undefined && name !== undefined ? `${scope}/${name}` : null;
  }
  const packageName = specifier.split("/")[0] ?? null;
  return packageName !== null && nodeBuiltins.has(packageName) ? null : packageName;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageScripts(packageJson: Record<string, unknown> | null): Set<string> {
  if (packageJson === null || !isObject(packageJson.scripts)) {
    return new Set();
  }
  return new Set(Object.keys(packageJson.scripts));
}

function configuredPackageScript(command: string): string | null {
  const match = command.trim().match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)(?:\s|$)/);
  if (match === null) {
    return null;
  }
  const script = match[1] ?? "";
  if (["install", "add", "remove", "ci"].includes(script)) {
    return null;
  }
  return script;
}

function fallbackCommandsForPackageScripts(packageJson: Record<string, unknown> | null, configuredCommands: string[]): string[] {
  const scripts = packageScripts(packageJson);
  if (scripts.size === 0) {
    return [];
  }
  const packageCommand = configuredCommands.find(commandRequiresPackageScripts)?.split(/\s+/)[0] ?? "npm";
  return ["typecheck", "lint", "test", "build"]
    .filter((script) => scripts.has(script))
    .map((script) => `${packageCommand} run ${script}`);
}

function filterRunnableCommands(input: {
  packageJson: Record<string, unknown> | null;
  configuredCommands: string[];
  checks: VerificationCheck[];
}): string[] {
  if (input.packageJson === null) {
    return input.configuredCommands;
  }

  const scripts = packageScripts(input.packageJson);
  const runnable = input.configuredCommands.filter((command) => {
    const script = configuredPackageScript(command);
    if (script === null) {
      return true;
    }
    const exists = scripts.has(script);
    if (!exists) {
      input.checks.push({
        phase: "command",
        status: "skipped",
        failureKind: "verification_contract_failure",
        message: `Skipped configured verification command "${command}" because package.json does not define script "${script}".`,
      });
    }
    return exists;
  });

  if (runnable.length > 0) {
    return runnable;
  }

  const fallback = fallbackCommandsForPackageScripts(input.packageJson, input.configuredCommands);
  if (fallback.length > 0) {
    input.checks.push({
      phase: "command",
      status: "passed",
      failureKind: "none",
      message: `Using package.json verification fallback commands: ${fallback.join("; ")}`,
    });
    return fallback;
  }

  return [];
}

function packageNames(value: unknown): Set<string> {
  if (typeof value !== "object" || value === null) {
    return new Set();
  }
  return new Set(Object.keys(value));
}

async function collectSourceFiles(root: string, current = "", depth = 0): Promise<string[]> {
  if (depth > 8) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(path.join(root, current), { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (ignoredSourceDirectories.has(entry.name)) {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(root, relative, depth + 1));
      continue;
    }
    if (sourceFilePattern.test(entry.name)) {
      files.push(relative.replace(/\\/g, "/"));
    }
  }
  return files;
}

async function collectIntentSourceFiles(root: string, current = "", depth = 0): Promise<string[]> {
  if (depth > 8) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(path.join(root, current), { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (ignoredSourceDirectories.has(entry.name)) {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectIntentSourceFiles(root, relative, depth + 1));
      continue;
    }
    if (intentSourceFilePattern.test(entry.name)) {
      files.push(relative.replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

async function resolveExistingModule(workspacePath: string, candidate: string): Promise<boolean> {
  const normalized = candidate.replace(/\\/g, "/").replace(/^\/+/, "");
  const absolute = path.join(workspacePath, normalized);
  const candidates = [
    absolute,
    ...(absolute.endsWith(".js") ? [`${absolute.slice(0, -3)}.ts`, `${absolute.slice(0, -3)}.tsx`] : []),
    ...(absolute.endsWith(".jsx") ? [`${absolute.slice(0, -4)}.tsx`] : []),
    ...(absolute.endsWith(".mjs") ? [`${absolute.slice(0, -4)}.mts`] : []),
    ...(absolute.endsWith(".cjs") ? [`${absolute.slice(0, -4)}.cts`] : []),
    `${absolute}.ts`,
    `${absolute}.tsx`,
    `${absolute}.js`,
    `${absolute}.jsx`,
    `${absolute}.mjs`,
    `${absolute}.cjs`,
    `${absolute}.css`,
    path.join(absolute, "index.ts"),
    path.join(absolute, "index.tsx"),
    path.join(absolute, "index.js"),
    path.join(absolute, "index.jsx"),
  ];
  for (const candidatePath of candidates) {
    if (await fileExists(candidatePath)) {
      return true;
    }
  }
  return false;
}

function tsconfigPaths(tsconfig: Record<string, unknown> | null): Record<string, string[]> {
  const compilerOptions = isObject(tsconfig?.compilerOptions) ? tsconfig.compilerOptions : null;
  if (!isObject(compilerOptions?.paths)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(compilerOptions.paths)
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((value) => typeof value === "string"))
  );
}

function tsconfigBaseUrl(tsconfig: Record<string, unknown> | null): string {
  return tsconfigExplicitBaseUrl(tsconfig) ?? ".";
}

function tsconfigExplicitBaseUrl(tsconfig: Record<string, unknown> | null): string | null {
  const compilerOptions = isObject(tsconfig?.compilerOptions) ? tsconfig.compilerOptions : null;
  return typeof compilerOptions?.baseUrl === "string" ? compilerOptions.baseUrl : null;
}

async function resolvesAsLocalSpecifier(input: {
  workspacePath: string;
  sourceFile: string;
  specifier: string;
  packageJson: Record<string, unknown>;
  tsconfig: Record<string, unknown> | null;
}): Promise<boolean> {
  const specifier = input.specifier;
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const base = specifier.startsWith("/")
      ? specifier.slice(1)
      : path.join(path.dirname(input.sourceFile), specifier);
    return resolveExistingModule(input.workspacePath, base);
  }

  if (specifier.startsWith("#") && isObject(input.packageJson.imports) && Object.keys(input.packageJson.imports).some((key) => key === specifier || key.endsWith("/*") && specifier.startsWith(key.slice(0, -1)))) {
    return true;
  }

  for (const [alias, targets] of Object.entries(tsconfigPaths(input.tsconfig))) {
    if (alias.endsWith("/*")) {
      const prefix = alias.slice(0, -1);
      if (!specifier.startsWith(prefix)) {
        continue;
      }
      const suffix = specifier.slice(prefix.length);
      for (const target of targets) {
        const resolved = target.endsWith("/*") ? `${target.slice(0, -1)}${suffix}` : target;
        if (await resolveExistingModule(input.workspacePath, path.join(tsconfigBaseUrl(input.tsconfig), resolved))) {
          return true;
        }
      }
      continue;
    }
    if (alias === specifier) {
      for (const target of targets) {
        if (await resolveExistingModule(input.workspacePath, path.join(tsconfigBaseUrl(input.tsconfig), target))) {
          return true;
        }
      }
    }
  }

  const explicitBaseUrl = tsconfigExplicitBaseUrl(input.tsconfig);
  if (explicitBaseUrl !== null && await resolveExistingModule(input.workspacePath, path.join(explicitBaseUrl, specifier))) {
    return true;
  }

  return false;
}

function importedSpecifiers(source: string, file: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/\bimport\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]/g)) {
    specifiers.push(match[1] ?? "");
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    specifiers.push(match[1] ?? "");
  }
  for (const match of source.matchAll(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    specifiers.push(match[1] ?? "");
  }
  if (file.endsWith(".css")) {
    for (const match of source.matchAll(/@import\s+(?:url\()?["']([^"')]+)["']\)?/g)) {
      specifiers.push(match[1] ?? "");
    }
  }
  return specifiers;
}

async function runPackageImportVerification(workspacePath: string): Promise<{ failed: boolean; output: string; checks: VerificationCheck[] } | null> {
  const packageJson = await readPackageJson(workspacePath);
  if (packageJson === null) {
    return null;
  }
  const compilerConfig = await readJsonFile(path.join(workspacePath, "tsconfig.json"))
    ?? await readJsonFile(path.join(workspacePath, "jsconfig.json"));

  const declaredPackages = new Set([
    ...packageNames(packageJson.dependencies),
    ...packageNames(packageJson.devDependencies),
  ]);
  const files = await collectSourceFiles(workspacePath);
  const checks: string[] = [];
  const failures: string[] = [];

  for (const file of files) {
    const source = await readTextIfExists(path.join(workspacePath, file));
    if (source === null) {
      continue;
    }

    for (const specifier of importedSpecifiers(source, file)) {
      if (await resolvesAsLocalSpecifier({ workspacePath, sourceFile: file, specifier, packageJson, tsconfig: compilerConfig })) {
        checks.push(`PASS ${file} imports local module "${specifier}".`);
        continue;
      }
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        checks.push(`FAIL ${file} imports unresolved local module "${specifier}".`);
        failures.push(`${file} imports "${specifier}", but no matching local file exists from ${path.dirname(file).replace(/\\/g, "/") || "."}. Use the correct relative path or create the target module.`);
        continue;
      }
      if (specifier.startsWith("@/")) {
        checks.push(`FAIL ${file} imports unresolved local alias "${specifier}".`);
        failures.push(`${file} imports "${specifier}", but no tsconfig.json or jsconfig.json paths entry resolves the @/* alias. Add a matching compilerOptions.paths entry or use a correct relative import.`);
        continue;
      }
      const packageName = packageNameFromImportSpecifier(specifier);
      if (packageName === null) {
        continue;
      }
      const message = `${file} imports package "${packageName}" via "${specifier}".`;
      if (declaredPackages.has(packageName)) {
        checks.push(`PASS ${message}`);
      } else {
        checks.push(`FAIL ${message}`);
        failures.push(`${file} imports "${specifier}", but package "${packageName}" is not declared in package.json.`);
      }
    }
  }

  if (checks.length === 0) {
    return null;
  }

  return {
    failed: failures.length > 0,
    output: `Package import verification\n${checks.join("\n")}${failures.length > 0 ? `\n\nFailures:\n${failures.map((failure) => `- ${failure}`).join("\n")}` : ""}\n`,
    checks: failures.length > 0
      ? failures.map((failure) => ({ phase: "package_imports", status: "failed", failureKind: "source_failure", message: failure }))
      : [{ phase: "package_imports", status: "passed", failureKind: "none", message: "Package import verification passed." }],
  };
}

function extractPythonImportRoots(source: string): string[] {
  const roots = new Set<string>();
  for (const line of source.split(/\r?\n/)) {
    const fromMatch = line.match(/^from\s+([.\w]+)\s+import\b/);
    if (fromMatch !== null) {
      const target = fromMatch[1];
      if (target.startsWith(".")) {
        continue; // relative import — resolves locally
      }
      const root = target.split(".")[0];
      if (/^[A-Za-z_]\w*$/.test(root)) {
        roots.add(root);
      }
      continue;
    }
    const importMatch = line.match(/^import\s+(.+?)\s*$/);
    if (importMatch !== null) {
      for (const part of importMatch[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim().split(".")[0];
        if (/^[A-Za-z_]\w*$/.test(name)) {
          roots.add(name);
        }
      }
    }
  }
  return [...roots];
}

function markerExcludesCurrentPlatform(marker: string): boolean {
  const m = marker.toLowerCase().replace(/['"]/g, '"').replace(/\s+/g, " ").trim();
  if (m.length === 0 || m.includes(" or ")) {
    return false;
  }
  const platform = process.platform; // "win32" | "linux" | "darwin" | ...
  const systemName = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  const sysNe = m.match(/sys_platform\s*!=\s*"([a-z0-9]+)"/);
  if (sysNe !== null && sysNe[1] === platform) return true;
  const sysEq = m.match(/sys_platform\s*==\s*"([a-z0-9]+)"/);
  if (sysEq !== null && sysEq[1] !== platform) return true;
  const sysSystemNe = m.match(/platform_system\s*!=\s*"([a-z]+)"/);
  if (sysSystemNe !== null && sysSystemNe[1] === systemName) return true;
  const sysSystemEq = m.match(/platform_system\s*==\s*"([a-z]+)"/);
  if (sysSystemEq !== null && sysSystemEq[1] !== systemName) return true;
  return false;
}

function requirementMarkerExcludesImport(requirementsText: string, importName: string): string | null {
  const target = importName.toLowerCase().replace(/[_.]/g, "-");
  for (const rawLine of requirementsText.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();
    const semi = line.indexOf(";");
    if (line.length === 0 || line.startsWith("-") || semi < 0) {
      continue;
    }
    const nameMatch = line.slice(0, semi).match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
    if (nameMatch === null || nameMatch[0].toLowerCase().replace(/[_.]/g, "-") !== target) {
      continue;
    }
    const marker = line.slice(semi + 1).trim();
    if (markerExcludesCurrentPlatform(marker)) {
      return marker;
    }
  }
  return null;
}

const IMPORT_TO_DISTRIBUTIONS: Record<string, string[]> = {
  yaml: ["pyyaml"],
  sklearn: ["scikit-learn"],
  cv2: ["opencv-python", "opencv-python-headless", "opencv-contrib-python"],
  pil: ["pillow"],
  bs4: ["beautifulsoup4"],
  dotenv: ["python-dotenv"],
  dateutil: ["python-dateutil"],
  attr: ["attrs"],
  attrs: ["attrs"],
};

function normalizeDistName(name: string): string {
  return name.toLowerCase().replace(/[_.]/g, "-");
}

function requirementsDistNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (line.length === 0 || line.startsWith("-")) {
      continue;
    }
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (match !== null) {
      names.push(normalizeDistName(match[1]));
    }
  }
  return names;
}

function pyprojectDistNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[<>=!~;[].*)?["']/g)) {
    names.push(normalizeDistName(match[1]));
  }
  const poetry = text.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?:\n\[|$)/);
  if (poetry !== null) {
    for (const match of poetry[1].matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/gm)) {
      names.push(normalizeDistName(match[1]));
    }
  }
  return names;
}

async function collectPythonDeclaredAndLocalNames(
  workspacePath: string,
  current = "",
  depth = 0,
  acc?: { declared: Set<string>; local: Set<string> },
): Promise<{ declared: Set<string>; local: Set<string> }> {
  const result = acc ?? { declared: new Set<string>(), local: new Set<string>() };
  if (depth > 3) {
    return result;
  }
  let entries;
  try {
    entries = await readdir(path.join(workspacePath, current), { withFileTypes: true });
  } catch {
    return result;
  }
  if (current.length > 0 && entries.some((entry) => entry.isFile() && entry.name === "__init__.py")) {
    result.local.add(path.basename(current));
  }
  for (const entry of entries) {
    if (ignoredPythonVerificationDirectories.has(entry.name)) {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectPythonDeclaredAndLocalNames(workspacePath, relative, depth + 1, result);
    } else if (entry.isFile() && /^requirements.*\.txt$/i.test(entry.name)) {
      const text = await readTextIfExists(path.join(workspacePath, relative));
      if (text !== null) {
        for (const name of requirementsDistNames(text)) {
          result.declared.add(name);
        }
      }
    } else if (entry.isFile() && entry.name === "pyproject.toml") {
      const text = await readTextIfExists(path.join(workspacePath, relative));
      if (text !== null) {
        for (const name of pyprojectDistNames(text)) {
          result.declared.add(name);
        }
      }
    }
  }
  return result;
}

async function runPythonImportVerification(workspacePath: string): Promise<{ failed: boolean; output: string; checks: VerificationCheck[] } | null> {
  const files = await collectPythonScriptFiles(workspacePath);
  if (files.length === 0) {
    return null;
  }
  const roots = new Set<string>();
  for (const file of files) {
    const source = await readTextIfExists(path.join(workspacePath, file));
    if (source === null) {
      continue;
    }
    for (const root of extractPythonImportRoots(source)) {
      roots.add(root);
    }
  }
  const candidates = [...roots];
  if (candidates.length === 0) {
    return null;
  }
  const probe = [
    "import importlib.util, json, sys",
    "mods = json.loads(sys.argv[1])",
    "missing = []",
    "for m in mods:",
    "    try:",
    "        if importlib.util.find_spec(m) is None:",
    "            missing.append(m)",
    "    except Exception:",
    "        missing.append(m)",
    "print(json.dumps(missing))",
  ].join("\n");
  let python;
  try {
    python = await resolvePythonCommand(workspacePath);
  } catch {
    return null;
  }
  const result = await runProcess({
    command: python.command,
    args: ["-c", probe, JSON.stringify(candidates)],
    cwd: workspacePath,
    timeoutMs: 60000,
    env: createSanitizedProcessEnv({ CI: "true" }),
  });
  if (result.exitCode !== 0 || result.timedOut) {
    return null; // could not run the probe (no usable interpreter) — do not block on an environment issue
  }
  let missing: string[];
  try {
    const lastLine = result.stdout.trim().split(/\r?\n/).pop() ?? "[]";
    const parsed: unknown = JSON.parse(lastLine);
    missing = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return null;
  }
  const { declared, local } = await collectPythonDeclaredAndLocalNames(workspacePath);
  const isSatisfied = (mod: string): boolean => {
    const normalized = normalizeDistName(mod);
    if (local.has(mod) || local.has(normalized)) {
      return true;
    }
    if (declared.has(normalized)) {
      return true;
    }
    const aliases = IMPORT_TO_DISTRIBUTIONS[mod.toLowerCase()] ?? [];
    return aliases.some((alias) => declared.has(normalizeDistName(alias)));
  };
  const trulyMissing = missing.filter((mod) => !isSatisfied(mod));
  if (trulyMissing.length === 0) {
    return {
      failed: false,
      output: `Python import verification\nPASS all ${candidates.length} imported third-party module(s) are importable or declared.\n`,
      checks: [{ phase: "package_imports", status: "passed", failureKind: "none", message: "Python import verification passed." }],
    };
  }
  const requirementsText = await readTextIfExists(path.join(workspacePath, "requirements.txt"));
  const hasRequirements = requirementsText !== null;
  const failureKind: VerificationFailureKind = hasRequirements ? "dependency_failure" : "source_failure";
  const checks: VerificationCheck[] = trulyMissing.map((mod) => {
    const excludingMarker = requirementsText !== null ? requirementMarkerExcludesImport(requirementsText, mod) : null;
    const message = excludingMarker !== null
      ? `Imported module "${mod}" is declared in requirements.txt but its line is skipped on this platform (${process.platform}) by the environment marker "${excludingMarker}". Remove the marker so the package installs here (or fix the import).`
      : `Imported module "${mod}" is not importable in the workspace environment and is not declared in any requirements.txt or pyproject.toml in the project. Add it to a requirements file (or fix the import).`;
    return { phase: "package_imports", status: "failed", failureKind, message };
  });
  const output = `Python import verification\n${candidates.map((mod) => `${trulyMissing.includes(mod) ? "FAIL" : "PASS"} ${mod}`).join("\n")}\n\nMissing: ${trulyMissing.join(", ")}\n`;
  return { failed: true, output, checks };
}

function htmlUsesExternalCssOrScript(html: string): boolean {
  return (
    /<link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref=["'](?!data:|#)[^"']+["']/i.test(html) ||
    /<script\b[^>]*\bsrc=["'](?!data:|#)[^"']+["']/i.test(html)
  );
}

async function readIntentSourceText(workspacePath: string, files: string[]): Promise<{ text: string; fileSources: Map<string, string> }> {
  const chunks: string[] = [];
  const fileSources = new Map<string, string>();
  let bytes = 0;
  for (const file of files) {
    if (bytes >= maxIntentSourceBytes) {
      break;
    }
    const source = await readTextIfExists(path.join(workspacePath, file));
    if (source === null) {
      continue;
    }
    const remaining = maxIntentSourceBytes - bytes;
    const bounded = source.slice(0, remaining);
    bytes += bounded.length;
    fileSources.set(file, bounded);
    chunks.push(`\n--- ${file} ---\n${bounded}`);
  }
  return { text: chunks.join("\n"), fileSources };
}

function primaryHtmlSource(fileSources: Map<string, string>): { file: string; source: string } | null {
  for (const file of ["index.html", "public/index.html", "app/page.tsx", "src/App.tsx"]) {
    const source = fileSources.get(file);
    if (source !== undefined) {
      return { file, source };
    }
  }
  for (const [file, source] of fileSources) {
    if (file.endsWith(".html")) {
      return { file, source };
    }
  }
  return null;
}

async function runRequestIntentVerification(input: {
  workspacePath: string;
  userRequest: string;
}): Promise<{ failed: boolean; output: string; checks: VerificationCheck[] } | null> {
  const files = await collectIntentSourceFiles(input.workspacePath);
  if (files.length === 0) {
    return null;
  }

  const { text, fileSources } = await readIntentSourceText(input.workspacePath, files);
  const coverage = validateRequestIntentCoverage(input.userRequest, text, { mode: "source" });
  if (!coverage.applicable) {
    return null;
  }

  const failures = [...coverage.messages];
  if (coverage.profile.singleFileHtml) {
    const primaryHtml = primaryHtmlSource(fileSources);
    if (primaryHtml === null) {
      failures.push("The request asked for a single-file HTML result, but no primary HTML source file was found.");
    } else if (htmlUsesExternalCssOrScript(primaryHtml.source)) {
      failures.push(`${primaryHtml.file} uses external stylesheet or script references even though the request asked for a single-file HTML result.`);
    }
  }

  const checks = [
    `Source files scanned: ${fileSources.size}/${files.length}`,
    `Matched quoted anchors: ${coverage.matchedQuotedAnchors.join(", ") || "none"}`,
    `Missing quoted anchors: ${coverage.missingQuotedAnchors.join(", ") || "none"}`,
    `Matched request terms: ${coverage.matchedTerms.join(", ") || "none"}`,
    `Missing request terms: ${coverage.missingTerms.join(", ") || "none"}`,
  ];
  return {
    failed: failures.length > 0,
    output: `Request intent verification\n${checks.join("\n")}${failures.length > 0 ? `\n\nFailures:\n${failures.map((failure) => `- ${failure}`).join("\n")}` : ""}\n`,
    checks: failures.length > 0
      ? failures.map((failure) => ({ phase: "structural", status: "failed", failureKind: "source_failure", message: failure }))
      : [{ phase: "structural", status: "passed", failureKind: "none", message: "Request intent verification passed." }],
  };
}

export async function runStructuralVerification(input: {
  workspacePath: string;
  packageJson: Record<string, unknown> | null;
  userRequest: string;
  stackDecision?: StackDecision | null;
}): Promise<{ failed: boolean; output: string; checks: VerificationCheck[] } | null> {
  const workspacePath = input.workspacePath;
  const serverPath = path.join(workspacePath, "src", "server.js");
  const publicDir = path.join(workspacePath, "public");
  const hasServer = await fileExists(serverPath);
  const serverEntrypointCandidates = [
    path.join("src", "server.ts"), path.join("src", "server.mjs"), path.join("src", "server.mts"),
    "server.js", "server.ts", "server.mjs",
    path.join("src", "app.js"), path.join("src", "app.ts"), "app.js",
    path.join("src", "index.ts"), path.join("src", "main.ts"),
  ];
  const serverEntrypointFlags = await Promise.all(
    serverEntrypointCandidates.map((candidate) => fileExists(path.join(workspacePath, candidate))),
  );
  const serverDependencies = packageDependencyNames(input.packageJson);
  const declaresServerFramework = ["express", "fastify", "koa", "@hapi/hapi", "hono", "@nestjs/core"]
    .some((dependency) => serverDependencies.has(dependency));
  const hasNodeServerSurface = hasServer || serverEntrypointFlags.some((flag) => flag) || declaresServerFramework;
  const hasPublicDir = await directoryExists(publicDir);
  const hasRootStaticHtml = await fileExists(path.join(workspacePath, "index.html"));
  const rootHtmlIsBundlerEntry = hasRootStaticHtml && workspaceUsesBundledHtmlEntry(input.packageJson);
  const expectsSingleFileHtml = isSingleFileHtmlRequest(input.userRequest);
  const decision = input.stackDecision ?? null;
  const expectsPlainStaticPage = decision !== null
    ? decision.stack === "static-html"
    : isPlainStaticWebPageRequest(input.userRequest);
  const expectsPythonWeb = decision !== null
    ? decision.stack === "python-flask" || decision.stack === "python-django"
    : classifyProductIntent(input.userRequest).pythonMode === "web";
  const hasFlaskEntrypoint = await fileExists(path.join(workspacePath, "app.py"));
  const hasDjangoEntrypoint = await fileExists(path.join(workspacePath, "manage.py"));
  const hasPythonScriptEntrypoint = await fileExists(path.join(workspacePath, "main.py"));
  const razorFiles = await collectRazorPageFiles(workspacePath);
  const hasRazorPages = razorFiles.some(isRazorPageFile);

  if (!expectsPlainStaticPage && !expectsPythonWeb && !hasRazorPages && !hasServer && !hasPublicDir && (!hasRootStaticHtml || rootHtmlIsBundlerEntry)) {
    return null;
  }

  const checks: string[] = [];
  const failures: string[] = [];

  function pass(message: string): void {
    checks.push(`PASS ${message}`);
  }

  function fail(message: string): void {
    checks.push(`FAIL ${message}`);
    failures.push(message);
  }

  function check(condition: boolean, message: string): void {
    if (condition) {
      pass(message);
    } else {
      fail(message);
    }
  }

  if (expectsPlainStaticPage) {
    const hasNextOrPagesScaffold = await directoryExists(path.join(workspacePath, "app")) || await directoryExists(path.join(workspacePath, "pages"));
    check(hasRootStaticHtml && !rootHtmlIsBundlerEntry, "Simple front-end-only page request has a root index.html product surface.");
    check(!packageUsesFrontendFramework(input.packageJson) && !hasNextOrPagesScaffold, "Simple front-end-only page request uses static HTML/CSS/JS instead of a framework scaffold.");
  }

  if (expectsPythonWeb) {
    const sourceFiles = await collectIntentSourceFiles(workspacePath);
    const templateHtmlFiles = sourceFiles.filter((file) => file.endsWith(".html") && (file.startsWith("templates/") || file.includes("/templates/")));
    const staticCssFiles = sourceFiles.filter((file) => file.endsWith(".css") && (file.startsWith("static/") || file.includes("/static/")));
    const needsFrontendAssets = /\bfull[-\s]?stack\b|\bbackend\b.*\bfrontend\b|\bfrontend\b.*\bbackend\b|\bfrontend\b|\bfront-end\b|\bbrowser ui\b|\bhtml\/css(?:\/js)?\b|\bhtml\s+css(?:\s+js)?\b|\bcss\b|\bstylesheet\b|\bstyl(?:e|ing)\b|\bjavascript\b|\bjs\b|\bclient-side\b|\bdashboard\b|\bform\b|\bbutton\b|\bcounter\b|\bclick\b|\bdisplay(?:s|ed)?\b|\bpage\b|\bwebpage\b|\binterface\b/i.test(input.userRequest);
    const appSource = await readTextIfExists(path.join(workspacePath, "app.py"));
    const mainSource = await readTextIfExists(path.join(workspacePath, "main.py"));
    const requirementsSource = await readTextIfExists(path.join(workspacePath, "requirements.txt"));
    const mainLooksLikePythonWeb = mainSource !== null && /\b(?:Flask|FastAPI|Django)\b|@\w+\.route\(|@\w+\.(?:get|post|put|delete)\(/.test(mainSource);
    const flaskSource = appSource ?? (mainLooksLikePythonWeb ? mainSource : null);
    const usesFastApi = flaskSource !== null && /\bFastAPI\s*\(|\bfrom\s+fastapi\s+import\b|\bimport\s+fastapi\b/.test(flaskSource);
    const usesFastApiTemplates = usesFastApi && /\bJinja2Templates\b|TemplateResponse\(/.test(flaskSource);

    check(hasFlaskEntrypoint || hasDjangoEntrypoint || mainLooksLikePythonWeb, "Python web request has a Flask/FastAPI/Django backend entrypoint.");
    check(!hasPythonScriptEntrypoint || hasFlaskEntrypoint || hasDjangoEntrypoint || mainLooksLikePythonWeb, "Python web request did not collapse into only a standalone main.py script.");
    if (usesFastApiTemplates) {
      check(!/TemplateResponse\(\s*["'][^"']+["']\s*,\s*\{/.test(flaskSource), "FastAPI template responses use the current request-first Jinja2Templates signature.");
      check(requirementsSource !== null && /^\s*jinja2\b/im.test(requirementsSource), "FastAPI Jinja2Templates dependency is declared in requirements.txt.");
    }
    if (needsFrontendAssets) {
      check(templateHtmlFiles.length > 0, "Python full-stack web request includes HTML template files.");
      check(staticCssFiles.length > 0, "Python full-stack web request includes CSS assets.");
      if (flaskSource !== null && /\bFlask\b/.test(flaskSource)) {
        check(/render_template\(/.test(flaskSource) || /send_from_directory\(/.test(flaskSource), "Flask backend renders or serves frontend assets instead of only inline HTML.");
      }
    }
  }

  if (hasRazorPages) {
    const program = await readTextIfExists(path.join(workspacePath, "Program.cs"));
    const viewImports = await readTextIfExists(path.join(workspacePath, "Pages", "_ViewImports.cshtml"))
      ?? await readTextIfExists(path.join(workspacePath, "_ViewImports.cshtml"));
    const viewImportText = viewImports ?? "";
    const pageSources = await Promise.all(razorFiles.filter(isRazorPageFile).map(async (file) => ({
      file,
      source: await readTextIfExists(path.join(workspacePath, file)),
    })));
    const readablePageSources = pageSources.filter((entry): entry is { file: string; source: string } => entry.source !== null);
    const usesTagHelpers = readablePageSources.some((entry) => razorUsesMvcTagHelpers(entry.source));
    const usesUnqualifiedModels = readablePageSources.some((entry) => razorUsesUnqualifiedModel(entry.source));

    check(program !== null && /\bAddRazorPages\s*\(/.test(program), "ASP.NET Razor Pages app registers Razor Pages services.");
    check(program !== null && /\bMapRazorPages\s*\(/.test(program), "ASP.NET Razor Pages app maps Razor Pages routes.");
    if (usesTagHelpers) {
      check(viewImports !== null && /@addTagHelper\s+\*,\s*Microsoft\.AspNetCore\.Mvc\.TagHelpers\b/.test(viewImportText), "Razor Pages using asp-* or ~/ asset helpers include _ViewImports.cshtml with MVC tag helpers.");
    }
    if (usesUnqualifiedModels) {
      check(viewImports !== null && /@(namespace|using)\s+[A-Za-z_][\w.]*\b/.test(viewImportText), "Razor Pages using unqualified @model types include _ViewImports.cshtml namespace or using directives.");
    }
  }

  if (hasServer && hasPublicDir) {
    const server = await readTextIfExists(serverPath);
    const pages = await listPublicHtmlPages(workspacePath);
    const routeSet = new Set(pages.map((page) => page.route));
    const hasSharedCss = await fileExists(path.join(workspacePath, "public", "styles.css"));
    const hasSharedScript = await fileExists(path.join(workspacePath, "public", "script.js"));
    const expectsNavigation = pages.length > 1;
    if (server === null) {
      fail("src/server.js is readable for Express structural checks.");
    } else {
      check(/express\.static\(/.test(server), "Express static middleware is registered.");
      check(/app\.get\(\s*["']\/["']/.test(server), "Express defines a / route.");
      for (const route of routeSet) {
        if (route === "/") {
          continue;
        }
        const escapedRoute = route.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        check(new RegExp(`app\\.get\\(\\s*["']${escapedRoute}["']`).test(server), `Express defines a ${route} route.`);
      }
      if (server.includes("sendFile(") && workspacePath.split(path.sep).some((part) => part.startsWith("."))) {
        check(/dotfiles\s*:\s*["']allow["']/.test(server), "Express sendFile routes allow generated pages under hidden workspace directories.");
      }
    }

    for (const page of pages) {
      const html = await readTextIfExists(path.join(workspacePath, page.file));
      if (html === null) {
        fail(`${page.file} exists for the ${page.name} page.`);
        continue;
      }
      pass(`${page.file} exists for the ${page.name} page.`);
      const referencesSharedCss = includesRootAssetReference(html, "href", "/styles.css");
      const referencesSharedScript = includesRootAssetReference(html, "src", "/script.js");
      if (expectsSingleFileHtml) {
        check(!referencesSharedCss, `${page.file} does not reference /styles.css because the request asks for a single-file HTML result.`);
        check(!referencesSharedScript, `${page.file} does not reference /script.js because the request asks for a single-file HTML result.`);
      } else if (hasSharedCss) {
        check(referencesSharedCss, `${page.file} references /styles.css.`);
      }
      if (!expectsSingleFileHtml && hasSharedScript) {
        check(referencesSharedScript, `${page.file} references /script.js.`);
      }
      if (expectsNavigation) {
        for (const route of routeSet) {
          check(includesRouteLink(html, route), `${page.file} links to ${route}.`);
        }
      }
    }

    const css = await readTextIfExists(path.join(workspacePath, "public", "styles.css"));
    if (css === null) {
      if (hasSharedCss) {
        fail("public/styles.css exists.");
      }
    } else {
      pass("public/styles.css exists.");
      if (expectsSingleFileHtml) {
        pass("public/styles.css is ignored for single-file HTML verification unless the root page references it.");
      } else if (expectsNavigation) {
        check(/(?:\.[\w-]*active[\w-]*|\[aria-current(?:=["']page["'])?\])/.test(css), "CSS defines an active navigation state.");
        check(/@media\b/.test(css), "CSS includes responsive behavior.");
      } else {
        check(/@media\b/.test(css), "CSS includes responsive behavior.");
      }
    }

    const script = await readTextIfExists(path.join(workspacePath, "public", "script.js"));
    if (script === null) {
      if (hasSharedScript) {
        fail("public/script.js exists.");
      }
    } else {
      pass("public/script.js exists.");
      if (expectsSingleFileHtml) {
        pass("public/script.js is ignored for single-file HTML verification unless the root page references it.");
      } else if (expectsNavigation) {
        check(/window\.location\.pathname/.test(script), "Script reads window.location.pathname.");
        check(/aria-current/.test(script), "Script manages aria-current.");
        check(/classList/.test(script), "Script manages the active class.");
      }
    }
  }

  if ((decision === null || decision.stack === "static-html") && !hasNodeServerSurface && hasRootStaticHtml && !rootHtmlIsBundlerEntry) {
      const html = await readTextIfExists(path.join(workspacePath, "index.html"));
      const css = await readTextIfExists(path.join(workspacePath, "styles.css"));
      if (html === null) {
        fail("index.html exists for the static app.");
      } else {
        pass("index.html exists for the static app.");
        const referencesStyles = includesRootAssetReference(html, "href", "/styles.css");
        if (expectsSingleFileHtml) {
          check(!referencesStyles, "index.html does not reference styles.css because the request asks for a single-file HTML result.");
        } else {
        check(referencesStyles, "index.html references styles.css.");
      }
    }
    if (!expectsSingleFileHtml) {
      check(css !== null, "styles.css exists for the static app.");
    } else if (css !== null) {
      pass("styles.css is ignored for single-file HTML verification unless index.html references it.");
    }
  }

  if (checks.length === 0) {
    return null;
  }

  return {
    failed: failures.length > 0,
    output: `Structural verification\n${checks.join("\n")}${failures.length > 0 ? `\n\nFailures:\n${failures.map((failure) => `- ${failure}`).join("\n")}` : ""}\n`,
    checks: failures.length > 0
      ? failures.map((failure) => ({ phase: "structural", status: "failed", failureKind: "source_failure", message: failure }))
      : [{ phase: "structural", status: "passed", failureKind: "none", message: "Structural verification passed." }],
  };
}

function detectPackageManagerFromPackageJson(packageJson: Record<string, unknown>): "npm" | "pnpm" | "yarn" | "bun" | null {
  const packageManager = packageJson.packageManager;
  if (typeof packageManager !== "string") {
    return null;
  }
  if (packageManager.startsWith("pnpm@")) {
    return "pnpm";
  }
  if (packageManager.startsWith("yarn@")) {
    return "yarn";
  }
  if (packageManager.startsWith("bun@")) {
    return "bun";
  }
  if (packageManager.startsWith("npm@")) {
    return "npm";
  }
  return null;
}

async function detectPackageManager(workspacePath: string, packageJson: Record<string, unknown>): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
  const declared = detectPackageManagerFromPackageJson(packageJson);
  if (declared !== null) {
    return declared;
  }
  if (await fileExists(path.join(workspacePath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await fileExists(path.join(workspacePath, "yarn.lock"))) {
    return "yarn";
  }
  if (await fileExists(path.join(workspacePath, "bun.lockb")) || await fileExists(path.join(workspacePath, "bun.lock"))) {
    return "bun";
  }
  return "npm";
}

async function packageManagerCommand(packageManager: PackageManagerName): Promise<string> {
  return (await resolvePackageManagerCommand(packageManager)).command;
}

function installArgs(packageManager: "npm" | "pnpm" | "yarn" | "bun"): string[] {
  if (packageManager === "npm") {
    return ["install", "--no-audit", "--no-fund"];
  }
  if (packageManager === "pnpm") {
    return ["install", "--no-frozen-lockfile"];
  }
  return ["install"];
}

function formatProcessOutput(command: string, result: ProcessResult): string {
  return `$ ${command}\nexit=${result.exitCode === null ? "null" : String(result.exitCode)} timedOut=${result.timedOut ? "true" : "false"}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n`;
}

function processOutputForClassification(command: string, result: ProcessResult): string {
  return `${command}\n${result.stdout}\n${result.stderr}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandExecutableName(command: string): string | null {
  const tokens = tokenizeCommand(command.trim());
  if (tokens === null || tokens.length === 0) {
    return null;
  }
  const executable = tokens[0] ?? "";
  return path.basename(executable).replace(/\.(?:cmd|bat|exe)$/i, "");
}

function outputLooksLikeMissingCommandExecutable(command: string, output: string): boolean {
  const executable = commandExecutableName(command);
  if (executable === null || executable.length === 0) {
    return false;
  }
  const escaped = escapeRegExp(executable);
  return (
    new RegExp(`'${escaped}(?:\\.(?:cmd|bat|exe))?' is not recognized as an internal or external command`, "i").test(output) ||
    new RegExp(`\\b${escaped}(?:\\.(?:cmd|bat|exe))?:\\s*(?:command )?not found\\b`, "i").test(output) ||
    new RegExp(`\\bnot found:\\s*${escaped}(?:\\.(?:cmd|bat|exe))?\\b`, "i").test(output) ||
    new RegExp(`spawn\\s+${escaped}(?:\\.(?:cmd|bat|exe))?\\s+ENOENT`, "i").test(output)
  );
}

function outputLooksLikeCommandDispatchFailure(output: string): boolean {
  return (
    /is not recognized as an internal or external command/i.test(output) ||
    /\b(?:command not found|not found:|not found)\b/i.test(output) ||
    /\bENOENT\b/i.test(output) ||
    /spawn .+ ENOENT/i.test(output) ||
    /The system cannot find the (?:file|path) specified/i.test(output)
  );
}

function outputLooksLikeTransientInstallFailure(output: string): boolean {
  return (
    /\b(?:ENOTEMPTY|EBUSY|EPERM|EACCES|ETXTBSY)\b/i.test(output) ||
    /resource busy/i.test(output) ||
    /operation not permitted/i.test(output) ||
    /permission denied/i.test(output) ||
    /directory not empty/i.test(output) ||
    /Failed to write executable/i.test(output) ||
    /\.deleteme\b/i.test(output) ||
    /\bWinError\s+(?:2|5|32)\b/i.test(output)
  );
}

function outputLooksLikeInstallEnvironmentFailure(output: string): boolean {
  return (
    /\b(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ERR_SOCKET_TIMEOUT)\b/i.test(output) ||
    /\b(?:SELF_SIGNED_CERT_IN_CHAIN|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE)\b/i.test(output) ||
    /network timeout/i.test(output) ||
    /fetch failed/i.test(output) ||
    /proxy/i.test(output) ||
    /\b(?:401|403)\b.*(?:Unauthorized|Forbidden|authentication|required)/i.test(output)
  );
}

function outputLooksLikeDependencyResolutionFailure(output: string): boolean {
  return (
    /\b(?:ERESOLVE|ETARGET|E404|ENOVERSIONS|EUNSUPPORTEDPROTOCOL)\b/i.test(output) ||
    /No matching version found/i.test(output) ||
    /could not resolve dependency/i.test(output) ||
    /unable to resolve dependency tree/i.test(output) ||
    /Couldn't find package/i.test(output)
  );
}

function classifyInstallFailure(input: {
  output: string;
  timedOut: boolean;
}): VerificationFailureKind {
  if (input.timedOut || outputLooksLikeTransientInstallFailure(input.output) || outputLooksLikeInstallEnvironmentFailure(input.output)) {
    return "environment_failure";
  }
  if (outputLooksLikeDependencyResolutionFailure(input.output)) {
    return "dependency_failure";
  }
  if (outputLooksLikeCommandDispatchFailure(input.output)) {
    return "environment_failure";
  }
  return "dependency_failure";
}

function shouldRetryInstall(input: { output: string; timedOut: boolean }): boolean {
  return !input.timedOut && (outputLooksLikeTransientInstallFailure(input.output) || outputLooksLikeInstallEnvironmentFailure(input.output));
}

async function waitForInstallRetry(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

function commandScriptExists(command: string, packageJson: Record<string, unknown> | null): boolean {
  if (packageJson === null) {
    return false;
  }
  const scripts = packageJson.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return false;
  }
  const match = command.trim().match(/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/i);
  if (match === null) {
    return false;
  }
  return typeof (scripts as Record<string, unknown>)[match[1]] === "string";
}

async function healNonexistentDeclaredVersions(input: {
  workspacePath: string;
  installOutput: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const offenders = new Map<string, string>();
  for (const match of input.installOutput.matchAll(/No matching version found for\s+((?:@[\w.-]+\/)?[a-z0-9._-]+)@([^\s'",]+)/gi)) {
    offenders.set(match[1], match[2].replace(/\.+$/, ""));
  }
  if (offenders.size === 0) {
    return [];
  }
  const packageJsonPath = path.join(input.workspacePath, "package.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const changed: string[] = [];
  for (const [packageName, badVersion] of offenders) {
    throwIfAborted(input.signal);
    const viewResult = await runProcess({
      command: await packageManagerCommand("npm"),
      args: ["view", packageName, "version", "--json"],
      cwd: input.workspacePath,
      timeoutMs: Math.min(input.timeoutMs, 60000),
      env: createVerificationEnv(),
      signal: input.signal,
    });
    if (viewResult.exitCode !== 0 || viewResult.timedOut) {
      continue;
    }
    let latest = "";
    try {
      const parsed = JSON.parse(viewResult.stdout) as unknown;
      latest = typeof parsed === "string" ? parsed : Array.isArray(parsed) ? String(parsed[parsed.length - 1] ?? "") : "";
    } catch {
      latest = "";
    }
    if (latest.trim().length === 0) {
      continue;
    }
    for (const group of ["dependencies", "devDependencies"]) {
      const section = manifest[group];
      if (typeof section === "object" && section !== null && !Array.isArray(section) && typeof (section as Record<string, unknown>)[packageName] === "string") {
        (section as Record<string, unknown>)[packageName] = `^${latest.trim()}`;
        changed.push(`${packageName}@${badVersion} -> ^${latest.trim()}`);
      }
    }
  }
  if (changed.length === 0) {
    return [];
  }
  await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return Array.from(new Set(changed));
}

async function healPeerDependencyConflicts(input: {
  workspacePath: string;
  installOutput: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  if (!/\bERESOLVE\b/i.test(input.installOutput)) {
    return [];
  }
  const rootDeclared = new Map<string, string>();
  for (const match of input.installOutput.matchAll(/((?:@[\w.-]+\/)?[a-z0-9._-]+)@"([^"]+)"\s+from\s+the\s+root\s+project/gi)) {
    rootDeclared.set(match[1], match[2]);
  }
  const peerRequirements = new Map<string, string>();
  for (const match of input.installOutput.matchAll(/peer\s+((?:@[\w.-]+\/)?[a-z0-9._-]+)@"([^"]+)"\s+from\s+(?:@[\w.-]+\/)?[a-z0-9._-]+@/gi)) {
    if (rootDeclared.has(match[1]) && !peerRequirements.has(match[1])) {
      peerRequirements.set(match[1], match[2]);
    }
  }
  if (peerRequirements.size === 0) {
    return [];
  }
  const packageJsonPath = path.join(input.workspacePath, "package.json");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const changed: string[] = [];
  for (const [packageName, peerRange] of peerRequirements) {
    throwIfAborted(input.signal);
    const resolved = await npmMaxSatisfyingVersion(input.workspacePath, packageName, peerRange, Math.min(input.timeoutMs, 60000));
    if (resolved === null) {
      continue;
    }
    for (const group of ["dependencies", "devDependencies"]) {
      const section = manifest[group];
      if (typeof section === "object" && section !== null && !Array.isArray(section)) {
        const declared = (section as Record<string, unknown>)[packageName];
        if (typeof declared === "string" && declared !== resolved) {
          (section as Record<string, unknown>)[packageName] = resolved;
          changed.push(`${packageName}@${declared} -> ${resolved} (peer range ${peerRange})`);
        }
      }
    }
  }
  if (changed.length === 0) {
    return [];
  }
  await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return Array.from(new Set(changed));
}

async function installDependenciesIfNeeded(input: {
  workspacePath: string;
  packageJson: Record<string, unknown>;
  timeoutMs: number;
  commands: string[];
  signal?: AbortSignal;
  progress?: VerificationProgressContext;
}): Promise<{ failed: boolean; output: string; check: VerificationCheck } | null> {
  throwIfAborted(input.signal);
  if (!input.commands.some(commandRequiresPackageScripts)) {
    return null;
  }
  if (await packageDependenciesAreInstalled(input.workspacePath, input.packageJson)) {
    return null;
  }

  const packageManager = await detectPackageManager(input.workspacePath, input.packageJson);
  const args = installArgs(packageManager);
  const command = await packageManagerCommand(packageManager);
  const renderedCommand = `${packageManager} ${args.join(" ")}`;
  await emitVerificationCommandEvent({
    progress: input.progress,
    eventName: "verification.command.started",
    command: renderedCommand,
    message: `Installing Node dependencies with ${renderedCommand}.`,
  });
  const outputEmitter = input.progress === undefined
    ? null
    : createVerificationOutputEmitter({ progress: input.progress, command: renderedCommand });
  const outputs: string[] = [];
  let result = await runProcess({
    command,
    args,
    cwd: input.workspacePath,
    timeoutMs: Math.max(input.timeoutMs, 180000),
    env: createVerificationEnv(),
    signal: input.signal,
    progress: outputEmitter === null ? undefined : {
      onStdout: outputEmitter.stdout,
      onStderr: outputEmitter.stderr,
    },
  });
  outputs.push(formatProcessOutput(renderedCommand, result));
  if (result.aborted) {
    throwIfAborted(input.signal);
  }
  const firstAttemptOutput = processOutputForClassification(renderedCommand, result);
  if ((result.exitCode !== 0 || result.timedOut) && shouldRetryInstall({ output: firstAttemptOutput, timedOut: result.timedOut })) {
    await outputEmitter?.flush();
    await emitVerificationCommandEvent({
      progress: input.progress,
      eventName: "verification.command.started",
      command: renderedCommand,
      message: `${renderedCommand} hit a transient install error; retrying once.`,
    });
    await waitForInstallRetry();
    result = await runProcess({
      command,
      args,
      cwd: input.workspacePath,
      timeoutMs: Math.max(input.timeoutMs, 180000),
      env: createVerificationEnv(),
      signal: input.signal,
      progress: outputEmitter === null ? undefined : {
        onStdout: outputEmitter.stdout,
        onStderr: outputEmitter.stderr,
      },
    });
    outputs.push(formatProcessOutput(`${renderedCommand} (retry)`, result));
    if (result.aborted) {
      throwIfAborted(input.signal);
    }
  }
  await outputEmitter?.flush();
  const healedPackages = new Set<string>();
  for (let healRound = 0; (result.exitCode !== 0 || result.timedOut) && healRound < 4; healRound += 1) {
    const installOutput = processOutputForClassification(renderedCommand, result);
    const versionHealChanges = await healNonexistentDeclaredVersions({
      workspacePath: input.workspacePath,
      installOutput,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const peerHealChanges = versionHealChanges.length > 0 ? [] : await healPeerDependencyConflicts({
      workspacePath: input.workspacePath,
      installOutput,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
    });
    const healChanges = versionHealChanges.length > 0 ? versionHealChanges : peerHealChanges;
    if (healChanges.length === 0) {
      break;
    }
    const healedNames = healChanges.map((entry) => entry.slice(0, entry.lastIndexOf("@", entry.indexOf(" ") === -1 ? entry.length : entry.indexOf(" "))));
    if (healedNames.every((name) => healedPackages.has(name))) {
      break;
    }
    for (const name of healedNames) {
      healedPackages.add(name);
    }
    const healDescription = versionHealChanges.length > 0
      ? "Declared package versions did not exist on the registry"
      : "Declared package versions conflicted with a dependency's peer range";
    await emitVerificationCommandEvent({
      progress: input.progress,
      eventName: "verification.command.started",
      command: renderedCommand,
      message: `${healDescription}; rewrote ${healChanges.join(", ")} and retrying the install.`,
    });
    outputs.push(`Self-healed declared dependency versions (${versionHealChanges.length > 0 ? "nonexistent version" : "peer conflict"}):\n${healChanges.map((entry) => `- ${entry}`).join("\n")}`);
    result = await runProcess({
      command,
      args,
      cwd: input.workspacePath,
      timeoutMs: Math.max(input.timeoutMs, 180000),
      env: createVerificationEnv(),
      signal: input.signal,
      progress: outputEmitter === null ? undefined : {
        onStdout: outputEmitter.stdout,
        onStderr: outputEmitter.stderr,
      },
    });
    outputs.push(formatProcessOutput(`${renderedCommand} (after version self-heal)`, result));
    if (result.aborted) {
      throwIfAborted(input.signal);
    }
    await outputEmitter?.flush();
  }
  const failed = result.exitCode !== 0 || result.timedOut;
  const failureKind = failed
    ? classifyInstallFailure({ output: processOutputForClassification(renderedCommand, result), timedOut: result.timedOut })
    : "none";
  const message = `${renderedCommand} ${failed ? "failed" : "passed"}.`;
  await emitVerificationCommandEvent({
    progress: input.progress,
    eventName: failed ? "verification.command.failed" : "verification.command.passed",
    command: renderedCommand,
    message,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });

  return {
    failed,
    output: outputs.join("\n---\n"),
    check: {
      phase: "install",
      status: failed ? "failed" : "passed",
      failureKind,
      message,
    },
  };
}

async function installPythonDependenciesIfNeeded(input: {
  workspacePath: string;
  timeoutMs: number;
  commands: string[];
  signal?: AbortSignal;
  progress?: VerificationProgressContext;
}): Promise<{ failed: boolean; output: string; check: VerificationCheck } | null> {
  throwIfAborted(input.signal);
  if (!input.commands.some(commandRequiresPython) || !(await fileExists(path.join(input.workspacePath, "requirements.txt")))) {
    return null;
  }

  const renderedCommand = "python -m pip install -r requirements.txt";
  await emitVerificationCommandEvent({
    progress: input.progress,
    eventName: "verification.command.started",
    command: renderedCommand,
    message: "Installing Python requirements.",
  });
  const outputEmitter = input.progress === undefined
    ? null
    : createVerificationOutputEmitter({ progress: input.progress, command: renderedCommand });
  const baseArgs = ["-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "-r", "requirements.txt"];
  const outputs: string[] = [];
  const python = await ensurePythonWorkspaceEnvironment({
    workspacePath: input.workspacePath,
    timeoutMs: Math.max(input.timeoutMs, 180000),
    env: createVerificationEnv(),
    signal: input.signal,
  });
  if (python.setupResult?.aborted) {
    throwIfAborted(input.signal);
  }
  if (python.setupResult !== null) {
    outputs.push(formatProcessOutput(python.setupCommand ?? "python -m venv .venv", python.setupResult));
  }
  if (python.setupResult !== null && (python.setupResult.exitCode !== 0 || python.setupResult.timedOut)) {
    await outputEmitter?.flush();
    const failureKind = classifyInstallFailure({
      output: processOutputForClassification(python.setupCommand ?? "python -m venv .venv", python.setupResult),
      timedOut: python.setupResult.timedOut,
    });
    await emitVerificationCommandEvent({
      progress: input.progress,
      eventName: "verification.command.failed",
      command: python.setupCommand ?? "python -m venv .venv",
      message: "python -m venv .venv failed.",
      exitCode: python.setupResult.exitCode,
      timedOut: python.setupResult.timedOut,
    });
    return {
      failed: true,
      output: outputs.join("\n---\n"),
      check: {
        phase: "install",
        status: "failed",
        failureKind,
        message: "python -m venv .venv failed.",
      },
    };
  }
  const config = getConfig();
  const requirements = await readFile(path.join(input.workspacePath, "requirements.txt"), "utf8").catch(() => "");
  const analysis = analyzeRequirements(requirements);
  const mlWorkspace = config.mlPipelineEnabled && analysis.torchRequested && (await readExperimentManifest(input.workspacePath)) !== null;
  const installTimeoutMs = mlWorkspace ? Math.max(input.timeoutMs, config.mlJobTimeoutMs, 600000) : Math.max(input.timeoutMs, 180000);
  const installEnv = mlWorkspace
    ? pythonWorkspaceEnv(input.workspacePath, { CI: "true", ...mlCacheEnv() })
    : pythonWorkspaceEnv(input.workspacePath, { CI: "true" });
  let extraIndexArgs: string[] = [];
  let torchCpuFallback = false;
  if (mlWorkspace) {
    try {
      const cuda = await ensureCudaTorch({
        workspacePath: input.workspacePath,
        pythonCommand: python.command,
        analysis,
        env: installEnv,
        timeoutMs: installTimeoutMs,
        signal: input.signal,
        progress: outputEmitter === null ? undefined : { onStdout: outputEmitter.stdout, onStderr: outputEmitter.stderr },
      });
      extraIndexArgs = cuda.extraIndexArgs;
      torchCpuFallback = cuda.cpuFallback;
      if (cuda.command !== null) {
        outputs.push(`$ ${cuda.command}\n${cuda.stdout}\n${cuda.stderr}`);
      }
    } catch (error) {
      await outputEmitter?.flush();
      const message = error instanceof Error ? error.message : "CUDA torch install failed.";
      await emitVerificationCommandEvent({
        progress: input.progress,
        eventName: "verification.command.failed",
        command: "pip install (CUDA torch)",
        message,
      });
      return {
        failed: true,
        output: outputs.join("\n---\n"),
        check: { phase: "install", status: "failed", failureKind: "dependency_failure", message },
      };
    }
  }
  const args = mlWorkspace
    ? ["-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--no-cache-dir", "-r", "requirements.txt", ...extraIndexArgs]
    : [...baseArgs, ...extraIndexArgs];

  let result = await runProcess({
    command: python.command,
    args,
    cwd: input.workspacePath,
    timeoutMs: installTimeoutMs,
    env: installEnv,
    signal: input.signal,
    progress: outputEmitter === null ? undefined : {
      onStdout: outputEmitter.stdout,
      onStderr: outputEmitter.stderr,
    },
  });
  outputs.push(formatProcessOutput(renderedCommand, result));
  if (result.aborted) {
    throwIfAborted(input.signal);
  }
  const firstAttemptOutput = processOutputForClassification(renderedCommand, result);
  if ((result.exitCode !== 0 || result.timedOut) && shouldRetryInstall({ output: firstAttemptOutput, timedOut: result.timedOut })) {
    await outputEmitter?.flush();
    await emitVerificationCommandEvent({
      progress: input.progress,
      eventName: "verification.command.started",
      command: renderedCommand,
      message: `${renderedCommand} hit a transient install error; retrying once.`,
    });
    await waitForInstallRetry();
    result = await runProcess({
      command: python.command,
      args,
      cwd: input.workspacePath,
      timeoutMs: installTimeoutMs,
      env: installEnv,
      signal: input.signal,
      progress: outputEmitter === null ? undefined : {
        onStdout: outputEmitter.stdout,
        onStderr: outputEmitter.stderr,
      },
    });
    outputs.push(formatProcessOutput(`${renderedCommand} (retry)`, result));
    if (result.aborted) {
      throwIfAborted(input.signal);
    }
  }
  await outputEmitter?.flush();
  const failed = result.exitCode !== 0 || result.timedOut;
  const failureKind = failed
    ? classifyInstallFailure({ output: processOutputForClassification(renderedCommand, result), timedOut: result.timedOut })
    : "none";
  if (!failed && mlWorkspace) {
    try {
      await verifyVenvTorchInstall({
        workspacePath: input.workspacePath,
        analysis,
        signal: input.signal,
        repair: {
          pythonCommand: python.command,
          env: installEnv,
          timeoutMs: installTimeoutMs,
          progress: outputEmitter === null ? undefined : { onStdout: outputEmitter.stdout, onStderr: outputEmitter.stderr },
        },
        cpuFallback: torchCpuFallback,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "venv CUDA verification failed.";
      outputs.push(`$ verify venv torch\n${message}`);
      await emitVerificationCommandEvent({
        progress: input.progress,
        eventName: "verification.command.failed",
        command: "verify venv torch",
        message,
      });
      return {
        failed: true,
        output: outputs.join("\n---\n"),
        check: { phase: "install", status: "failed", failureKind: "environment_failure", message },
      };
    }
  }
  await emitVerificationCommandEvent({
    progress: input.progress,
    eventName: failed ? "verification.command.failed" : "verification.command.passed",
    command: renderedCommand,
    message: `${renderedCommand} ${failed ? "failed" : "passed"}.`,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  });

  return {
    failed,
    output: outputs.join("\n---\n"),
    check: {
      phase: "install",
      status: failed ? "failed" : "passed",
      failureKind,
      message: `python -m pip install -r requirements.txt ${failed ? "failed" : "passed"}.`,
    },
  };
}

function dominantFailureKind(checks: VerificationCheck[]): VerificationFailureKind {
  const failedKinds = checks.filter((check) => check.status === "failed").map((check) => check.failureKind);
  if (failedKinds.includes("functional_failure")) return "functional_failure";
  if (failedKinds.includes("visual_failure")) return "visual_failure";
  if (failedKinds.includes("source_failure")) return "source_failure";
  if (failedKinds.includes("environment_failure")) return "environment_failure";
  if (failedKinds.includes("dependency_failure")) return "dependency_failure";
  if (failedKinds.includes("verification_contract_failure")) return "verification_contract_failure";
  return "none";
}

function classifyCommandFailure(input: {
  command: string;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): VerificationFailureKind {
  if (input.timedOut) {
    return "environment_failure";
  }
  const output = `${input.command}\n${input.stdout}\n${input.stderr}`;
  if (
    /Missing script:/i.test(output) ||
    /all of the files matching the glob pattern .* are ignored/i.test(output) ||
    /No files matching the pattern/i.test(output) ||
    /couldn't find .*config/i.test(output) ||
    /No ESLint configuration found/i.test(output) ||
    /Invalid project directory provided, no such directory: .*[/\\]lint\b/i.test(output) ||
    /Error while loading rule .+Cannot read properties of undefined/i.test(output) ||
    /Error while loading rule .+getFilename is not a function/i.test(output) ||
    /Oops! Something went wrong!.*ESLint:/is.test(output)
  ) {
    return "verification_contract_failure";
  }
  if (outputLooksLikeCommandDispatchFailure(output)) {
    if (outputLooksLikeMissingCommandExecutable(input.command, output)) {
      return "environment_failure";
    }
    return "dependency_failure";
  }
  return "source_failure";
}

export async function executeVerification(workSession: WorkSessionRecord, progress?: VerificationProgressContext, signal?: AbortSignal): Promise<VerificationExecutionResult> {
  await assertSafeWorkspace(workSession.activeWorktreePath, { operation: "verification" });
  return traced({
    name: "verification.execute",
    attributes: {
      workSessionId: workSession.id,
      projectId: workSession.projectId,
      workspacePath: workSession.activeWorktreePath,
    },
    run: () => executeVerificationInternal(workSession, progress, signal),
  });
}

async function executeVerificationInternal(workSession: WorkSessionRecord, progress?: VerificationProgressContext, signal?: AbortSignal): Promise<VerificationExecutionResult> {
  throwIfAborted(signal);
  const config = getConfig();
  const allowBuildVerification = userExplicitlyRequestedBuildVerification(workSession.lastUserMessage);
  const configuredCommands = filterBuildVerificationCommands(
    await verificationCommandsForWorkspace(workSession.activeWorktreePath, config.verifyCommands),
    { allowBuild: allowBuildVerification },
  );
  const workspaceExists = await directoryExists(workSession.activeWorktreePath);
  const checks: VerificationCheck[] = [];

  if (!workspaceExists) {
    return {
      status: "failed",
      failureKind: "environment_failure",
      summary: `Workspace does not exist: ${workSession.activeWorktreePath}`,
      rawOutput: `Cannot run verification because the workspace path does not exist: ${workSession.activeWorktreePath}`,
      commands: configuredCommands,
      commandResults: [],
      checks: [{
        phase: "workspace",
        status: "failed",
        failureKind: "environment_failure",
        message: `Workspace does not exist: ${workSession.activeWorktreePath}`,
      }],
    };
  }

  const hasPackageJson = await fileExists(path.join(workSession.activeWorktreePath, "package.json"));
  const packageJson = hasPackageJson ? await readPackageJson(workSession.activeWorktreePath) : null;
  const commands = filterRunnableCommands({ packageJson, configuredCommands, checks });
  const declaredScripts = packageJson !== null && typeof packageJson.scripts === "object" && packageJson.scripts !== null
    ? Object.keys(packageJson.scripts as Record<string, unknown>)
    : [];
  const standardScripts = allowBuildVerification ? ["typecheck", "lint", "test", "build"] : ["typecheck", "lint", "test"];
  const uncoveredStandardScripts = standardScripts.filter((script) =>
    declaredScripts.includes(script) && !commands.some((command) => new RegExp(`\\b${script}\\b`).test(command.toLowerCase())),
  );
  const gateAdvisory = uncoveredStandardScripts.length > 0
    ? `Gate advisory: package.json declares ${uncoveredStandardScripts.map((script) => `"${script}"`).join(", ")} script${uncoveredStandardScripts.length === 1 ? "" : "s"} that this verification gate does not run. Extend VERIFY_COMMANDS to cover ${uncoveredStandardScripts.length === 1 ? "it" : "them"}.`
    : "";
  if (progress !== undefined) {
    await emitEvent({
      workSessionId: progress.workSessionId,
      eventName: "verification.commands.resolved",
      aggregateType: "verification_run",
      aggregateId: progress.verificationRunId ?? null,
      payload: {
        message: commands.length > 0
          ? `Verification gate resolved: ${commands.join("; ")}.${gateAdvisory.length > 0 ? ` ${gateAdvisory}` : ""}`
          : "Verification gate resolved no runnable commands.",
        configuredCommands: configuredCommands.join(";"),
        resolvedCommands: commands.join(";"),
        uncoveredScripts: uncoveredStandardScripts.join(","),
      },
      producer: { module: "verification-engine", runtimeKind: "codex", role: "verifier" },
      context: { planId: progress.planId, verificationRunId: progress.verificationRunId },
    });
  }
  if (!allowBuildVerification) {
    for (const command of config.verifyCommands.filter(isBuildVerificationCommand)) {
      checks.push({
        phase: "command",
        status: "skipped",
        failureKind: "none",
        message: `Skipped ${command} because build verification only runs when the user explicitly asks for it.`,
      });
      await emitVerificationCommandEvent({
        progress,
        eventName: "verification.command.skipped",
        command,
        message: "Skipped build verification because the user did not explicitly ask for it.",
      });
    }
  }

  const preflightChecks = [
    await runPackageImportVerification(workSession.activeWorktreePath),
    await runRequestIntentVerification({
      workspacePath: workSession.activeWorktreePath,
      userRequest: workSession.lastUserMessage,
    }),
    await runStructuralVerification({
      workspacePath: workSession.activeWorktreePath,
      packageJson,
      userRequest: workSession.lastUserMessage,
      stackDecision: workSession.stackDecision ?? null,
    }),
  ].filter((check): check is { failed: boolean; output: string; checks: VerificationCheck[] } => check !== null);
  for (const preflightCheck of preflightChecks) {
    checks.push(...preflightCheck.checks);
  }

  if (commands.length === 0) {
    const rawOutput = preflightChecks.length > 0
      ? [...checks.map((check) => `${check.status.toUpperCase()} [${check.phase}] ${check.message}`), ...preflightChecks.map((check) => check.output)].join("\n---\n")
      : "No runnable verification commands were available.";
    const status = preflightChecks.some((check) => check.failed) ? "failed" : "passed";
    const failureKind = status === "failed" ? dominantFailureKind(checks) : "none";
    const summary = status === "failed"
      ? "Preflight verification failed. See raw output artifact."
      : "No runnable verification commands were available. Preflight verification passed or was not applicable.";
    await saveArtifact({
      workSessionId: workSession.id,
      kind: "verification",
      fileName: `verification-${Date.now()}.txt`,
      content: rawOutput,
      metadata: {
        status,
        commands: commands.join(";"),
        configuredCommands: configuredCommands.join(";"),
        failureKind,
        preflight: preflightChecks.length === 0 ? "not-applicable" : "checked",
      },
    });
    return {
      status,
      failureKind,
      summary,
      rawOutput,
      commands,
      commandResults: [],
      checks,
    };
  }

  const packageScriptCommands = commands.length > 0 && commands.every(commandRequiresPackageScripts);

  if (!hasPackageJson && packageScriptCommands) {
    const rawOutput = `No package.json exists in ${workSession.activeWorktreePath}. Skipped package-manager verification commands:\n${commands.map((command) => `- ${command}`).join("\n")}`;
    await saveArtifact({
      workSessionId: workSession.id,
      kind: "verification",
      fileName: `verification-${Date.now()}.txt`,
      content: rawOutput,
      metadata: {
        status: "passed",
        commands: commands.join(";"),
        skipped: "missing-package-json",
      },
    });

    return {
      status: "passed",
      failureKind: "none",
      summary: "Workspace has no package.json, so package-manager verification commands were skipped.",
      rawOutput,
      commands,
      commandResults: [],
      checks: [{
        phase: "command",
        status: "skipped",
        failureKind: "verification_contract_failure",
        message: "Workspace has no package.json, so package-manager verification commands were skipped.",
      }],
    };
  }

  const outputs: string[] = [];
  const commandResults: VerificationCommandResult[] = [];
  let failed = false;

  if (packageJson !== null) {
    const install = await installDependenciesIfNeeded({
      workspacePath: workSession.activeWorktreePath,
      packageJson,
      timeoutMs: config.shellTimeoutMs,
      commands,
      signal,
      progress,
    });
    if (install !== null) {
      outputs.push(install.output);
      checks.push(install.check);
      failed = install.failed;
    }
  }

  const commandEnv = await createVerificationCommandEnv(workSession.activeWorktreePath);

  if (!failed) {
    const pythonInstall = await installPythonDependenciesIfNeeded({
      workspacePath: workSession.activeWorktreePath,
      timeoutMs: config.shellTimeoutMs,
      commands,
      signal,
      progress,
    });
    if (pythonInstall !== null) {
      outputs.push(pythonInstall.output);
      checks.push(pythonInstall.check);
      failed = pythonInstall.failed;
    }
  }

  if (!failed) {
    const pythonImports = await runPythonImportVerification(workSession.activeWorktreePath);
    if (pythonImports !== null) {
      outputs.push(pythonImports.output);
      checks.push(...pythonImports.checks);
      if (pythonImports.failed) {
        failed = true;
      }
    }
  }

  if (!failed) {
    for (const command of commands) {
      throwIfAborted(signal);
      await emitVerificationCommandEvent({
        progress,
        eventName: "verification.command.started",
        command,
        message: `Running ${command}.`,
      });
      const outputEmitter = progress === undefined
        ? null
        : createVerificationOutputEmitter({ progress, command });
      const result = await runVerificationCommand({
        command,
        cwd: workSession.activeWorktreePath,
        timeoutMs: config.shellTimeoutMs,
        env: commandEnv,
        signal,
        progress: outputEmitter === null ? undefined : {
          onStdout: outputEmitter.stdout,
          onStderr: outputEmitter.stderr,
        },
      });
      await outputEmitter?.flush();
      if (result.aborted) {
        throwIfAborted(signal);
      }
      let failureKind = result.exitCode !== 0 || result.timedOut
        ? classifyCommandFailure({ command, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut })
        : "none";
      if (
        failureKind === "verification_contract_failure" &&
        commandScriptExists(command, packageJson) &&
        !/Missing script:/i.test(`${result.stdout}\n${result.stderr}`)
      ) {
        failureKind = "source_failure";
      }
      const checkStatus = result.exitCode !== 0 || result.timedOut
        ? failureKind === "verification_contract_failure" ? "skipped" : "failed"
        : "passed";
      await emitVerificationCommandEvent({
        progress,
        eventName: checkStatus === "failed"
          ? "verification.command.failed"
          : checkStatus === "skipped"
            ? "verification.command.skipped"
            : "verification.command.passed",
        command,
        message: checkStatus === "skipped"
          ? `${command} was skipped because it could not run as a valid verification contract.`
          : `${command} ${checkStatus === "failed" ? "failed" : "passed"}.`,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      });
      outputs.push(`$ ${command}\nexit=${result.exitCode === null ? "null" : String(result.exitCode)} timedOut=${result.timedOut ? "true" : "false"}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n`);
      commandResults.push({
        command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        status: checkStatus,
        stdoutTail: boundedVerificationOutput(result.stdout),
        stderrTail: boundedVerificationOutput(result.stderr),
      });
      checks.push({
        phase: "command",
        status: checkStatus,
        failureKind,
        message: checkStatus === "skipped"
          ? `${command} was skipped because it could not run as a valid verification contract.`
          : `${command} ${checkStatus === "failed" ? "failed" : "passed"}.`,
      });
      if (checkStatus === "failed") {
        failed = true;
        break;
      }
    }
  }

  for (const preflightCheck of preflightChecks) {
    outputs.push(preflightCheck.output);
    if (!failed && preflightCheck.failed) {
      failed = true;
    }
  }

  const checkOutput = checks.length > 0
    ? `Verification checks\n${checks.map((check) => `${check.status.toUpperCase()} [${check.phase}] ${check.failureKind}: ${check.message}`).join("\n")}`
    : "";
  const rawOutput = [checkOutput, ...outputs].filter((entry) => entry.length > 0).join("\n---\n");
  const status = failed ? "failed" : "passed";
  const failureKind = failed ? dominantFailureKind(checks) : "none";
  const skippedCommandCount = checks.filter((check) => check.phase === "command" && check.status === "skipped").length;
  const failedCommandCheck = checks.some((check) => check.status === "failed" && check.phase === "command");
  const baseSummary = failed
    ? failureKind === "source_failure"
      ? failedCommandCheck
        ? "At least one source verification command failed. See raw output artifact."
        : "A structural source check failed; all source verification commands passed. See raw output artifact."
      : `Verification failed due to ${failureKind}. See raw output artifact.`
    : skippedCommandCount > 0
      ? `All source verification checks passed; skipped ${skippedCommandCount} command${skippedCommandCount === 1 ? "" : "s"} with invalid verification contracts.`
      : "All runnable verification commands passed.";
  const summary = !failed && gateAdvisory.length > 0 ? `${baseSummary} ${gateAdvisory}` : baseSummary;

  await saveArtifact({
    workSessionId: workSession.id,
    kind: "verification",
    fileName: `verification-${Date.now()}.txt`,
    content: rawOutput,
    metadata: {
      status,
      commands: commands.join(";"),
      configuredCommands: configuredCommands.join(";"),
      failureKind,
      skippedCommandCount,
      uncoveredScripts: uncoveredStandardScripts.join(","),
    },
  });

  return {
    status,
    failureKind,
    summary,
    rawOutput,
    commands,
    commandResults,
    checks,
  };
}
