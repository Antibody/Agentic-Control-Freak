import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { createPreviewServerRecord, currentTimestamp, getDatabaseSnapshot, mutateDatabase } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { logProcess } from "@/lib/server/logging";
import { traced } from "@/lib/server/tracing";
import { stackCapabilities } from "@/lib/shared/stack-capabilities";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolveDotnetCommand } from "@/lib/server/runtime/dotnet-resolver";
import { resolvePackageManagerCommand, type PackageManagerName } from "@/lib/server/runtime/package-manager-resolver";
import { resolveComposerCommand, resolvePhpCommand } from "@/lib/server/runtime/php-resolver";
import { ensurePythonWorkspaceEnvironment, pythonVirtualEnvCommand, pythonWorkspaceEnv } from "@/lib/server/runtime/python-environment";
import { resolvePythonCommand } from "@/lib/server/runtime/python-resolver";
import { resolveRscriptCommand } from "@/lib/server/runtime/r-resolver";
import { ensureRLibraryDir, parseRDescriptionPackages, rInstallExpression, rLibraryDir, rWorkspaceEnv } from "@/lib/server/runtime/r-environment";
import { registerWorkSessionOperation } from "@/lib/server/runtime/operation-registry";
import { runProcess } from "@/lib/server/runtime/process-runner";
import { readExperimentManifest } from "@/lib/server/ml/experiment-manifest";
import { analyzeRequirements, ensureCudaTorch, verifyVenvTorchInstall } from "@/lib/server/ml/ml-installer";
import { mlCacheEnv } from "@/lib/server/ml/ml-env";
import { isWindowsBatchCommand, windowsBatchSpawnTarget, type SpawnTarget } from "@/lib/server/runtime/windows-command";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import type {
  Identifier,
  PreviewAppType,
  PreviewRestartPolicy,
  PreviewServerRecord,
  PreviewServerReloadMode,
  PreviewStoppedReason,
  PythonEntrypointOption,
  PythonRunParams,
  REntrypointOption,
  RRunParams,
  WorkSessionState,
  WorkSessionRecord,
} from "@/lib/shared/types";

const liveProcesses = new Map<Identifier, ChildProcessWithoutNullStreams>();
const previewIdleTimers = new Map<Identifier, ReturnType<typeof setTimeout>>();
const maxTailLength = 8000;
const pythonPreviewDir = path.join(".orchestrator", "python-preview");
const rPreviewDir = path.join(".orchestrator", "r-preview");
const javaClassesDir = path.join(".orchestrator", "java-classes");
const phpPreviewRouterPath = path.join(".orchestrator", "php-preview-router.php");
const phpPreviewErrorLogPath = path.join(".orchestrator", "php-preview-error.log");
const previewOutputExtensions = new Set([".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".pdf"]);
const previewTextExtensions = new Set([".txt", ".csv", ".json", ".md", ".log"]);

export interface PreviewCommand {
  appType: PreviewAppType;
  command: string;
  args: string[];
  renderedCommand: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null;
  needsDependencyInstall: boolean;
  previewable: boolean;
  serverReloadMode: PreviewServerReloadMode;
  pythonScriptPath?: string;
  rScriptPath?: string;
  javaMainClass?: string;
  javaSourceFiles?: string[];
  javaClassesDir?: string;
}

export interface StartPreviewOptions {
  mode?: "probe" | "final";
  policy?: PreviewRestartPolicy;
  signal?: AbortSignal;
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > maxTailLength ? next.slice(next.length - maxTailLength) : next;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeAssetName(input: string): string {
  return input.replace(/[^a-z0-9._-]/gi, "_").slice(0, 180);
}

function createSpawnTarget(command: string, args: string[]): SpawnTarget {
  if (process.platform === "win32" && isWindowsBatchCommand(command)) {
    return windowsBatchSpawnTarget(command, args);
  }
  return { command, args };
}

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(pathname: string): Promise<string | null> {
  try {
    return await readFile(pathname, "utf8");
  } catch {
    return null;
  }
}

async function readPackageJson(workspacePath: string): Promise<Record<string, unknown> | null> {
  const packagePath = path.join(workspacePath, "package.json");
  if (!(await fileExists(packagePath))) {
    return null;
  }

  try {
    return JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function directoryExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hasDependency(packageJson: Record<string, unknown>, dependency: string): boolean {
  const dependencies = packageJson.dependencies;
  const devDependencies = packageJson.devDependencies;
  return (
    (typeof dependencies === "object" && dependencies !== null && dependency in dependencies) ||
    (typeof devDependencies === "object" && devDependencies !== null && dependency in devDependencies)
  );
}

async function detectPackageManager(workspacePath: string): Promise<"npm" | "pnpm" | "yarn" | "bun"> {
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

function scriptNameForNodeWebPreview(scripts: Record<string, unknown>): "dev" | "start" | null {
  if (typeof scripts.dev === "string") {
    return "dev";
  }
  if (typeof scripts.start === "string") {
    return "start";
  }
  return null;
}

function scriptUsesWatcher(script: string): boolean {
  return /\b(nodemon|ts-node-dev|vite|next)\b/i.test(script)
    || /\btsx\b[^&|;\n\r]*\bwatch\b/i.test(script)
    || /\bnode\b[^&|;\n\r]*\s--watch\b/i.test(script)
    || /\b--watch\b/i.test(script);
}

async function findNodeWebEntrypoint(workspacePath: string): Promise<string | null> {
  const candidates = ["src/server.js", "server.js", "src/app.js", "app.js"];
  for (const candidate of candidates) {
    if (await fileExists(path.join(workspacePath, candidate))) {
      return candidate;
    }
  }
  return null;
}

const ignoredPythonPreviewDirectories = new Set([
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
  "venv",
  "__pycache__",
]);
const ignoredPythonPreviewScriptNames = new Set(["__init__.py", "conftest.py"]);

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
    if (ignoredPythonPreviewDirectories.has(entry.name)) {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectPythonScriptFiles(workspacePath, relative, depth + 1));
      continue;
    }
    if (entry.name.endsWith(".py") && !ignoredPythonPreviewScriptNames.has(entry.name)) {
      files.push(relative.replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

function scorePythonScriptEntrypoint(file: string, source: string): number {
  const name = path.basename(file);
  let score = 0;

  if (file === "main.py") score += 100;
  if (file === "app.py") score += 50;
  if (!file.includes("/")) score += 25;
  if (/if\s+__name__\s*==\s*["']__main__["']/.test(source)) score += 45;
  if (/\bmatplotlib\b|\bpyplot\b|\bplt\./.test(source)) score += 35;
  if (/\b(show|savefig|plot|scatter|figure)\s*\(/.test(source)) score += 10;
  if (/^(test_|.*_test\.py$)/.test(name)) score -= 60;

  return score;
}

async function findPythonScriptEntrypoint(workspacePath: string): Promise<string | null> {
  const files = await collectPythonScriptFiles(workspacePath);
  if (files.length === 0) {
    return null;
  }

  const scored = await Promise.all(files.map(async (file) => {
    const source = await readFile(path.join(workspacePath, file), "utf8").catch(() => "");
    return { file, score: scorePythonScriptEntrypoint(file, source) };
  }));
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored[0]?.file ?? null;
}

export async function listPythonEntrypoints(workspacePath: string): Promise<PythonEntrypointOption[]> {
  const files = await collectPythonScriptFiles(workspacePath);
  const scored = await Promise.all(files.map(async (file) => {
    const source = await readFile(path.join(workspacePath, file), "utf8").catch(() => "");
    return { file, score: scorePythonScriptEntrypoint(file, source) };
  }));
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored;
}

async function resolvePythonEntrypoint(
  workspacePath: string,
  runParams: PythonRunParams | null,
  detected: string | undefined
): Promise<string> {
  const requested = runParams?.entrypoint ?? null;
  if (requested !== null) {
    const normalized = requested.replace(/\\/g, "/").replace(/^\.\//, "");
    const resolved = path.resolve(workspacePath, normalized);
    const rootResolved = path.resolve(workspacePath);
    const resolvedKey = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const rootKey = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
    const insideWorkspace = resolvedKey === rootKey || resolvedKey.startsWith(rootKey + path.sep);
    if (insideWorkspace && (await fileExists(resolved))) {
      return normalized;
    }
  }
  return detected ?? "main.py";
}

async function pythonCommandForWorkspace(workspacePath: string): Promise<string> {
  if (await fileExists(path.join(workspacePath, "requirements.txt"))) {
    return pythonVirtualEnvCommand(workspacePath);
  }
  return (await resolvePythonCommand(workspacePath)).command;
}

const ignoredRPreviewDirectories = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".orchestrator",
  ".rlib",
  ".Rproj.user",
  "renv",
  "packrat",
  "build",
  "dist",
  "node_modules",
]);
const shinyEntrypointBasenames = new Set(["app.r", "ui.r", "server.r", "global.r"]);

function isRSourceFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".r") && lower !== ".r";
}

async function collectRScriptFiles(workspacePath: string, current = "", depth = 0): Promise<string[]> {
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
    if (ignoredRPreviewDirectories.has(entry.name)) {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectRScriptFiles(workspacePath, relative, depth + 1));
      continue;
    }
    if (isRSourceFileName(entry.name)) {
      files.push(relative.replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

function scoreRScriptEntrypoint(file: string, source: string): number {
  const name = path.basename(file).toLowerCase();
  let score = 0;

  if (name === "main.r") score += 100;
  if (name === "run.r" || name === "analysis.r" || name === "plot.r") score += 40;
  if (!file.includes("/")) score += 25;
  if (/\blibrary\s*\(|\brequire\s*\(/.test(source)) score += 10;
  if (/\bggplot\s*\(|\bggsave\s*\(|\bplot\s*\(|\bhist\s*\(|\bbarplot\s*\(|\bboxplot\s*\(|\bprint\s*\(/.test(source)) score += 20;
  if (/^test[-_]|[-_]test\.r$/.test(name)) score -= 60;
  if (shinyEntrypointBasenames.has(name)) score -= 120;

  return score;
}

async function findRScriptEntrypoint(workspacePath: string): Promise<string | null> {
  const files = await collectRScriptFiles(workspacePath);
  if (files.length === 0) {
    return null;
  }

  const scored = await Promise.all(files.map(async (file) => {
    const source = await readFile(path.join(workspacePath, file), "utf8").catch(() => "");
    return { file, score: scoreRScriptEntrypoint(file, source) };
  }));
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const best = scored[0];
  if (best === undefined || best.score < 0) {
    return null;
  }
  return best.file;
}

export async function listREntrypoints(workspacePath: string): Promise<REntrypointOption[]> {
  const files = await collectRScriptFiles(workspacePath);
  const scored = await Promise.all(files.map(async (file) => {
    const source = await readFile(path.join(workspacePath, file), "utf8").catch(() => "");
    return { file, score: scoreRScriptEntrypoint(file, source) };
  }));
  return scored
    .filter((entry) => !shinyEntrypointBasenames.has(path.basename(entry.file).toLowerCase()))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

async function resolveREntrypoint(
  workspacePath: string,
  runParams: RRunParams | null,
  detected: string | undefined
): Promise<string> {
  const requested = runParams?.entrypoint ?? null;
  if (requested !== null) {
    const normalized = requested.replace(/\\/g, "/").replace(/^\.\//, "");
    const resolved = path.resolve(workspacePath, normalized);
    const rootResolved = path.resolve(workspacePath);
    const resolvedKey = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    const rootKey = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
    const insideWorkspace = resolvedKey === rootKey || resolvedKey.startsWith(rootKey + path.sep);
    if (insideWorkspace && (await fileExists(resolved))) {
      return normalized;
    }
  }
  return detected ?? "main.R";
}

const shinyMarkerPattern = /\bshinyApp\s*\(|\bshinyUI\s*\(|\bshinyServer\s*\(|\bfluidPage\s*\(|\bnavbarPage\s*\(|\bbootstrapPage\s*\(|\bfillPage\s*\(|\bdashboardPage\s*\(|\blibrary\s*\(\s*["']?shiny["']?\s*\)|\brequire\s*\(\s*["']?shiny["']?\s*\)/;

async function detectShiny(workspacePath: string): Promise<boolean> {
  const appSource = await readTextIfExists(path.join(workspacePath, "app.R"))
    ?? await readTextIfExists(path.join(workspacePath, "app.r"));
  if (appSource !== null && shinyMarkerPattern.test(appSource)) {
    return true;
  }
  const uiSource = await readTextIfExists(path.join(workspacePath, "ui.R"))
    ?? await readTextIfExists(path.join(workspacePath, "ui.r"));
  const serverSource = await readTextIfExists(path.join(workspacePath, "server.R"))
    ?? await readTextIfExists(path.join(workspacePath, "server.r"));
  if (uiSource !== null && serverSource !== null) {
    return shinyMarkerPattern.test(uiSource) || shinyMarkerPattern.test(serverSource);
  }
  return false;
}

async function detectPythonWebFramework(workspacePath: string): Promise<"fastapi" | "flask" | "unknown"> {
  const source = await readTextIfExists(path.join(workspacePath, "app.py"));
  if (source === null) {
    return "unknown";
  }
  if (/\bfrom\s+fastapi\s+import\b|\bimport\s+fastapi\b|\bFastAPI\s*\(/.test(source)) {
    return "fastapi";
  }
  if (/\bfrom\s+flask\s+import\b|\bimport\s+flask\b|\bFlask\s*\(/.test(source)) {
    return "flask";
  }
  return "unknown";
}

const ignoredJavaPreviewDirectories = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".orchestrator",
  "build",
  "dist",
  "node_modules",
  "out",
  "target",
]);

interface JavaEntrypoint {
  mainClass: string;
  sourceFile: string;
  sourceFiles: string[];
}

async function collectJavaSourceFiles(workspacePath: string, current = "", depth = 0): Promise<string[]> {
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
    if (ignoredJavaPreviewDirectories.has(entry.name)) {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJavaSourceFiles(workspacePath, relative, depth + 1));
      continue;
    }
    if (entry.name.endsWith(".java")) {
      files.push(relative.replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

function javaMainClassFromSource(source: string): string | null {
  if (!/public\s+static\s+void\s+main\s*\(\s*String(?:\s*\[\]|\s+\.\.\.)\s+\w+\s*\)/.test(source)) {
    return null;
  }
  const packageName = source.match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m)?.[1] ?? "";
  const className = source.match(/\b(?:public\s+)?(?:final\s+)?class\s+([A-Za-z_$][\w$]*)\b/)?.[1] ?? null;
  if (className === null) {
    return null;
  }
  return packageName.length > 0 ? `${packageName}.${className}` : className;
}

async function findJavaEntrypoint(workspacePath: string): Promise<JavaEntrypoint | null> {
  const sourceFiles = await collectJavaSourceFiles(workspacePath);
  for (const sourceFile of sourceFiles) {
    const source = await readTextIfExists(path.join(workspacePath, sourceFile));
    if (source === null) {
      continue;
    }
    const mainClass = javaMainClassFromSource(source);
    if (mainClass !== null) {
      return { mainClass, sourceFile, sourceFiles };
    }
  }
  return null;
}

async function createJavaPreviewCommand(workspacePath: string, port: number, host: string): Promise<PreviewCommand | null> {
  const entrypoint = await findJavaEntrypoint(workspacePath);
  if (entrypoint === null) {
    return null;
  }
  const classesDir = javaClassesDir;
  const classpathEntries = [classesDir];
  if (await directoryExists(path.join(workspacePath, "src", "main", "resources"))) {
    classpathEntries.push(path.join("src", "main", "resources"));
  }
  const classpath = classpathEntries.join(path.delimiter);
  return {
    appType: "java",
    command: "java",
    args: ["-cp", classpath, entrypoint.mainClass],
    renderedCommand: `javac -d ${classesDir} ${entrypoint.sourceFiles.join(" ")} && PORT=${port} HOST=${host} java -cp ${classpath} ${entrypoint.mainClass}`,
    packageManager: null,
    needsDependencyInstall: false,
    previewable: true,
    serverReloadMode: "plain_process",
    javaMainClass: entrypoint.mainClass,
    javaSourceFiles: entrypoint.sourceFiles,
    javaClassesDir: classesDir,
  };
}

async function createPackagePreviewCommand(
  workspacePath: string,
  port: number,
  host: string,
  packageJson: Record<string, unknown>,
  scripts: Record<string, unknown>
): Promise<PreviewCommand | null> {
  const packageManager = await detectPackageManager(workspacePath);
  const command = await packageManagerCommand(packageManager);
  const nodeModulesMissing = !(await directoryExists(path.join(workspacePath, "node_modules")));

  if (hasDependency(packageJson, "next") && typeof scripts.dev === "string") {
    return {
      appType: "next",
      command,
      args: ["run", "dev", "--", "-H", host, "-p", String(port)],
      renderedCommand: `${packageManager} run dev -- -H ${host} -p ${port}`,
      packageManager,
      needsDependencyInstall: nodeModulesMissing,
      previewable: true,
      serverReloadMode: "hmr",
    };
  }

  if ((hasDependency(packageJson, "vite") || typeof scripts.dev === "string" && scripts.dev.includes("vite")) && typeof scripts.dev === "string") {
    return {
      appType: "vite-react",
      command,
      args: ["run", "dev", "--", "--host", host, "--port", String(port)],
      renderedCommand: `${packageManager} run dev -- --host ${host} --port ${port}`,
      packageManager,
      needsDependencyInstall: nodeModulesMissing,
      previewable: true,
      serverReloadMode: "hmr",
    };
  }

  const hasNodeWebFramework = hasDependency(packageJson, "express") || hasDependency(packageJson, "fastify");
  const nodeWebEntrypoint = await findNodeWebEntrypoint(workspacePath);
  if (hasNodeWebFramework || nodeWebEntrypoint !== null) {
    const previewScript = scriptNameForNodeWebPreview(scripts);
    const appType: PreviewAppType = hasNodeWebFramework ? "node-express" : "node";
    if (previewScript !== null) {
      const previewScriptBody = typeof scripts[previewScript] === "string" ? scripts[previewScript] : "";
      return {
        appType,
        command,
        args: ["run", previewScript],
        renderedCommand: `PORT=${port} HOST=${host} ${packageManager} run ${previewScript}`,
        packageManager,
        needsDependencyInstall: nodeModulesMissing,
        previewable: true,
        serverReloadMode: scriptUsesWatcher(previewScriptBody) ? "watcher" : "plain_process",
      };
    }

    if (nodeWebEntrypoint !== null) {
      return {
        appType,
        command: process.execPath,
        args: [nodeWebEntrypoint],
        renderedCommand: `PORT=${port} HOST=${host} node ${nodeWebEntrypoint}`,
        packageManager,
        needsDependencyInstall: nodeModulesMissing,
        previewable: true,
        serverReloadMode: "plain_process",
      };
    }

    return {
      appType: "node-cli",
      command,
      args: [],
      renderedCommand: "No web preview is available for this Node web workspace because no dev/start script or src/server.js entrypoint was found.",
      packageManager,
      needsDependencyInstall: false,
      previewable: false,
      serverReloadMode: "plain_process",
    };
  }

  if (typeof scripts.dev === "string") {
    return {
      appType: "node-cli",
      command,
      args: [],
      renderedCommand: "No web preview is available for this Node CLI workspace.",
      packageManager,
      needsDependencyInstall: false,
      previewable: false,
      serverReloadMode: "plain_process",
    };
  }

  return {
    appType: "node-cli",
    command,
    args: [],
    renderedCommand: "No web preview is available for this Node workspace.",
    packageManager,
    needsDependencyInstall: false,
    previewable: false,
    serverReloadMode: "plain_process",
  };

}

async function createDjangoPreviewCommand(workspacePath: string, port: number, host: string): Promise<PreviewCommand> {
  const pythonCommand = await pythonCommandForWorkspace(workspacePath);
  return {
    appType: "python-django",
    command: pythonCommand,
    args: ["manage.py", "runserver", `${host}:${port}`],
    renderedCommand: `python manage.py runserver ${host}:${port}`,
    packageManager: null,
    needsDependencyInstall: false,
    previewable: true,
    serverReloadMode: "plain_process",
  };
}

async function createRootPythonWebPreviewCommand(workspacePath: string, port: number, host: string): Promise<PreviewCommand> {
  const pythonCommand = await pythonCommandForWorkspace(workspacePath);
  const framework = await detectPythonWebFramework(workspacePath);
  if (framework === "fastapi") {
    return {
      appType: "python-flask",
      command: pythonCommand,
      args: ["-m", "uvicorn", "app:app", "--host", host, "--port", String(port)],
      renderedCommand: `python -m uvicorn app:app --host ${host} --port ${port}`,
      packageManager: null,
      needsDependencyInstall: false,
      previewable: true,
      serverReloadMode: "plain_process",
    };
  }
  if (framework === "flask") {
    return {
      appType: "python-flask",
      command: pythonCommand,
      args: ["-m", "flask", "--app", "app", "run", "--host", host, "--port", String(port)],
      renderedCommand: `python -m flask --app app run --host ${host} --port ${port}`,
      packageManager: null,
      needsDependencyInstall: false,
      previewable: true,
      serverReloadMode: "plain_process",
    };
  }
  return {
    appType: "python-flask",
    command: pythonCommand,
    args: ["app.py"],
    renderedCommand: `PORT=${port} python app.py`,
    packageManager: null,
    needsDependencyInstall: false,
    previewable: true,
    serverReloadMode: "plain_process",
  };
}

async function createShinyPreviewCommand(workspacePath: string, port: number, host: string): Promise<PreviewCommand> {
  const rscript = (await resolveRscriptCommand()).command;
  const expression = `shiny::runApp('.', host='${host}', port=${port}, launch.browser=FALSE)`;
  return {
    appType: "r-shiny",
    command: rscript,
    args: ["-e", expression],
    renderedCommand: `R_LIBS_USER=.rlib Rscript -e "${expression}"`,
    packageManager: null,
    needsDependencyInstall: false,
    previewable: true,
    serverReloadMode: "plain_process",
  };
}

function createRScriptPreviewCommand(rScriptPath: string, port: number, host: string, workspacePath: string): PreviewCommand {
  const previewRoot = path.join(workspacePath, rPreviewDir);
  return {
    appType: "r-script",
    command: process.execPath,
    args: [path.join(process.cwd(), "scripts", "static-preview-server.mjs"), "--root", previewRoot, "--host", host, "--port", String(port)],
    renderedCommand: `R_LIBS_USER=.rlib Rscript ${rScriptPath}; node scripts/static-preview-server.mjs --root ${previewRoot} --host ${host} --port ${port}`,
    packageManager: null,
    needsDependencyInstall: false,
    previewable: true,
    serverReloadMode: "rerun",
    rScriptPath,
  };
}

export async function detectPreviewCommand(workspacePath: string, port: number, host: string): Promise<PreviewCommand> {
  if (await fileExists(path.join(workspacePath, "manage.py"))) {
    return createDjangoPreviewCommand(workspacePath, port, host);
  }

  const hasRootPythonApp = await fileExists(path.join(workspacePath, "app.py"));
  if (hasRootPythonApp && await detectPythonWebFramework(workspacePath) !== "unknown") {
    return createRootPythonWebPreviewCommand(workspacePath, port, host);
  }

  if (await detectShiny(workspacePath)) {
    return createShinyPreviewCommand(workspacePath, port, host);
  }

  const packageJson = await readPackageJson(workspacePath);
  if (packageJson !== null) {
    const scripts = typeof packageJson.scripts === "object" && packageJson.scripts !== null
      ? packageJson.scripts as Record<string, unknown>
      : {};

    const packageCommand = await createPackagePreviewCommand(workspacePath, port, host, packageJson, scripts);
    if (packageCommand !== null) {
      if (!packageCommand.previewable && packageCommand.appType === "node-cli") {
        if (hasRootPythonApp) {
          return createRootPythonWebPreviewCommand(workspacePath, port, host);
        }
        const javaCommand = await createJavaPreviewCommand(workspacePath, port, host);
        if (javaCommand !== null) {
          return javaCommand;
        }
        const pythonScriptPath = await findPythonScriptEntrypoint(workspacePath);
        if (pythonScriptPath !== null) {
          const previewRoot = path.join(workspacePath, pythonPreviewDir);
          return {
            appType: "python-script",
            command: process.execPath,
            args: [path.join(process.cwd(), "scripts", "static-preview-server.mjs"), "--root", previewRoot, "--host", host, "--port", String(port)],
            renderedCommand: `MPLBACKEND=Agg python ${pythonScriptPath}; node scripts/static-preview-server.mjs --root ${previewRoot} --host ${host} --port ${port}`,
            packageManager: null,
            needsDependencyInstall: false,
            previewable: true,
            serverReloadMode: "rerun",
            pythonScriptPath,
          };
        }
      }
      return packageCommand;
    }
  }

  const javaCommand = await createJavaPreviewCommand(workspacePath, port, host);
  if (javaCommand !== null) {
    return javaCommand;
  }

  if (hasRootPythonApp) {
    return createRootPythonWebPreviewCommand(workspacePath, port, host);
  }

  const pythonScriptPath = await findPythonScriptEntrypoint(workspacePath);
  if (pythonScriptPath !== null) {
    const previewRoot = path.join(workspacePath, pythonPreviewDir);
    return {
      appType: "python-script",
      command: process.execPath,
      args: [path.join(process.cwd(), "scripts", "static-preview-server.mjs"), "--root", previewRoot, "--host", host, "--port", String(port)],
      renderedCommand: `MPLBACKEND=Agg python ${pythonScriptPath}; node scripts/static-preview-server.mjs --root ${previewRoot} --host ${host} --port ${port}`,
      packageManager: null,
      needsDependencyInstall: false,
      previewable: true,
      serverReloadMode: "rerun",
      pythonScriptPath,
    };
  }

  const rScriptPath = await findRScriptEntrypoint(workspacePath);
  if (rScriptPath !== null) {
    return createRScriptPreviewCommand(rScriptPath, port, host, workspacePath);
  }

  if (await fileExists(path.join(workspacePath, "go.mod")) || await fileExists(path.join(workspacePath, "main.go"))) {
    return {
      appType: "go",
      command: "go",
      args: ["run", "."],
      renderedCommand: `PORT=${port} HOST=${host} go run .`,
      packageManager: null,
      needsDependencyInstall: false,
      previewable: true,
      serverReloadMode: "plain_process",
    };
  }

  if (await fileExists(path.join(workspacePath, "Cargo.toml"))) {
    return {
      appType: "rust",
      command: "cargo",
      args: ["run"],
      renderedCommand: `PORT=${port} HOST=${host} cargo run`,
      packageManager: null,
      needsDependencyInstall: false,
      previewable: true,
      serverReloadMode: "plain_process",
    };
  }

  const hasDotnetProject = (await readdir(workspacePath).catch(() => []))
    .some((entry) => entry.endsWith(".csproj") || entry.endsWith(".sln"));
  if (hasDotnetProject || await fileExists(path.join(workspacePath, "Program.cs"))) {
    const dotnet = await resolveDotnetCommand();
    return {
      appType: "csharp",
      command: dotnet.command,
      args: ["run", "--urls", `http://${host}:${port}`],
      renderedCommand: `dotnet run --urls http://${host}:${port}`,
      packageManager: null,
      needsDependencyInstall: false,
      previewable: true,
      serverReloadMode: "plain_process",
    };
  }

  if (await fileExists(path.join(workspacePath, "public", "index.php"))) {
    const php = await resolvePhpCommand();
    const routerPath = phpPreviewRouterPath.replace(/\\/g, "/");
    const errorLogPath = phpPreviewErrorLogPath.replace(/\\/g, "/");
    return {
      appType: "php",
      command: php.command,
      args: [
        "-d",
        "display_errors=1",
        "-d",
        "log_errors=1",
        "-d",
        `error_log=${errorLogPath}`,
        "-S",
        `${host}:${port}`,
        "-t",
        "public",
        routerPath,
      ],
      renderedCommand: `php -d display_errors=1 -d log_errors=1 -d error_log=${errorLogPath} -S ${host}:${port} -t public ${routerPath}`,
      packageManager: null,
      needsDependencyInstall: false,
      previewable: true,
      serverReloadMode: "plain_process",
    };
  }

  if (await fileExists(path.join(workspacePath, "app.rb"))) {
    return {
      appType: "ruby",
      command: "ruby",
      args: ["app.rb"],
      renderedCommand: `PORT=${port} HOST=${host} ruby app.rb`,
      packageManager: null,
      needsDependencyInstall: false,
      previewable: true,
      serverReloadMode: "plain_process",
    };
  }

  if (await fileExists(path.join(workspacePath, "index.html"))) {
    return {
      appType: "static-html",
      command: process.execPath,
      args: [path.join(process.cwd(), "scripts", "static-preview-server.mjs"), "--root", workspacePath, "--host", host, "--port", String(port)],
      renderedCommand: `node scripts/static-preview-server.mjs --root ${workspacePath} --host ${host} --port ${port}`,
      packageManager: null,
      needsDependencyInstall: false,
      previewable: true,
      serverReloadMode: "static",
    };
  }

  return {
    appType: "unknown",
    command: process.execPath,
    args: [path.join(process.cwd(), "scripts", "static-preview-server.mjs"), "--root", workspacePath, "--host", host, "--port", String(port)],
    renderedCommand: `node scripts/static-preview-server.mjs --root ${workspacePath} --host ${host} --port ${port}`,
    packageManager: null,
    needsDependencyInstall: false,
    previewable: true,
    serverReloadMode: "static",
  };
}

function installArgs(packageManager: "npm" | "pnpm" | "yarn" | "bun"): string[] {
  if (packageManager === "npm") {
    return ["install", "--no-audit", "--no-fund"];
  }
  if (packageManager === "pnpm") {
    return ["install", "--no-frozen-lockfile"];
  }
  if (packageManager === "yarn") {
    return ["install"];
  }
  return ["install"];
}

function abortError(): Error {
  const error = new Error("Operation aborted by user.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const reason = signal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    throw abortError();
  }
}

async function installDependenciesIfNeeded(workspacePath: string, previewCommand: PreviewCommand, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal);
  if (!previewCommand.needsDependencyInstall || previewCommand.packageManager === null) {
    return { stdout: "", stderr: "" };
  }

  const result = await runProcess({
    command: await packageManagerCommand(previewCommand.packageManager),
    args: installArgs(previewCommand.packageManager),
    cwd: workspacePath,
    timeoutMs: 180000,
    env: createSanitizedProcessEnv({
      CI: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    }),
    signal,
  });

  if (result.aborted) {
    throwIfAborted(signal);
  }
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Dependency install failed before preview start.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

async function installPythonDependenciesIfNeeded(workspacePath: string, previewCommand: PreviewCommand, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal);
  if (!previewCommand.appType.startsWith("python-")) {
    return { stdout: "", stderr: "" };
  }
  if (!(await fileExists(path.join(workspacePath, "requirements.txt")))) {
    return { stdout: "", stderr: "" };
  }

  const python = await ensurePythonWorkspaceEnvironment({
    workspacePath,
    timeoutMs: 180000,
    signal,
  });
  if (python.setupResult?.aborted) {
    throwIfAborted(signal);
  }
  if (python.setupResult !== null && (python.setupResult.exitCode !== 0 || python.setupResult.timedOut)) {
    throw new Error(`Python virtual environment setup failed before preview start.\nSTDOUT:\n${python.setupResult.stdout}\nSTDERR:\n${python.setupResult.stderr}`);
  }

  const config = getConfig();
  const requirements = await readFile(path.join(workspacePath, "requirements.txt"), "utf8").catch(() => "");
  const analysis = analyzeRequirements(requirements);
  const mlWorkspace = config.mlPipelineEnabled && analysis.torchRequested && (await readExperimentManifest(workspacePath)) !== null;
  const installTimeout = mlWorkspace ? Math.max(180000, config.mlJobTimeoutMs) : 180000;
  const env = mlWorkspace
    ? pythonWorkspaceEnv(workspacePath, { CI: "true", ...mlCacheEnv() })
    : pythonWorkspaceEnv(workspacePath, { CI: "true" });

  let cudaStdout = "";
  let cudaStderr = "";
  let extraIndexArgs: string[] = [];
  let torchCpuFallback = false;
  if (mlWorkspace) {
    const cuda = await ensureCudaTorch({ workspacePath, pythonCommand: python.command, analysis, env, timeoutMs: installTimeout, signal });
    extraIndexArgs = cuda.extraIndexArgs;
    torchCpuFallback = cuda.cpuFallback;
    cudaStdout = cuda.stdout;
    cudaStderr = cuda.stderr;
  }

  const noCacheArg = mlWorkspace ? ["--no-cache-dir"] : [];
  const result = await runProcess({
    command: python.command,
    args: ["-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", ...noCacheArg, "-r", "requirements.txt", ...extraIndexArgs],
    cwd: workspacePath,
    timeoutMs: installTimeout,
    env,
    signal,
  });

  if (result.aborted) {
    throwIfAborted(signal);
  }
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Python dependency install failed before preview start.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  if (mlWorkspace) {
    await verifyVenvTorchInstall({
      workspacePath,
      analysis,
      signal,
      repair: { pythonCommand: python.command, env, timeoutMs: installTimeout },
      cpuFallback: torchCpuFallback,
    });
  }

  return {
    stdout: `${python.setupResult?.stdout ?? ""}${cudaStdout}${result.stdout}`,
    stderr: `${python.setupResult?.stderr ?? ""}${cudaStderr}${result.stderr}`,
  };
}

async function installRDependenciesIfNeeded(workspacePath: string, previewCommand: PreviewCommand, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal);
  if (!previewCommand.appType.startsWith("r-")) {
    return { stdout: "", stderr: "" };
  }
  const descriptionSource = await readTextIfExists(path.join(workspacePath, "DESCRIPTION"));
  if (descriptionSource === null) {
    return { stdout: "", stderr: "" };
  }
  const packages = parseRDescriptionPackages(descriptionSource);
  if (packages.length === 0) {
    return { stdout: "", stderr: "" };
  }

  await ensureRLibraryDir(workspacePath);
  const rscript = (await resolveRscriptCommand()).command;
  const result = await runProcess({
    command: rscript,
    args: ["--vanilla", "-e", rInstallExpression(packages)],
    cwd: workspacePath,
    timeoutMs: 600000,
    env: rWorkspaceEnv(workspacePath, { CI: "true" }),
    signal,
  });

  if (result.aborted) {
    throwIfAborted(signal);
  }
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`R package install failed before preview start.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

async function preparePythonWebPreviewIfNeeded(workspacePath: string, previewCommand: PreviewCommand, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal);
  if (previewCommand.appType !== "python-django") {
    return { stdout: "", stderr: "" };
  }

  const migrateResult = await runProcess({
    command: previewCommand.command,
    args: ["manage.py", "migrate", "--noinput"],
    cwd: workspacePath,
    timeoutMs: 180000,
    env: pythonWorkspaceEnv(workspacePath, { CI: "true" }),
    signal,
  });

  if (migrateResult.aborted) {
    throwIfAborted(signal);
  }
  if (migrateResult.exitCode !== 0 || migrateResult.timedOut) {
    throw new Error(`Django database migration failed before preview start.\nSTDOUT:\n${migrateResult.stdout}\nSTDERR:\n${migrateResult.stderr}`);
  }

  return {
    stdout: migrateResult.stdout,
    stderr: migrateResult.stderr,
  };
}

async function preparePhpPreviewIfNeeded(workspacePath: string, previewCommand: PreviewCommand, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal);
  if (previewCommand.appType !== "php") {
    return { stdout: "", stderr: "" };
  }

  await mkdir(path.join(workspacePath, ".orchestrator"), { recursive: true });
  const laravelWorkspace = await isLaravelWorkspace(workspacePath);
  if (laravelWorkspace) {
    await ensureLaravelWritableDirectories(workspacePath);
  }
  await writeFile(path.join(workspacePath, phpPreviewErrorLogPath), "", "utf8");
  await writeFile(path.join(workspacePath, phpPreviewRouterPath), `<?php
$publicRoot = realpath(__DIR__ . '/../public');
$requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
$requestPath = is_string($requestPath) && $requestPath !== '' ? urldecode($requestPath) : '/';

if ($publicRoot !== false && $requestPath !== '/') {
    $candidate = realpath($publicRoot . DIRECTORY_SEPARATOR . ltrim($requestPath, '/\\\\'));
    if ($candidate !== false && strncmp($candidate, $publicRoot, strlen($publicRoot)) === 0 && is_file($candidate)) {
        return false;
    }
}

require ($publicRoot !== false ? $publicRoot : __DIR__ . '/../public') . DIRECTORY_SEPARATOR . 'index.php';
`, "utf8");

  if (!(await fileExists(path.join(workspacePath, "composer.json"))) || await fileExists(path.join(workspacePath, "vendor", "autoload.php"))) {
    return { stdout: "", stderr: "" };
  }

  const composer = await resolveComposerCommand();
  const result = await runProcess({
    command: composer.command,
    args: ["install", "--no-interaction"],
    cwd: workspacePath,
    timeoutMs: 180000,
    env: createSanitizedProcessEnv({ CI: "true" }),
    signal,
  });

  if (result.aborted) {
    throwIfAborted(signal);
  }
  if ((result.exitCode !== 0 || result.timedOut) && laravelWorkspace) {
    const fallback = await runProcess({
      command: composer.command,
      args: ["install", "--no-interaction", "--no-scripts"],
      cwd: workspacePath,
      timeoutMs: 180000,
      env: createSanitizedProcessEnv({ CI: "true" }),
      signal,
    });
    if (fallback.aborted) {
      throwIfAborted(signal);
    }
    if (fallback.exitCode === 0 && !fallback.timedOut) {
      return {
        stdout: `${result.stdout}\nComposer install retry with --no-scripts succeeded for Laravel preview.\n${fallback.stdout}`,
        stderr: `${result.stderr}\n${fallback.stderr}`,
      };
    }
    throw new Error(`Composer install failed before PHP preview start.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}\n--no-scripts retry STDOUT:\n${fallback.stdout}\n--no-scripts retry STDERR:\n${fallback.stderr}`);
  }
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Composer install failed before PHP preview start.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }

  return { stdout: result.stdout, stderr: result.stderr };
}

async function isLaravelWorkspace(workspacePath: string): Promise<boolean> {
  if (await fileExists(path.join(workspacePath, "artisan")) && await fileExists(path.join(workspacePath, "bootstrap", "app.php"))) {
    return true;
  }
  const composerJson = await readTextIfExists(path.join(workspacePath, "composer.json"));
  if (composerJson === null) {
    return false;
  }
  try {
    const composer = JSON.parse(composerJson) as { require?: Record<string, unknown>; ["require-dev"]?: Record<string, unknown> };
    return composer.require?.["laravel/framework"] !== undefined || composer["require-dev"]?.["laravel/framework"] !== undefined;
  } catch {
    return false;
  }
}

async function ensureLaravelWritableDirectories(workspacePath: string): Promise<void> {
  const directories = [
    path.join("bootstrap", "cache"),
    path.join("storage", "app"),
    path.join("storage", "framework"),
    path.join("storage", "framework", "cache"),
    path.join("storage", "framework", "cache", "data"),
    path.join("storage", "framework", "sessions"),
    path.join("storage", "framework", "testing"),
    path.join("storage", "framework", "views"),
    path.join("storage", "logs"),
  ];
  await Promise.all(directories.map((directory) => mkdir(path.join(workspacePath, directory), { recursive: true })));
}

async function phpPreviewDiagnostics(workspacePath: string): Promise<string> {
  const candidates = [
    phpPreviewErrorLogPath,
    path.join("storage", "logs", "laravel.log"),
    path.join("var", "log", "dev.log"),
    path.join("var", "log", "prod.log"),
  ];
  const sections: string[] = [];
  for (const relativePath of candidates) {
    const content = await readTextIfExists(path.join(workspacePath, relativePath));
    const trimmed = content?.trim();
    if (trimmed === undefined || trimmed.length === 0) {
      continue;
    }
    sections.push(`\n--- ${relativePath.replace(/\\/g, "/")} ---\n${trimmed.slice(-maxTailLength)}`);
  }
  return sections.join("\n");
}

async function prepareJavaPreviewIfNeeded(workspacePath: string, previewCommand: PreviewCommand, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal);
  if (previewCommand.appType !== "java" || previewCommand.javaSourceFiles === undefined || previewCommand.javaSourceFiles.length === 0) {
    return { stdout: "", stderr: "" };
  }
  const classesDir = previewCommand.javaClassesDir ?? javaClassesDir;
  await rm(path.join(workspacePath, classesDir), { recursive: true, force: true });
  await mkdir(path.join(workspacePath, classesDir), { recursive: true });
  const result = await runProcess({
    command: "javac",
    args: ["-d", classesDir, ...previewCommand.javaSourceFiles.map((file) => (file.replace(/\\/g, "/").startsWith("-") ? `./${file}` : file))],
    cwd: workspacePath,
    timeoutMs: 180000,
    env: createSanitizedProcessEnv({ CI: "true" }),
    signal,
  });
  if (result.aborted) {
    throwIfAborted(signal);
  }
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Java compilation failed before preview start.\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function collectPreviewCandidateFiles(workspacePath: string, current = "", depth = 0): Promise<string[]> {
  if (depth > 4) {
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
    if (
      entry.name === ".git"
      || entry.name === ".agy"
      || entry.name === ".antigravity"
      || entry.name === ".antigravitycli"
      || entry.name === ".gemini"
      || entry.name === ".orchestrator"
      || entry.name === "__pycache__"
      || entry.name === "node_modules"
      || entry.name === ".rlib"
      || entry.name === "renv"
      || entry.name === ".Rproj.user"
      || entry.name === "packrat"
    ) {
      continue;
    }
    if (entry.name === "AGENTS.md") {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectPreviewCandidateFiles(workspacePath, relative, depth + 1));
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (previewOutputExtensions.has(extension) || previewTextExtensions.has(extension)) {
      files.push(relative.replace(/\\/g, "/"));
    }
  }
  return files.sort();
}

function outputFileHtml(files: string[]): string {
  if (files.length === 0) {
    return "<p class=\"muted\">No image or text output files were produced.</p>";
  }

  return files.map((file) => {
    const extension = path.extname(file).toLowerCase();
    const href = `assets/${safeAssetName(file)}`;
    if ([".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif"].includes(extension)) {
      return `<figure><img src="${href}" alt="${escapeHtml(file)}" /><figcaption>${escapeHtml(file)}</figcaption></figure>`;
    }
    return `<p><a href="${href}" target="_blank" rel="noreferrer">${escapeHtml(file)}</a></p>`;
  }).join("\n");
}

async function copyPreviewOutputFiles(workspacePath: string, previewRoot: string, files: string[]): Promise<void> {
  const assetsDir = path.join(previewRoot, "assets");
  await mkdir(assetsDir, { recursive: true });
  for (const file of files) {
    await copyFile(path.join(workspacePath, file), path.join(assetsDir, safeAssetName(file)));
  }
}

function mlExperimentPreviewHtml(scriptPath: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ML Experiment Workspace</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #172033; background: #f3f6fa; }
      body { margin: 0; padding: 24px; }
      main { max-width: 760px; margin: 0 auto; }
      section { background: #fff; border: 1px solid #d7e0ea; border-radius: 8px; padding: 22px; box-shadow: 0 12px 32px rgb(23 32 51 / 7%); }
      h1 { margin: 0 0 12px; line-height: 1.1; }
      .muted { color: #667085; }
      code { font-family: "SFMono-Regular", Consolas, monospace; background: #eef2f7; padding: 2px 6px; border-radius: 4px; }
      ul { line-height: 1.8; margin: 12px 0 0; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>ML experiment workspace</h1>
        <p class="muted">The headless preview does not execute <code>${escapeHtml(scriptPath)}</code> — training is driven by the orchestrator, not by rendering the entrypoint on every snapshot.</p>
        <ul>
          <li><strong>Run it</strong> from the <strong>Experiment runtime</strong> panel (Run smoke / short / full).</li>
          <li><strong>Test the trained model</strong> from the <strong>Inference playground</strong> panel after a short or full run.</li>
        </ul>
      </section>
    </main>
  </body>
</html>
`;
}

async function preparePythonScriptPreview(
  workspacePath: string,
  timeoutMs: number,
  scriptPath: string,
  runParams: PythonRunParams | null,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal);
  const previewRoot = path.join(workspacePath, pythonPreviewDir);
  const assetsDir = path.join(previewRoot, "assets");
  await rm(assetsDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(assetsDir, { recursive: true });

  if (getConfig().mlPipelineEnabled) {
    const manifest = await readExperimentManifest(workspacePath).catch(() => null);
    if (manifest !== null && path.basename(manifest.entrypoint) === path.basename(scriptPath)) {
      await writeFile(path.join(previewRoot, "index.html"), mlExperimentPreviewHtml(scriptPath), "utf8");
      return {
        stdout: `ML experiment workspace: the headless preview does not execute ${scriptPath}. Use the Experiment runtime panel to run it, then the Inference playground to test the model.`,
        stderr: "",
      };
    }
  }

  const figureFormat = runParams?.matplotlib.format ?? "png";

  const scriptAbsolutePath = path.join(workspacePath, scriptPath);
  const runnerPath = path.join(previewRoot, "run_preview.py");
  const runnerSource = `import json
import os
import runpy
import sys

script_path = os.environ["PYTHON_PREVIEW_SCRIPT"]
assets_dir = os.environ["PYTHON_PREVIEW_ASSETS"]
figure_format = os.environ.get("PYTHON_PREVIEW_FIGURE_FORMAT", "png")
extra_argv = json.loads(os.environ.get("PYTHON_PREVIEW_ARGV", "[]"))

# Present the chosen entrypoint and user arguments to the script as a normal CLI invocation.
sys.argv = [script_path, *extra_argv]

# Put the script's own directory on sys.path so sibling-module imports (e.g. "from model import ...") resolve
# exactly as "python <script>" would. runpy.run_path does not add the file's directory for a plain .py path.
_script_dir = os.path.dirname(os.path.abspath(script_path))
if _script_dir and _script_dir not in sys.path:
    sys.path.insert(0, _script_dir)

try:
    import matplotlib
    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt
    requested_style = os.environ.get("PYTHON_PREVIEW_MPL_STYLE", "")
    if requested_style:
        try:
            plt.style.use(requested_style)
        except Exception:
            pass
    requested_dpi = os.environ.get("PYTHON_PREVIEW_MPL_DPI", "")
    if requested_dpi:
        try:
            plt.rcParams["figure.dpi"] = float(requested_dpi)
            plt.rcParams["savefig.dpi"] = float(requested_dpi)
        except Exception:
            pass
except Exception:
    plt = None
    try:
        os.makedirs(assets_dir, exist_ok=True)
        with open(os.path.join(assets_dir, "_preview_warning.txt"), "w", encoding="utf-8") as handle:
            handle.write("matplotlib could not be imported; no figures were captured.")
    except Exception:
        pass


def save_open_figures():
    if plt is None:
        return
    os.makedirs(assets_dir, exist_ok=True)
    for figure_number in plt.get_fignums():
        figure = plt.figure(figure_number)
        try:
            figure.savefig(os.path.join(assets_dir, f"figure-{figure_number}.{figure_format}"), bbox_inches="tight")
        except Exception:
            figure.savefig(os.path.join(assets_dir, f"figure-{figure_number}.png"), bbox_inches="tight")


if plt is not None:
    def preview_show(*args, **kwargs):
        save_open_figures()

    plt.show = preview_show

try:
    runpy.run_path(script_path, run_name="__main__")
finally:
    save_open_figures()
`;
  await writeFile(runnerPath, runnerSource, "utf8");

  const result = await runProcess({
    command: (await resolvePythonCommand(workspacePath)).command,
    args: [runnerPath],
    cwd: workspacePath,
    timeoutMs: Math.max(timeoutMs, 180000),
    stdin: runParams !== null && runParams.stdin.length > 0 ? runParams.stdin : undefined,
    env: createSanitizedProcessEnv({
      ...(runParams?.env ?? {}),
      CI: "true",
      MPLBACKEND: "Agg",
      PYTHON_PREVIEW_ASSETS: assetsDir,
      PYTHON_PREVIEW_SCRIPT: scriptAbsolutePath,
      PYTHON_PREVIEW_FIGURE_FORMAT: figureFormat,
      PYTHON_PREVIEW_ARGV: JSON.stringify(runParams?.argv ?? []),
      PYTHON_PREVIEW_MPL_DPI: runParams?.matplotlib.dpi !== null && runParams?.matplotlib.dpi !== undefined ? String(runParams.matplotlib.dpi) : "",
      PYTHON_PREVIEW_MPL_STYLE: runParams?.matplotlib.style ?? "",
      PYTHONWARNINGS: "ignore:FigureCanvasAgg is non-interactive:UserWarning",
      PYTHONUNBUFFERED: "1",
    }),
    signal,
  });
  if (result.aborted) {
    throwIfAborted(signal);
  }

  const source = await readFile(scriptAbsolutePath, "utf8").catch(() => "");
  const outputFiles = await collectPreviewCandidateFiles(workspacePath);
  await copyPreviewOutputFiles(workspacePath, previewRoot, outputFiles);
  const capturedFigures = await readdir(assetsDir).then((files) => files
    .filter((file) => previewOutputExtensions.has(path.extname(file).toLowerCase()))
    .sort()
  ).catch(() => []);
  const displayFiles = Array.from(new Set([...capturedFigures, ...outputFiles]));
  const matplotlibImportFailed = await fileExists(path.join(assetsDir, "_preview_warning.txt"));
  const sourceUsesMatplotlib = /\bmatplotlib\b|\bpyplot\b|\bplt\./.test(source);
  const matplotlibWarningHtml = matplotlibImportFailed
    ? `<section style="border-color:#e0a800;background:#fff8e1;">
        <h2>⚠ matplotlib could not be imported</h2>
        <p class="muted">This script uses matplotlib, but it is not installed in the preview environment, so no figures were captured. Add <code>matplotlib</code> to <code>requirements.txt</code> and re-run.</p>
      </section>`
    : sourceUsesMatplotlib && displayFiles.length === 0
      ? `<section style="border-color:#e0a800;background:#fff8e1;">
        <h2>⚠ No figures were captured</h2>
        <p class="muted">matplotlib is available, but this run produced no figures. Make sure the script calls <code>plt.show()</code> or <code>plt.savefig(...)</code>.</p>
      </section>`
      : "";

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Python Script Preview</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f3f6fa; }
      body { margin: 0; padding: 24px; }
      main { max-width: 1120px; margin: 0 auto; display: grid; gap: 18px; }
      section { background: #fff; border: 1px solid #d7e0ea; border-radius: 8px; padding: 18px; box-shadow: 0 12px 32px rgb(23 32 51 / 7%); }
      h1, h2 { margin: 0 0 12px; line-height: 1.1; }
      .status { display: inline-flex; border-radius: 999px; padding: 5px 10px; font-size: 0.82rem; font-weight: 700; background: ${result.exitCode === 0 && !result.timedOut ? "#d9f3ef" : "#fff1f0"}; color: ${result.exitCode === 0 && !result.timedOut ? "#115e59" : "#b42318"}; }
      .muted { color: #667085; }
      .outputs { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
      figure { margin: 0; display: grid; gap: 8px; }
      img { max-width: 100%; height: auto; border: 1px solid #d7e0ea; border-radius: 6px; background: #fff; }
      figcaption { color: #667085; font-size: 0.9rem; }
      pre { margin: 0; overflow: auto; background: #111827; color: #f9fafb; border-radius: 6px; padding: 14px; line-height: 1.5; }
      code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>Python Script Preview</h1>
        <p class="status">${result.timedOut ? "Timed out" : result.exitCode === 0 ? "Completed" : `Exited ${result.exitCode ?? "unknown"}`}</p>
        <p class="muted">${escapeHtml(scriptPath)}</p>
      </section>
      ${matplotlibWarningHtml}
      <section>
        <h2>Visual and File Output</h2>
        <div class="outputs">${outputFileHtml(displayFiles)}</div>
      </section>
      <section>
        <h2>stdout</h2>
        <pre><code>${escapeHtml(result.stdout.trim() || "(empty)")}</code></pre>
      </section>
      <section>
        <h2>stderr</h2>
        <pre><code>${escapeHtml(result.stderr.trim() || "(empty)")}</code></pre>
      </section>
      <section>
        <h2>${escapeHtml(scriptPath)}</h2>
        <pre><code>${escapeHtml(source)}</code></pre>
      </section>
    </main>
  </body>
</html>
`;
  await writeFile(path.join(previewRoot, "index.html"), html, "utf8");

  const renderedArgv = (runParams?.argv ?? []).join(" ");
  return {
    stdout: `$ MPLBACKEND=Agg python ${scriptPath}${renderedArgv.length > 0 ? ` ${renderedArgv}` : ""}
exit=${result.exitCode === null ? "null" : String(result.exitCode)} timedOut=${result.timedOut ? "true" : "false"}

STDOUT:
${result.stdout}
`,
    stderr: result.stderr,
  };
}

async function prepareRScriptPreview(
  workspacePath: string,
  timeoutMs: number,
  scriptPath: string,
  runParams: RRunParams | null,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string }> {
  throwIfAborted(signal);
  const previewRoot = path.join(workspacePath, rPreviewDir);
  const assetsDir = path.join(previewRoot, "assets");
  await rm(assetsDir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(assetsDir, { recursive: true });
  await ensureRLibraryDir(workspacePath);

  const figureFormat = runParams?.graphics.format ?? "png";
  const scriptAbsolutePath = path.join(workspacePath, scriptPath);
  const runnerPath = path.join(previewRoot, "run_preview.R");
  const runnerSource = `assets_dir <- Sys.getenv("R_PREVIEW_ASSETS")
script_path <- Sys.getenv("R_PREVIEW_SCRIPT")
fmt <- Sys.getenv("R_PREVIEW_FORMAT", unset = "png")
lib <- Sys.getenv("R_LIBS_USER", unset = "")
if (nzchar(lib)) .libPaths(c(lib, .libPaths()))
dir.create(assets_dir, showWarnings = FALSE, recursive = TRUE)

dpi <- suppressWarnings(as.numeric(Sys.getenv("R_PREVIEW_DPI", unset = "")))
if (is.na(dpi)) dpi <- 96
width <- suppressWarnings(as.numeric(Sys.getenv("R_PREVIEW_WIDTH", unset = "")))
if (is.na(width)) width <- 1200
height <- suppressWarnings(as.numeric(Sys.getenv("R_PREVIEW_HEIGHT", unset = "")))
if (is.na(height)) height <- 800

# A single multi-page device with %03d in the filename writes one file per plot
# page, capturing every auto-printed ggplot / base plot without device juggling.
pattern <- file.path(assets_dir, paste0("figure-%03d.", fmt))
if (identical(fmt, "svg")) {
  grDevices::svg(pattern, onefile = FALSE, width = width / dpi, height = height / dpi)
} else if (identical(fmt, "pdf")) {
  grDevices::pdf(pattern, onefile = FALSE, width = width / dpi, height = height / dpi)
} else if (identical(fmt, "jpeg")) {
  grDevices::jpeg(pattern, width = width, height = height, res = dpi)
} else {
  grDevices::png(pattern, width = width, height = height, res = dpi)
}

# print.eval = TRUE auto-prints top-level results so a bare ggplot object renders,
# mirroring matplotlib's plt.show() capture in the Python preview.
result <- try(source(script_path, echo = FALSE, print.eval = TRUE), silent = FALSE)
grDevices::graphics.off()
if (inherits(result, "try-error")) quit(status = 1)
`;
  await writeFile(runnerPath, runnerSource, "utf8");

  const rscript = (await resolveRscriptCommand()).command;
  const result = await runProcess({
    command: rscript,
    args: ["--vanilla", runnerPath, ...(runParams?.argv ?? [])],
    cwd: workspacePath,
    timeoutMs: Math.max(timeoutMs, 180000),
    stdin: runParams !== null && runParams.stdin.length > 0 ? runParams.stdin : undefined,
    env: rWorkspaceEnv(workspacePath, {
      ...(runParams?.env ?? {}),
      CI: "true",
      R_PREVIEW_ASSETS: assetsDir,
      R_PREVIEW_SCRIPT: scriptAbsolutePath,
      R_PREVIEW_FORMAT: figureFormat,
      R_PREVIEW_DPI: runParams?.graphics.dpi !== null && runParams?.graphics.dpi !== undefined ? String(runParams.graphics.dpi) : "",
      R_PREVIEW_WIDTH: runParams?.graphics.width !== null && runParams?.graphics.width !== undefined ? String(runParams.graphics.width) : "",
      R_PREVIEW_HEIGHT: runParams?.graphics.height !== null && runParams?.graphics.height !== undefined ? String(runParams.graphics.height) : "",
    }),
    signal,
  });
  if (result.aborted) {
    throwIfAborted(signal);
  }

  const source = await readFile(scriptAbsolutePath, "utf8").catch(() => "");
  const outputFiles = await collectPreviewCandidateFiles(workspacePath);
  await copyPreviewOutputFiles(workspacePath, previewRoot, outputFiles);
  const capturedFigures = await readdir(assetsDir).then((files) => files
    .filter((file) => previewOutputExtensions.has(path.extname(file).toLowerCase()))
    .sort()
  ).catch(() => []);
  const displayFiles = Array.from(new Set([...capturedFigures, ...outputFiles]));

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>R Script Preview</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f3f6fa; }
      body { margin: 0; padding: 24px; }
      main { max-width: 1120px; margin: 0 auto; display: grid; gap: 18px; }
      section { background: #fff; border: 1px solid #d7e0ea; border-radius: 8px; padding: 18px; box-shadow: 0 12px 32px rgb(23 32 51 / 7%); }
      h1, h2 { margin: 0 0 12px; line-height: 1.1; }
      .status { display: inline-flex; border-radius: 999px; padding: 5px 10px; font-size: 0.82rem; font-weight: 700; background: ${result.exitCode === 0 && !result.timedOut ? "#d9f3ef" : "#fff1f0"}; color: ${result.exitCode === 0 && !result.timedOut ? "#115e59" : "#b42318"}; }
      .muted { color: #667085; }
      .outputs { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
      figure { margin: 0; display: grid; gap: 8px; }
      img { max-width: 100%; height: auto; border: 1px solid #d7e0ea; border-radius: 6px; background: #fff; }
      figcaption { color: #667085; font-size: 0.9rem; }
      pre { margin: 0; overflow: auto; background: #111827; color: #f9fafb; border-radius: 6px; padding: 14px; line-height: 1.5; }
      code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>R Script Preview</h1>
        <p class="status">${result.timedOut ? "Timed out" : result.exitCode === 0 ? "Completed" : `Exited ${result.exitCode ?? "unknown"}`}</p>
        <p class="muted">${escapeHtml(scriptPath)}</p>
      </section>
      <section>
        <h2>Visual and File Output</h2>
        <div class="outputs">${outputFileHtml(displayFiles)}</div>
      </section>
      <section>
        <h2>stdout</h2>
        <pre><code>${escapeHtml(result.stdout.trim() || "(empty)")}</code></pre>
      </section>
      <section>
        <h2>stderr</h2>
        <pre><code>${escapeHtml(result.stderr.trim() || "(empty)")}</code></pre>
      </section>
      <section>
        <h2>${escapeHtml(scriptPath)}</h2>
        <pre><code>${escapeHtml(source)}</code></pre>
      </section>
    </main>
  </body>
</html>
`;
  await writeFile(path.join(previewRoot, "index.html"), html, "utf8");

  const renderedArgv = (runParams?.argv ?? []).join(" ");
  return {
    stdout: `$ R_LIBS_USER=.rlib Rscript ${scriptPath}${renderedArgv.length > 0 ? ` ${renderedArgv}` : ""}
exit=${result.exitCode === null ? "null" : String(result.exitCode)} timedOut=${result.timedOut ? "true" : "false"}

STDOUT:
${result.stdout}
`,
    stderr: result.stderr,
  };
}

async function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function isPortListening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function listeningPidsForPort(port: number): Promise<number[]> {
  if (process.platform !== "win32") {
    return [];
  }
  const result = await runProcess({
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-Command",
      `$ErrorActionPreference='SilentlyContinue'; Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique | ConvertTo-Json -Compress`,
    ],
    cwd: process.cwd(),
    timeoutMs: 5000,
    env: createSanitizedProcessEnv(),
  }).catch(() => null);
  if (result === null || result.exitCode !== 0 || result.stdout.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values
      .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0)
      .filter((pid) => pid !== process.pid);
  } catch {
    return result.stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  }
}

async function listeningPidsByPort(startPort: number, endPort: number): Promise<Map<number, number[]>> {
  const byPort = new Map<number, number[]>();
  if (process.platform !== "win32") {
    return byPort;
  }
  const result = await runProcess({
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-Command",
      `$ErrorActionPreference='SilentlyContinue'; Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge ${startPort} -and $_.LocalPort -le ${endPort} } | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress`,
    ],
    cwd: process.cwd(),
    timeoutMs: 5000,
    env: createSanitizedProcessEnv(),
  }).catch(() => null);
  if (result === null || result.exitCode !== 0 || result.stdout.trim().length === 0) {
    return byPort;
  }
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const record = row as Record<string, unknown>;
      const port = typeof record.LocalPort === "number" ? record.LocalPort : null;
      const pid = typeof record.OwningProcess === "number" ? record.OwningProcess : null;
      if (port === null || pid === null || pid <= 0 || pid === process.pid) continue;
      const list = byPort.get(port) ?? [];
      if (!list.includes(pid)) {
        list.push(pid);
      }
      byPort.set(port, list);
    }
  } catch {
    return byPort;
  }
  return byPort;
}

function wildcardHostFor(host: string): string | null {
  if (host === "0.0.0.0" || host === "::") {
    return null;
  }
  if (host === "::1" || host.includes(":")) {
    return "::";
  }
  return "0.0.0.0";
}

async function isPreviewPortAvailable(port: number, host: string): Promise<boolean> {
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  if (await isPortListening(port, connectHost)) {
    return false;
  }

  if (!(await isPortFree(port, host))) {
    return false;
  }

  const wildcardHost = wildcardHostFor(host);
  if (wildcardHost === null) {
    return true;
  }

  return isPortFree(port, wildcardHost);
}

async function allocatePort(host: string, start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    if (await isPreviewPortAvailable(port, host)) {
      return port;
    }
  }
  throw new Error(`No free preview ports in range ${start}-${end}.`);
}

async function healthPathsForPreview(workspacePath: string, appType: PreviewAppType): Promise<string[]> {
  const paths = ["/"];
  if (appType === "static-html") {
    const candidates = [
      { file: path.join(workspacePath, "public", "about.html"), path: "/about" },
      { file: path.join(workspacePath, "public", "contact.html"), path: "/contact" },
      { file: path.join(workspacePath, "public", "styles.css"), path: "/styles.css" },
      { file: path.join(workspacePath, "public", "script.js"), path: "/script.js" },
      { file: path.join(workspacePath, "src", "main", "resources", "public", "styles.css"), path: "/styles.css" },
      { file: path.join(workspacePath, "src", "main", "resources", "public", "script.js"), path: "/script.js" },
      { file: path.join(workspacePath, "static", "styles.css"), path: "/static/styles.css" },
      { file: path.join(workspacePath, "static", "app.js"), path: "/static/app.js" },
      { file: path.join(workspacePath, "about.html"), path: "/about.html" },
      { file: path.join(workspacePath, "contact.html"), path: "/contact.html" },
      { file: path.join(workspacePath, "styles.css"), path: "/styles.css" },
      { file: path.join(workspacePath, "script.js"), path: "/script.js" },
    ];
    for (const candidate of candidates) {
      if (await fileExists(candidate.file)) {
        paths.push(candidate.path);
      }
    }
  }
  return Array.from(new Set(paths));
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchWithTimeout(url: URL, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  throwIfAborted(signal);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(url, { cache: "no-store", redirect: "manual", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function combinedAbortSignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  const controller = new AbortController();
  const onAbort = (event: Event): void => {
    const signal = event.target instanceof AbortSignal ? event.target : undefined;
    controller.abort(signal?.reason ?? abortError());
  };
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason ?? abortError());
      return controller.signal;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

type PreviewHealthFailureReason = "health_timeout" | "process_exit";

interface PreviewHealthResult {
  healthy: boolean;
  failedPath: string | null;
  failureReason: PreviewHealthFailureReason | null;
}

function previewHealthFailureMessage(prefix: string, health: PreviewHealthResult): string {
  if (health.failureReason === "process_exit") {
    return `${prefix} process exited before health checks passed.`;
  }
  return `${prefix} health check failed for: ${health.failedPath ?? "/"}.`;
}

interface SameOriginAsset {
  href: string;
  label: string;
}

function extractSameOriginAssetPaths(html: string, baseUrl: string): SameOriginAsset[] {
  const results = new Map<string, SameOriginAsset>();
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const patterns = [
    /<link\b[^>]*\brel=["']?stylesheet["']?[^>]*\bhref=["']([^"']+)["']/gi,
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']?stylesheet["']?/gi,
    /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const raw = match[1] ?? "";
      if (raw.length === 0 || raw.startsWith("data:") || raw.startsWith("#")) {
        continue;
      }
      let resolved: URL;
      try {
        resolved = new URL(raw, base);
      } catch {
        continue;
      }
      if (resolved.origin !== base.origin) {
        continue;
      }
      results.set(resolved.href, { href: resolved.href, label: `${resolved.pathname}${resolved.search}` });
    }
  }
  return Array.from(results.values());
}

async function waitForHealth(
  url: string,
  paths: string[],
  timeoutMs = 12000,
  signal?: AbortSignal,
  isProcessStillAlive?: () => boolean,
  discoverHomepageAssets = false,
  bootTimeoutMs = 45000,
): Promise<PreviewHealthResult> {
  let deadline = Date.now() + Math.max(timeoutMs, bootTimeoutMs);
  let firstContact = false;
  let lastFailedPath: string | null = paths[0] ?? "/";
  let discoveredAssets: SameOriginAsset[] | null = null;
  const homepagePath = paths[0] ?? "/";
  const recordFirstContact = (): void => {
    if (!firstContact) {
      firstContact = true;
      deadline = Math.min(deadline, Date.now() + timeoutMs);
    }
  };
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (isProcessStillAlive !== undefined && !isProcessStillAlive()) {
      return { healthy: false, failedPath: "process exited", failureReason: "process_exit" };
    }
    try {
      let failedPath: string | null = null;
      for (const pathname of paths) {
        throwIfAborted(signal);
        if (isProcessStillAlive !== undefined && !isProcessStillAlive()) {
          return { healthy: false, failedPath: "process exited", failureReason: "process_exit" };
        }
        const requestTimeoutMs = Math.max(250, Math.min(2000, deadline - Date.now()));
        const response = await fetchWithTimeout(new URL(pathname, url), requestTimeoutMs, signal);
        recordFirstContact();
        if (!response.ok) {
          failedPath = `${pathname} (HTTP ${response.status})`;
          break;
        }
        if (discoverHomepageAssets && discoveredAssets === null && pathname === homepagePath) {
          try {
            discoveredAssets = extractSameOriginAssetPaths(await response.text(), url);
          } catch {
            discoveredAssets = [];
          }
        }
      }
      if (failedPath === null && discoveredAssets !== null) {
        for (const asset of discoveredAssets) {
          throwIfAborted(signal);
          if (isProcessStillAlive !== undefined && !isProcessStillAlive()) {
            return { healthy: false, failedPath: "process exited", failureReason: "process_exit" };
          }
          const requestTimeoutMs = Math.max(250, Math.min(2000, deadline - Date.now()));
          const response = await fetchWithTimeout(new URL(asset.href), requestTimeoutMs, signal);
          if (!response.ok) {
            failedPath = `${asset.label} (HTTP ${response.status}, referenced by ${homepagePath})`;
            break;
          }
        }
      }
      if (failedPath === null) {
        return { healthy: true, failedPath: null, failureReason: null };
      }
      lastFailedPath = failedPath;
    } catch (error) {
      throwIfAborted(signal);
      lastFailedPath = error instanceof Error && error.message.length > 0
        ? `${paths[0] ?? "/"} (${error.message})`
        : paths[0] ?? "/";
    }
    await abortableDelay(300, signal);
  }
  return { healthy: false, failedPath: lastFailedPath, failureReason: "health_timeout" };
}

function isProcessAlive(pid: number): boolean {
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

function isIdleTerminalState(state: WorkSessionState): boolean {
  return state === "completed" || state === "blocked" || state === "failed" || state === "canceled" || state === "handoff_needed";
}

function clearIdleTimer(previewId: Identifier): void {
  const timer = previewIdleTimers.get(previewId);
  if (timer !== undefined) {
    clearTimeout(timer);
    previewIdleTimers.delete(previewId);
  }
}

function scheduleIdleTimer(previewId: Identifier, expiresAt: string): void {
  clearIdleTimer(previewId);
  const delayMs = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    previewIdleTimers.delete(previewId);
    void expirePreviewIfStillIdle(previewId).catch((error) => {
      logProcess("error", "preview.idle_stop.failed", {
        previewId,
        message: error instanceof Error ? error.message : "unknown idle stop error",
      });
    });
  }, delayMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  previewIdleTimers.set(previewId, timer);
}

interface ParkedPreviewPort {
  server: http.Server;
  previewId: Identifier;
  workSessionId: Identifier;
  reviving: boolean;
}

const parkedPreviewPorts = new Map<number, ParkedPreviewPort>();

const wakePageHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Preview waking up…</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0b1120;color:#e2e8f0}main{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.25rem;font-weight:600}p{color:#94a3b8}</style></head>
<body><main><h1>Preview is waking up…</h1><p>The app server was stopped after a period of inactivity and is restarting now. This page reloads automatically once it is ready.</p></main>
<script>
(function poll(attempt){
  if (attempt > 150) { document.querySelector("p").textContent = "The preview did not come back. Open the orchestrator UI and press Start."; return; }
  setTimeout(function(){
    fetch(window.location.href, { cache: "no-store" }).then(function(response){
      if (response.headers.get("x-cdl-parked") === "1") { poll(attempt + 1); return; }
      window.location.reload();
    }).catch(function(){ poll(attempt + 1); });
  }, 1500);
})(0);
</script></body></html>`;

function releaseParkedPreviewPort(port: number, reason: string): void {
  const parked = parkedPreviewPorts.get(port);
  if (parked === undefined) {
    return;
  }
  parkedPreviewPorts.delete(port);
  try {
    parked.server.closeAllConnections();
  } catch {
  }
  parked.server.close();
  logProcess("info", "preview.port.unparked", { port, previewId: parked.previewId, reason });
}

function releaseParkedPortsForWorkSession(workSessionId: Identifier, reason: string): void {
  for (const [port, parked] of Array.from(parkedPreviewPorts.entries())) {
    if (parked.workSessionId === workSessionId) {
      releaseParkedPreviewPort(port, reason);
    }
  }
}

async function reviveParkedPreview(port: number, parked: ParkedPreviewPort): Promise<void> {
  logProcess("info", "preview.wake.start", { port, previewId: parked.previewId, workSessionId: parked.workSessionId });
  releaseParkedPreviewPort(port, "wake");
  const db = await getDatabaseSnapshot();
  const workSession = db.workSessions.find((entry) => entry.id === parked.workSessionId);
  if (workSession === undefined) {
    return;
  }
  await startPreviewForWorkSession(workSession, { policy: "refresh_existing_or_start" });
  await armPreviewIdleStopForWorkSession(workSession.id, "wake-on-request");
}

function parkIdleStoppedPreviewPort(stopped: PreviewServerRecord): void {
  if (stopped.port <= 0) {
    return;
  }
  releaseParkedPreviewPort(stopped.port, "repark");
  const server = http.createServer((_request, response) => {
    const parked = parkedPreviewPorts.get(stopped.port);
    if (parked !== undefined && !parked.reviving) {
      parked.reviving = true;
      void reviveParkedPreview(stopped.port, parked).catch((error) => {
        parked.reviving = false;
        logProcess("error", "preview.wake.failed", {
          port: stopped.port,
          previewId: stopped.id,
          message: error instanceof Error ? error.message : "unknown wake failure",
        });
      });
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-cdl-parked": "1", "cache-control": "no-store" });
    response.end(wakePageHtml);
  });
  server.unref();
  server.once("error", (error) => {
    parkedPreviewPorts.delete(stopped.port);
    logProcess("warn", "preview.port.park_failed", {
      port: stopped.port,
      previewId: stopped.id,
      message: error instanceof Error ? error.message : "unknown park failure",
    });
  });
  server.listen(stopped.port, getConfig().previewHost, () => {
    logProcess("info", "preview.port.parked", { port: stopped.port, previewId: stopped.id, workSessionId: stopped.workSessionId });
  });
  parkedPreviewPorts.set(stopped.port, { server, previewId: stopped.id, workSessionId: stopped.workSessionId, reviving: false });
}

async function expirePreviewIfStillIdle(previewId: Identifier): Promise<void> {
  const now = currentTimestamp();
  const candidate = await mutateDatabase((db) => {
    const preview = db.previewServers.find((entry) => entry.id === previewId);
    if (preview === undefined || preview.status === "stopped" || preview.status === "unavailable") {
      return null;
    }
    if (preview.idleExpiresAt === null || preview.idleExpiresAt === undefined || new Date(preview.idleExpiresAt).getTime() > Date.now()) {
      return null;
    }
    const workSession = db.workSessions.find((entry) => entry.id === preview.workSessionId);
    if (workSession === undefined || !isIdleTerminalState(workSession.currentState)) {
      preview.idleExpiresAt = null;
      return null;
    }
    if (preview.pid === null || !isProcessAlive(preview.pid)) {
      preview.status = "stopped";
      preview.stoppedAt = preview.stoppedAt ?? now;
      preview.pid = null;
      preview.idleExpiresAt = null;
      preview.stoppedReason = "process_exit";
      return null;
    }
    return { ...preview };
  });
  if (candidate === null) {
    return;
  }

  await stopProcessForPreview(candidate.id, candidate.pid, candidate.port);
  const stopped = await mutateDatabase((db) => {
    const preview = db.previewServers.find((entry) => entry.id === previewId);
    if (preview === undefined) {
      return null;
    }
    preview.status = "stopped";
    preview.stoppedAt = now;
    preview.pid = null;
    preview.idleExpiresAt = null;
    preview.stoppedReason = "idle_timeout";
    return { ...preview };
  });
  if (stopped === null) {
    return;
  }
  await emitEvent({
    workSessionId: stopped.workSessionId,
    eventName: "preview.stopped",
    aggregateType: "preview_server",
    aggregateId: stopped.id,
    payload: { url: stopped.url, port: stopped.port, reason: "idle_timeout" },
    producer: { module: "preview-manager" },
  });
  logProcess("info", "preview.idle_stopped", {
    workSessionId: stopped.workSessionId,
    previewId: stopped.id,
    pid: candidate.pid,
    url: stopped.url,
  });
  parkIdleStoppedPreviewPort(stopped);
}

export async function sweepExpiredPreviewIdleStops(reason = "sweep"): Promise<void> {
  const snapshot = await getDatabaseSnapshot();
  const previewIds = snapshot.previewServers
    .filter((preview) =>
      preview.idleExpiresAt !== null &&
      preview.idleExpiresAt !== undefined &&
      new Date(preview.idleExpiresAt).getTime() <= Date.now() &&
      preview.status !== "stopped" &&
      preview.status !== "unavailable"
    )
    .map((preview) => preview.id);
  if (previewIds.length === 0) {
    return;
  }
  logProcess("info", "preview.idle_sweep.start", { reason, previewCount: previewIds.length });
  for (const previewId of previewIds) {
    await expirePreviewIfStillIdle(previewId);
  }
}

export async function clearPreviewIdleStopForWorkSession(workSessionId: Identifier, reason = "active"): Promise<void> {
  const previewIds = await mutateDatabase((db) => {
    const matches = db.previewServers.filter((preview) => preview.workSessionId === workSessionId && preview.idleExpiresAt !== null && preview.idleExpiresAt !== undefined);
    for (const preview of matches) {
      preview.idleExpiresAt = null;
    }
    return matches.map((preview) => preview.id);
  });
  for (const previewId of previewIds) {
    clearIdleTimer(previewId);
  }
  if (previewIds.length > 0) {
    logProcess("info", "preview.idle_cleared", { workSessionId, reason, previewCount: previewIds.length });
  }
}

export async function armPreviewIdleStopForWorkSession(workSessionId: Identifier, reason = "completed"): Promise<void> {
  const timeoutMs = getConfig().previewIdleTimeoutMs;
  if (timeoutMs <= 0) {
    await clearPreviewIdleStopForWorkSession(workSessionId, "idle-disabled");
    return;
  }
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
  const previewIds = await mutateDatabase((db) => {
    const workSession = db.workSessions.find((entry) => entry.id === workSessionId);
    if (workSession === undefined || !isIdleTerminalState(workSession.currentState)) {
      return [];
    }
    const previews = db.previewServers.filter((preview) =>
      preview.workSessionId === workSessionId &&
      preview.pid !== null &&
      (preview.status === "ready" || preview.status === "starting")
    );
    for (const preview of previews) {
      preview.idleExpiresAt = expiresAt;
    }
    return previews.map((preview) => preview.id);
  });
  for (const previewId of previewIds) {
    scheduleIdleTimer(previewId, expiresAt);
  }
  if (previewIds.length > 0) {
    logProcess("info", "preview.idle_armed", { workSessionId, reason, previewCount: previewIds.length, expiresAt });
  }
}

async function reconcileStalePreviewRecords(): Promise<void> {
  const now = currentTimestamp();
  const config = getConfig();
  const listeners = await listeningPidsByPort(config.previewPortStart, config.previewPortEnd);
  const stalePorts = await mutateDatabase((db) => {
    const ports = new Set<number>();
    for (const preview of db.previewServers) {
      if (preview.status === "stopped" || preview.status === "unavailable") {
        if (preview.port > 0) {
          ports.add(preview.port);
        }
        continue;
      }
      if (preview.pid === null || !isProcessAlive(preview.pid)) {
        preview.status = "stopped";
        preview.stoppedAt = preview.stoppedAt ?? now;
        preview.pid = null;
        preview.idleExpiresAt = null;
        preview.stoppedReason = preview.stoppedReason ?? "process_exit";
        if (preview.port > 0) {
          ports.add(preview.port);
        }
      }
    }
    const activePorts = new Set(db.previewServers
      .filter((preview) => preview.port > 0 && preview.pid !== null && (preview.status === "ready" || preview.status === "starting"))
      .map((preview) => preview.port));
    return [...ports].filter((port) => !activePorts.has(port));
  });
  for (const port of stalePorts) {
    for (const pid of listeners.get(port) ?? []) {
      await stopProcessForPreview(`stale-port-${port}`, pid, null);
    }
  }
}

async function stopProcessForPreview(previewId: Identifier, pid?: number | null, port?: number | null): Promise<void> {
  async function killProcessTree(targetPid: number): Promise<void> {
    try {
      if (process.platform === "win32") {
        await runProcess({
          command: "taskkill.exe",
          args: ["/PID", String(targetPid), "/T", "/F"],
          cwd: process.cwd(),
          timeoutMs: 10000,
          env: createSanitizedProcessEnv(),
        });
      } else {
        try {
          process.kill(-targetPid, "SIGTERM");
        } catch {
          process.kill(targetPid, "SIGTERM");
        }
        setTimeout(() => {
          try {
            process.kill(-targetPid, "SIGKILL");
          } catch {
            try {
              process.kill(targetPid, "SIGKILL");
            } catch {
            }
          }
        }, 2000);
      }
    } catch {
    }
  }

  const child = liveProcesses.get(previewId);
  if (child !== undefined) {
    liveProcesses.delete(previewId);
    if (child.pid !== undefined) {
      await killProcessTree(child.pid);
    } else {
      child.kill();
    }
  }

  if (pid !== undefined && pid !== null) {
    await killProcessTree(pid);
  }
  if (port !== undefined && port !== null && port > 0) {
    for (const ownerPid of await listeningPidsForPort(port)) {
      await killProcessTree(ownerPid);
    }
  }
}

export async function stopPreview(previewId: Identifier, reason: PreviewStoppedReason = "manual"): Promise<PreviewServerRecord> {
  clearIdleTimer(previewId);
  const preview = await mutateDatabase((db) => {
    const record = db.previewServers.find((candidate) => candidate.id === previewId);
    if (record === undefined) {
      throw new Error("Preview server was not found.");
    }
    return { ...record };
  });

  await stopProcessForPreview(previewId, preview.pid, preview.port);
  const stopped = await mutateDatabase((db) => {
    const record = db.previewServers.find((candidate) => candidate.id === previewId);
    if (record === undefined) {
      throw new Error("Preview server was not found.");
    }
    record.status = "stopped";
    record.stoppedAt = currentTimestamp();
    record.pid = null;
    record.idleExpiresAt = null;
    record.stoppedReason = reason;
    return { ...record };
  });

  await emitEvent({
    workSessionId: stopped.workSessionId,
    eventName: "preview.stopped",
    aggregateType: "preview_server",
    aggregateId: stopped.id,
    payload: { url: stopped.url, port: stopped.port, reason },
    producer: { module: "preview-manager" },
  });

  return stopped;
}

export async function stopPreviewsForWorkSession(workSessionId: Identifier): Promise<void> {
  const previews = await mutateDatabase((db) => db.previewServers.filter((preview) => preview.workSessionId === workSessionId && preview.status !== "stopped"));
  for (const preview of previews) {
    await stopPreview(preview.id, "restart");
  }
}

async function latestReusablePreview(workSessionId: Identifier): Promise<PreviewServerRecord | null> {
  return mutateDatabase((db) => {
    const previews = db.previewServers
      .filter((preview) => preview.workSessionId === workSessionId && (preview.status === "ready" || preview.status === "starting"))
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
    return previews[0] === undefined ? null : { ...previews[0] };
  });
}

function commandFingerprint(command: PreviewCommand): string {
  return [
    command.appType,
    command.renderedCommand,
    command.packageManager ?? "none",
    command.serverReloadMode,
  ].join("|");
}

function previewUrlWithRevision(url: string, revision: number): string {
  const parsed = new URL(url);
  parsed.searchParams.set("__cdl_preview_revision", String(revision));
  return parsed.toString();
}

function previewBaseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete("__cdl_preview_revision");
  parsed.hash = "";
  return parsed.toString();
}

function modeCanReuse(mode: PreviewServerReloadMode | undefined): boolean {
  return mode === "hmr" || mode === "watcher" || mode === "static";
}

function restartRequiredFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const basename = path.basename(normalized).toLowerCase();
  return (
    normalized === "package.json" ||
    /(^|\/)(package-lock|pnpm-lock|yarn\.lock|bun\.lockb?|npm-shrinkwrap)\b/i.test(normalized) ||
    /^\.env(\.|$)/i.test(basename) ||
    /^next\.config\.(js|mjs|cjs|ts)$/i.test(basename) ||
    /^vite\.config\.(js|mjs|cjs|ts)$/i.test(basename) ||
    /^astro\.config\.(js|mjs|cjs|ts)$/i.test(basename) ||
    /^svelte\.config\.(js|mjs|cjs|ts)$/i.test(basename) ||
    /^nuxt\.config\.(js|mjs|cjs|ts)$/i.test(basename)
  );
}

async function changedFilesSincePreview(preview: PreviewServerRecord): Promise<string[]> {
  const previewStartedAt = new Date(preview.startedAt).getTime();
  return mutateDatabase((db) => {
    const runIds = new Set(
      db.agentRuns
        .filter((run) => run.workSessionId === preview.workSessionId && new Date(run.startedAt).getTime() >= previewStartedAt)
        .map((run) => run.id)
    );
    return Array.from(new Set(
      db.codeChanges
        .filter((change) => runIds.has(change.agentRunId))
        .map((change) => change.filePath)
        .filter((filePath) => filePath.trim().length > 0)
    ));
  });
}

async function previewNeedsHardRestart(preview: PreviewServerRecord): Promise<{ required: boolean; reason: string | null; changedFiles: string[] }> {
  const changedFiles = await changedFilesSincePreview(preview);
  if (changedFiles.length === 0) {
    return { required: false, reason: null, changedFiles };
  }
  if (preview.serverReloadMode === "plain_process" || preview.serverReloadMode === "rerun") {
    return {
      required: true,
      reason: `${preview.serverReloadMode} preview cannot safely apply code changes without a new process.`,
      changedFiles,
    };
  }
  const restartFile = changedFiles.find(restartRequiredFile);
  if (restartFile !== undefined) {
    return {
      required: true,
      reason: `${restartFile} changed, so the preview server must restart.`,
      changedFiles,
    };
  }
  return { required: false, reason: null, changedFiles };
}

async function reusablePreviewForWorkSession(
  workSession: WorkSessionRecord,
  config: ReturnType<typeof getConfig>
): Promise<{ preview: PreviewServerRecord; command: PreviewCommand; healthPaths: string[]; changedFiles: string[] } | null> {
  const candidate = await latestReusablePreview(workSession.id);
  if (candidate === null || candidate.status !== "ready" || candidate.pid === null || !isProcessAlive(candidate.pid)) {
    return null;
  }
  if (candidate.workspacePath !== workSession.activeWorktreePath || candidate.port <= 0) {
    return null;
  }
  const command = await detectPreviewCommand(workSession.activeWorktreePath, candidate.port, config.previewHost);
  const fingerprint = commandFingerprint(command);
  const candidateFingerprint = candidate.commandFingerprint ?? (candidate.command === command.renderedCommand ? fingerprint : "");
  if (!command.previewable || candidate.appType !== command.appType || candidateFingerprint !== fingerprint) {
    return null;
  }
  if (command.serverReloadMode === "rerun") {
    return null;
  }
  if (!modeCanReuse(command.serverReloadMode)) {
    const restart = await previewNeedsHardRestart(candidate);
    if (restart.required || restart.changedFiles.length > 0) {
      logProcess("info", "preview.reuse.rejected", {
        workSessionId: workSession.id,
        previewId: candidate.id,
        serverReloadMode: command.serverReloadMode,
        reason: restart.reason ?? "Preview command is not watcher-backed.",
        changedFiles: restart.changedFiles.slice(0, 20),
      });
      return null;
    }
  }
  const restart = await previewNeedsHardRestart(candidate);
  if (restart.required) {
    logProcess("info", "preview.reuse.rejected", {
      workSessionId: workSession.id,
      previewId: candidate.id,
      serverReloadMode: command.serverReloadMode,
      reason: restart.reason,
      changedFiles: restart.changedFiles.slice(0, 20),
    });
    return null;
  }
  const healthPaths = await healthPathsForPreview(workSession.activeWorktreePath, command.appType);
  return { preview: candidate, command, healthPaths, changedFiles: restart.changedFiles };
}

async function refreshExistingPreview(input: {
  workSession: WorkSessionRecord;
  preview: PreviewServerRecord;
  command: PreviewCommand;
  healthPaths: string[];
  mode: "probe" | "final";
  policy: PreviewRestartPolicy;
  signal?: AbortSignal;
}): Promise<PreviewServerRecord | null> {
  const baseUrl = previewBaseUrl(input.preview.url);
  logProcess("info", "preview.refresh.healthcheck.start", {
    workSessionId: input.workSession.id,
    previewId: input.preview.id,
    mode: input.mode,
    policy: input.policy,
    url: baseUrl,
    healthPaths: input.healthPaths,
    serverReloadMode: input.command.serverReloadMode,
  });
  const health = await waitForHealth(
    baseUrl,
    input.healthPaths,
    12000,
    input.signal,
    input.preview.pid === null ? undefined : () => isProcessAlive(input.preview.pid ?? 0),
    input.command.appType !== "static-html",
  );
  const refreshed = await mutateDatabase((db) => {
    const record = db.previewServers.find((candidate) => candidate.id === input.preview.id);
    if (record === undefined) {
      throw new Error("Preview server disappeared while refreshing.");
    }
    record.lastHealthCheckAt = currentTimestamp();
    record.lastValidatedAt = record.lastHealthCheckAt;
    record.restartPolicy = input.policy;
    record.serverReloadMode = input.command.serverReloadMode;
    record.commandFingerprint = commandFingerprint(input.command);
    if (input.mode === "final") {
      record.mode = "final";
    }
    if (health.healthy) {
      const nextRevision = (record.refreshRevision ?? 0) + 1;
      record.refreshRevision = nextRevision;
      record.status = "ready";
      record.url = previewUrlWithRevision(baseUrl, nextRevision);
      record.idleExpiresAt = null;
      record.stoppedReason = null;
      record.lastFailureReason = null;
    } else {
      record.status = "failed";
      record.stoppedAt = currentTimestamp();
      record.idleExpiresAt = null;
      record.stoppedReason = health.failureReason === "process_exit" ? "process_exit" : "health_failed";
      record.lastFailureReason = previewHealthFailureMessage("Refreshed preview", health);
    }
    return { ...record };
  });

  await emitEvent({
    workSessionId: input.workSession.id,
    eventName: health.healthy ? "preview.ready" : "preview.failed",
    aggregateType: "preview_server",
    aggregateId: input.preview.id,
    payload: health.healthy
      ? {
          url: refreshed.url,
          port: refreshed.port,
          appType: refreshed.appType,
          healthPaths: input.healthPaths,
          mode: input.mode,
          policy: input.policy,
          reused: "true",
          serverReloadMode: input.command.serverReloadMode,
          refreshRevision: String(refreshed.refreshRevision ?? 0),
        }
      : {
          url: refreshed.url,
          port: refreshed.port,
          appType: refreshed.appType,
          healthPaths: input.healthPaths,
          mode: input.mode,
          policy: input.policy,
          failedPath: health.failedPath ?? "/",
          command: refreshed.command,
          stdoutTail: refreshed.stdoutTail,
          stderrTail: refreshed.stderrTail,
          reason: input.mode === "probe" && (input.workSession.previewFirstServableAt ?? null) === null
            ? "App is not yet servable; the background health probe will keep watching as tasks build it. (Expected mid-plan; not a failure of the run.)"
            : previewHealthFailureMessage("Refreshed preview", health),
          expectedMidPlan: input.mode === "probe" && (input.workSession.previewFirstServableAt ?? null) === null ? "true" : "false",
        },
    producer: { module: "preview-manager" },
  });

  logProcess(health.healthy ? "info" : "warn", health.healthy ? "preview.refreshed" : "preview.refresh.failed", {
    workSessionId: input.workSession.id,
    previewId: input.preview.id,
    mode: input.mode,
    policy: input.policy,
    status: refreshed.status,
    url: refreshed.url,
    appType: refreshed.appType,
    serverReloadMode: input.command.serverReloadMode,
    failedPath: health.failedPath,
  });
  if (!health.healthy) {
    await stopProcessForPreview(input.preview.id, input.preview.pid, input.preview.port);
    await mutateDatabase((db) => {
      const record = db.previewServers.find((candidate) => candidate.id === input.preview.id);
      if (record !== undefined) {
        record.pid = null;
        record.idleExpiresAt = null;
        record.stoppedReason = health.failureReason === "process_exit" ? "process_exit" : "health_failed";
      }
    });
  }
  return health.healthy ? refreshed : null;
}

export async function startPreviewForWorkSession(workSession: WorkSessionRecord, options: StartPreviewOptions = {}): Promise<PreviewServerRecord> {
  await assertSafeWorkspace(workSession.activeWorktreePath, { operation: "preview startup" });
  const mode = options.mode ?? "final";
  const policy = options.policy ?? (mode === "probe" ? "refresh_existing_or_start" : "hard_restart");
  const operation = registerWorkSessionOperation({
    workSessionId: workSession.id,
    kind: "preview",
    label: mode === "probe" ? "Probe preview startup" : policy === "hard_restart" ? "Hard preview restart" : "Preview refresh",
  });
  try {
    return await traced({
      name: "preview.start",
      attributes: {
        workSessionId: workSession.id,
        projectId: workSession.projectId,
        mode,
        policy,
        workspacePath: workSession.activeWorktreePath,
      },
      run: async (span) => {
        const preview = await startPreviewForWorkSessionInternal(workSession, {
          mode,
          policy,
          signal: combinedAbortSignal([options.signal, operation.signal]),
        });
        const capabilities = stackCapabilities(preview.appType);
        await span.end({
          attributes: {
            previewId: preview.id,
            appType: preview.appType,
            status: preview.status,
            previewSurface: capabilities.previewSurface,
            supportsPythonRunParams: capabilities.supportsPythonRunParams,
            supportsRRunParams: capabilities.supportsRRunParams ?? false,
            serverReloadMode: preview.serverReloadMode ?? null,
          },
        });
        return preview;
      },
    });
  } finally {
    operation.unregister();
  }
}

function mlExperimentNonPreviewableCommand(): PreviewCommand {
  return {
    appType: "python-ml",
    command: "",
    args: [],
    renderedCommand: "ML experiment workspace — training and inference run in the ML workbench, not a headless preview.",
    packageManager: null,
    needsDependencyInstall: false,
    previewable: false,
    serverReloadMode: "static",
  };
}

async function startPreviewForWorkSessionInternal(workSession: WorkSessionRecord, options: StartPreviewOptions): Promise<PreviewServerRecord> {
  throwIfAborted(options.signal);
  const mode = options.mode ?? "final";
  const policy = options.policy ?? (mode === "probe" ? "refresh_existing_or_start" : "hard_restart");
  logProcess("info", "preview.start.requested", {
    workSessionId: workSession.id,
    projectId: workSession.projectId,
    mode,
    policy,
    workspacePath: workSession.activeWorktreePath,
  });
  const config = getConfig();
  await sweepExpiredPreviewIdleStops("preview-start");
  await clearPreviewIdleStopForWorkSession(workSession.id, "preview-start");
  releaseParkedPortsForWorkSession(workSession.id, "preview-start");
  await reconcileStalePreviewRecords();
  throwIfAborted(options.signal);
  if (policy !== "hard_restart") {
    const reusable = await reusablePreviewForWorkSession(workSession, config);
    if (reusable !== null) {
      const refreshed = await refreshExistingPreview({
        workSession,
        preview: reusable.preview,
        command: reusable.command,
        healthPaths: reusable.healthPaths,
        mode,
        policy,
        signal: options.signal,
      });
      if (refreshed !== null) {
        return refreshed;
      }
      logProcess("warn", "preview.refresh.fallback_to_hard_restart", {
        workSessionId: workSession.id,
        previewId: reusable.preview.id,
        mode,
        policy,
      });
    }
  }

  logProcess("info", "preview.stop_existing.start", { workSessionId: workSession.id, mode });
  await stopPreviewsForWorkSession(workSession.id);
  throwIfAborted(options.signal);
  logProcess("info", "preview.stop_existing.completed", { workSessionId: workSession.id, mode });

  const port = await allocatePort(config.previewHost, config.previewPortStart, config.previewPortEnd);
  const url = `http://${config.previewHost}:${port}`;
  const previewCommand =
    config.mlPipelineEnabled && workSession.stackDecision?.stack === "python-ml"
      ? mlExperimentNonPreviewableCommand()
      : await detectPreviewCommand(workSession.activeWorktreePath, port, config.previewHost);
  logProcess("info", "preview.command.detected", {
    workSessionId: workSession.id,
    mode,
    policy,
    appType: previewCommand.appType,
    command: previewCommand.renderedCommand,
    previewable: previewCommand.previewable,
    needsDependencyInstall: previewCommand.needsDependencyInstall,
    serverReloadMode: previewCommand.serverReloadMode,
    url,
  });
  if (!previewCommand.previewable) {
    const preview = await mutateDatabase((db) => {
      const record = createPreviewServerRecord({
        workSessionId: workSession.id,
        projectId: workSession.projectId,
        workspacePath: workSession.activeWorktreePath,
        appType: previewCommand.appType,
        command: previewCommand.renderedCommand,
        port: 0,
        url: "",
        pid: null,
        status: "unavailable",
        stdoutTail: "",
        stderrTail: "",
        restartPolicy: policy,
        serverReloadMode: previewCommand.serverReloadMode,
        commandFingerprint: commandFingerprint(previewCommand),
        refreshRevision: 0,
        lastValidatedAt: null,
        stoppedReason: "unavailable",
        mode,
      });
      db.previewServers.push(record);
      return record;
    });

    await emitEvent({
      workSessionId: workSession.id,
      eventName: "preview.stopped",
      aggregateType: "preview_server",
      aggregateId: preview.id,
      payload: { appType: preview.appType, reason: previewCommand.renderedCommand, mode, policy },
      producer: { module: "preview-manager" },
    });

    return preview;
  }

  logProcess("info", "preview.dependencies.install.start", {
    workSessionId: workSession.id,
    mode,
    policy,
    packageManager: previewCommand.packageManager,
    needsDependencyInstall: previewCommand.needsDependencyInstall,
  });
  const installOutput = await installDependenciesIfNeeded(workSession.activeWorktreePath, previewCommand, options.signal);
  const pythonInstallOutput = await installPythonDependenciesIfNeeded(workSession.activeWorktreePath, previewCommand, options.signal);
  const rInstallOutput = await installRDependenciesIfNeeded(workSession.activeWorktreePath, previewCommand, options.signal);
  const pythonWebPrepareOutput = await preparePythonWebPreviewIfNeeded(workSession.activeWorktreePath, previewCommand, options.signal);
  const phpPrepareOutput = await preparePhpPreviewIfNeeded(workSession.activeWorktreePath, previewCommand, options.signal);
  const javaPrepareOutput = await prepareJavaPreviewIfNeeded(workSession.activeWorktreePath, previewCommand, options.signal);
  logProcess("info", "preview.dependencies.install.completed", {
    workSessionId: workSession.id,
    mode,
    stdoutBytes: installOutput.stdout.length + pythonInstallOutput.stdout.length + rInstallOutput.stdout.length + pythonWebPrepareOutput.stdout.length + phpPrepareOutput.stdout.length + javaPrepareOutput.stdout.length,
    stderrBytes: installOutput.stderr.length + pythonInstallOutput.stderr.length + rInstallOutput.stderr.length + pythonWebPrepareOutput.stderr.length + phpPrepareOutput.stderr.length + javaPrepareOutput.stderr.length,
  });
  if (pythonWebPrepareOutput.stdout.length > 0 || pythonWebPrepareOutput.stderr.length > 0) {
    logProcess("info", "preview.python.web.prepare.completed", {
      workSessionId: workSession.id,
      mode,
      appType: previewCommand.appType,
      stdoutBytes: pythonWebPrepareOutput.stdout.length,
      stderrBytes: pythonWebPrepareOutput.stderr.length,
    });
  }
  if (javaPrepareOutput.stdout.length > 0 || javaPrepareOutput.stderr.length > 0 || previewCommand.appType === "java") {
    logProcess("info", "preview.java.prepare.completed", {
      workSessionId: workSession.id,
      mode,
      mainClass: previewCommand.javaMainClass ?? null,
      sourceFiles: previewCommand.javaSourceFiles?.length ?? 0,
      stdoutBytes: javaPrepareOutput.stdout.length,
      stderrBytes: javaPrepareOutput.stderr.length,
    });
  }
  if (phpPrepareOutput.stdout.length > 0 || phpPrepareOutput.stderr.length > 0 || previewCommand.appType === "php") {
    logProcess("info", "preview.php.prepare.completed", {
      workSessionId: workSession.id,
      mode,
      stdoutBytes: phpPrepareOutput.stdout.length,
      stderrBytes: phpPrepareOutput.stderr.length,
    });
  }
  const pythonEntrypoint = previewCommand.appType === "python-script"
    ? await resolvePythonEntrypoint(workSession.activeWorktreePath, workSession.pythonRunParams, previewCommand.pythonScriptPath)
    : null;
  const pythonRunOutput = pythonEntrypoint !== null
    ? await preparePythonScriptPreview(workSession.activeWorktreePath, config.shellTimeoutMs, pythonEntrypoint, workSession.pythonRunParams, options.signal)
    : { stdout: "", stderr: "" };
  if (pythonEntrypoint !== null) {
    logProcess("info", "preview.python.prepare.completed", {
      workSessionId: workSession.id,
      mode,
      pythonEntrypoint,
      stdoutBytes: pythonRunOutput.stdout.length,
      stderrBytes: pythonRunOutput.stderr.length,
    });
  }
  const rEntrypoint = previewCommand.appType === "r-script"
    ? await resolveREntrypoint(workSession.activeWorktreePath, workSession.rRunParams, previewCommand.rScriptPath)
    : null;
  const rRunOutput = rEntrypoint !== null
    ? await prepareRScriptPreview(workSession.activeWorktreePath, config.shellTimeoutMs, rEntrypoint, workSession.rRunParams, options.signal)
    : { stdout: "", stderr: "" };
  if (rEntrypoint !== null) {
    logProcess("info", "preview.r.prepare.completed", {
      workSessionId: workSession.id,
      mode,
      rEntrypoint,
      stdoutBytes: rRunOutput.stdout.length,
      stderrBytes: rRunOutput.stderr.length,
    });
  }

  const preview = await mutateDatabase((db) => {
    const record = createPreviewServerRecord({
      workSessionId: workSession.id,
      projectId: workSession.projectId,
      workspacePath: workSession.activeWorktreePath,
      appType: previewCommand.appType,
        command: previewCommand.renderedCommand,
        port,
        url,
        pid: null,
        status: "starting",
        stdoutTail: appendTail(appendTail(appendTail(appendTail(appendTail(appendTail(installOutput.stdout, pythonInstallOutput.stdout), rInstallOutput.stdout), pythonWebPrepareOutput.stdout), phpPrepareOutput.stdout), javaPrepareOutput.stdout), pythonRunOutput.stdout + rRunOutput.stdout),
        stderrTail: appendTail(appendTail(appendTail(appendTail(appendTail(appendTail(installOutput.stderr, pythonInstallOutput.stderr), rInstallOutput.stderr), pythonWebPrepareOutput.stderr), phpPrepareOutput.stderr), javaPrepareOutput.stderr), pythonRunOutput.stderr + rRunOutput.stderr),
        restartPolicy: policy,
        serverReloadMode: previewCommand.serverReloadMode,
        commandFingerprint: commandFingerprint(previewCommand),
      refreshRevision: 0,
      lastValidatedAt: null,
      mode,
    });
    db.previewServers.push(record);
    return record;
  });

  await emitEvent({
    workSessionId: workSession.id,
    eventName: "preview.starting",
    aggregateType: "preview_server",
    aggregateId: preview.id,
    payload: { url, appType: preview.appType, command: preview.command, mode, policy, serverReloadMode: previewCommand.serverReloadMode },
    producer: { module: "preview-manager" },
  });
  throwIfAborted(options.signal);

  const spawnTarget = createSpawnTarget(previewCommand.command, previewCommand.args);
  logProcess("info", "preview.process.spawn.start", {
    workSessionId: workSession.id,
    previewId: preview.id,
    mode,
    command: spawnTarget.command,
    args: spawnTarget.args,
    cwd: workSession.activeWorktreePath,
    url,
  });
  const child = spawn(spawnTarget.command, spawnTarget.args, {
    cwd: workSession.activeWorktreePath,
    env: createSanitizedProcessEnv({
      HOST: config.previewHost,
      PORT: String(port),
      ...(previewCommand.appType === "php" ? {
        APP_URL: url,
        SESSION_DRIVER: "file",
      } : {}),
      ...(previewCommand.appType.startsWith("r-") ? {
        R_LIBS_USER: rLibraryDir(workSession.activeWorktreePath),
      } : {}),
      FLASK_RUN_PORT: String(port),
      FLASK_RUN_HOST: config.previewHost,
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_ROLL_FORWARD: "Major",
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    }) as NodeJS.ProcessEnv,
    shell: false,
    detached: process.platform !== "win32",
    windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
    windowsHide: true,
  });

  liveProcesses.set(preview.id, child);
  let spawnErrorMessage: string | null = null;
  const onAbort = (): void => {
    void stopProcessForPreview(preview.id, child.pid ?? null, preview.port).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  logProcess("info", "preview.process.spawn.completed", {
    workSessionId: workSession.id,
    previewId: preview.id,
    mode,
    pid: child.pid ?? null,
    url,
  });

  await mutateDatabase((db) => {
    const record = db.previewServers.find((candidate) => candidate.id === preview.id);
    if (record !== undefined) {
      record.pid = child.pid ?? null;
    }
  });

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    void mutateDatabase((db) => {
      const record = db.previewServers.find((candidate) => candidate.id === preview.id);
      if (record !== undefined) {
        record.stdoutTail = appendTail(record.stdoutTail, text);
      }
    });
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    void mutateDatabase((db) => {
      const record = db.previewServers.find((candidate) => candidate.id === preview.id);
      if (record !== undefined) {
        record.stderrTail = appendTail(record.stderrTail, text);
      }
    });
  });

  child.on("error", (error) => {
    spawnErrorMessage = error.message;
    logProcess("error", "preview.process.spawn.error", {
      workSessionId: workSession.id,
      previewId: preview.id,
      mode,
      message: error.message,
    });
    liveProcesses.delete(preview.id);
    void mutateDatabase((db) => {
      const record = db.previewServers.find((candidate) => candidate.id === preview.id);
      if (record !== undefined) {
        record.status = "failed";
        record.stoppedAt = currentTimestamp();
        record.pid = null;
        record.idleExpiresAt = null;
        record.stoppedReason = "process_exit";
        record.lastFailureReason = `Preview process spawn failed: ${error.message}`;
        record.stderrTail = appendTail(record.stderrTail, `\nPreview process spawn failed: ${error.message}`);
      }
    });
  });

  child.on("exit", (code, signal) => {
    logProcess("warn", "preview.process.exited", {
      workSessionId: workSession.id,
      previewId: preview.id,
      mode,
      code: code ?? null,
      signal: signal ?? null,
    });
    liveProcesses.delete(preview.id);
    void mutateDatabase((db) => {
      const record = db.previewServers.find((candidate) => candidate.id === preview.id);
      if (record !== undefined && (record.status === "starting" || record.status === "ready")) {
        const failureMessage = record.status === "ready"
          ? `Preview process exited while running (code ${code ?? "null"}, signal ${signal ?? "null"}).`
          : `Preview process exited before becoming ready (code ${code ?? "null"}, signal ${signal ?? "null"}).`;
        record.status = "failed";
        record.stoppedAt = currentTimestamp();
        record.pid = null;
        record.idleExpiresAt = null;
        record.stoppedReason = record.stoppedReason ?? "process_exit";
        record.lastFailureReason = record.lastFailureReason ?? failureMessage;
      }
    });
  });

  const healthPaths = await healthPathsForPreview(workSession.activeWorktreePath, previewCommand.appType);
  logProcess("info", "preview.healthcheck.start", {
    workSessionId: workSession.id,
    previewId: preview.id,
    mode,
    url,
    healthPaths,
  });
  let health: PreviewHealthResult;
  try {
    health = await waitForHealth(
      url,
      healthPaths,
      12000,
      options.signal,
      () => spawnErrorMessage === null && child.exitCode === null && child.signalCode === null,
      previewCommand.appType !== "static-html",
    );
  } catch (error) {
    options.signal?.removeEventListener("abort", onAbort);
    await stopProcessForPreview(preview.id, child.pid ?? null, preview.port);
    await mutateDatabase((db) => {
      const record = db.previewServers.find((candidate) => candidate.id === preview.id);
      if (record !== undefined) {
        record.status = "stopped";
        record.stoppedAt = currentTimestamp();
        record.pid = null;
        record.idleExpiresAt = null;
        record.stoppedReason = "aborted";
      }
    });
    throw error;
  }
  options.signal?.removeEventListener("abort", onAbort);
  const failureDiagnostics = !health.healthy && previewCommand.appType === "php"
    ? await phpPreviewDiagnostics(workSession.activeWorktreePath)
    : "";
  const healthy = health.healthy;
  const listenerPids = healthy ? await listeningPidsForPort(port) : [];
  const servingPid = listenerPids[0] ?? child.pid ?? null;
  const completed = await mutateDatabase((db) => {
    const record = db.previewServers.find((candidate) => candidate.id === preview.id);
    if (record === undefined) {
      throw new Error("Preview server disappeared while starting.");
    }
    record.status = healthy ? "ready" : "failed";
    record.lastHealthCheckAt = currentTimestamp();
    record.lastValidatedAt = record.lastHealthCheckAt;
    record.restartPolicy = policy;
    record.serverReloadMode = previewCommand.serverReloadMode;
    record.commandFingerprint = commandFingerprint(previewCommand);
    record.pid = servingPid;
    if (failureDiagnostics.length > 0) {
      record.stderrTail = appendTail(record.stderrTail, failureDiagnostics);
    }
    if (!healthy) {
      record.stoppedAt = currentTimestamp();
      record.idleExpiresAt = null;
      record.stoppedReason = health.failureReason === "process_exit" ? "process_exit" : "health_failed";
      record.lastFailureReason = previewHealthFailureMessage("Preview", health);
    } else {
      record.idleExpiresAt = null;
      record.stoppedReason = null;
      record.lastFailureReason = null;
    }
    return { ...record };
  });

  const expectedMidPlanFailure = !healthy && mode === "probe" && (workSession.previewFirstServableAt ?? null) === null;
  await emitEvent({
    workSessionId: workSession.id,
    eventName: healthy ? "preview.ready" : "preview.failed",
    aggregateType: "preview_server",
    aggregateId: preview.id,
    payload: healthy
      ? { url, port, appType: completed.appType, healthPaths, mode, policy, serverReloadMode: previewCommand.serverReloadMode, reused: "false" }
      : {
          url,
          port,
          appType: completed.appType,
          healthPaths,
          mode,
          policy,
          serverReloadMode: previewCommand.serverReloadMode,
          failedPath: health.failedPath ?? "/",
          command: completed.command,
          stdoutTail: completed.stdoutTail,
          stderrTail: completed.stderrTail,
          reason: expectedMidPlanFailure
            ? "App is not yet servable; the background health probe will keep watching as tasks build it. (Expected mid-plan; not a failure of the run.)"
            : previewHealthFailureMessage("Preview", health),
          expectedMidPlan: expectedMidPlanFailure ? "true" : "false",
        },
    producer: { module: "preview-manager" },
  });
  logProcess(healthy ? "info" : "error", healthy ? "preview.ready" : "preview.failed", {
    workSessionId: workSession.id,
    previewId: preview.id,
    mode,
    url,
    appType: completed.appType,
    healthPaths,
    failedPath: health.failedPath,
    stdoutBytes: completed.stdoutTail.length,
    stderrBytes: completed.stderrTail.length,
  });

  if (!healthy) {
    await stopProcessForPreview(preview.id, child.pid ?? null, preview.port);
    await mutateDatabase((db) => {
      const record = db.previewServers.find((candidate) => candidate.id === preview.id);
      if (record !== undefined) {
        record.pid = null;
      }
    });
  }

  return completed;
}
