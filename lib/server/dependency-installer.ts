import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { saveArtifact } from "@/lib/server/artifacts";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { ensurePythonWorkspaceEnvironment, pythonWorkspaceEnv } from "@/lib/server/runtime/python-environment";
import { workspaceVenvDir } from "@/lib/server/runtime/python-venv-path";
import { ensureRLibraryDir, parseRDescriptionPackages, rInstallExpression, rWorkspaceEnv } from "@/lib/server/runtime/r-environment";
import { resolveRscriptCommand } from "@/lib/server/runtime/r-resolver";
import { resolvePackageManagerCommand, type PackageManagerName } from "@/lib/server/runtime/package-manager-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";
import { analyzeRequirements } from "@/lib/server/ml/ml-installer";
import { readExperimentManifest } from "@/lib/server/ml/experiment-manifest";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import type { TaskRecord, WorkSessionRecord } from "@/lib/shared/types";

export interface DependencyInstallResult {
  handled: boolean;
  status: "completed" | "failed";
  packages: string[];
  command: string;
  summary: string;
  rawOutput: string;
  manifestOnly: boolean;
}

interface DependencyPlan {
  dependencies: string[];
  devDependencies: string[];
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
}

interface PackageResolution {
  requested: string;
  resolved: string;
}

const packageSpecPattern = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._~^*<>=-]+)?$/;
const fileLikePattern = /\.(?:c?js|m?js|jsx|tsx?|json|css|html|md|py|txt|ya?ml)$/i;
const ignoredCandidates = new Set([
  "a",
  "add",
  "an",
  "and",
  "as",
  "declare",
  "dependencies",
  "dependency",
  "dev",
  "devdependencies",
  "development",
  "for",
  "if",
  "install",
  "libraries",
  "library",
  "lockfile",
  "npm",
  "or",
  "package",
  "packages",
  "production",
  "project",
  "required",
  "requires",
  "resolve",
  "runtime",
  "build",
  "lint",
  "start",
  "test",
  "typecheck",
  "the",
  "to",
  "typescript",
  "using",
  "version",
  "with",
]);

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(workspacePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path.join(workspacePath, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function metadataList(task: TaskRecord, key: string): string[] {
  const value = task.metadata[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function metadataText(task: TaskRecord, key: string): string {
  const value = task.metadata[key];
  return typeof value === "string" ? value : "";
}

function dependencyNames(value: unknown): Set<string> {
  if (typeof value !== "object" || value === null) {
    return new Set();
  }
  return new Set(Object.keys(value));
}

function dependencyVersionMap(packageJson: Record<string, unknown>): Map<string, string> {
  const entries = new Map<string, string>();
  for (const group of [packageJson.dependencies, packageJson.devDependencies]) {
    if (typeof group !== "object" || group === null) {
      continue;
    }
    for (const [name, version] of Object.entries(group)) {
      if (typeof version === "string") {
        entries.set(name, version);
      }
    }
  }
  return entries;
}

function normalizePackageSpec(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/[.,;:)]+$/g, "");
  const lower = cleaned.toLowerCase();
  if (ignoredCandidates.has(lower) || fileLikePattern.test(cleaned) || !packageSpecPattern.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function packageNameFromSpec(packageSpec: string): string {
  const scoped = packageSpec.match(/^(@[^/]+\/[^@]+)(?:@.+)?$/);
  if (scoped !== null) {
    return scoped[1];
  }
  return packageSpec.split("@")[0];
}

function packageSpecHasVersion(packageSpec: string): boolean {
  return packageSpec !== packageNameFromSpec(packageSpec);
}

function packageNameFromImportSpecifier(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.length === 0) {
    return null;
  }
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope !== undefined && name !== undefined ? `${scope}/${name}` : null;
  }
  return specifier.split("/")[0] ?? null;
}

function addPackage(target: Set<string>, value: string): void {
  const normalized = normalizePackageSpec(value);
  if (normalized !== null) {
    target.add(normalized);
  }
}

function isRepairTask(task: TaskRecord): boolean {
  return typeof task.metadata.repairForVerificationRunId === "string";
}

function isPackageManifestOnlyTask(task: TaskRecord): boolean {
  const targetFiles = metadataList(task, "targetFiles").map((file) => file.replace(/\\/g, "/"));
  return targetFiles.includes("package.json") && targetFiles.every((file) =>
    file === "package.json" || file.endsWith("package-lock.json") || file.endsWith("pnpm-lock.yaml") || file.endsWith("yarn.lock")
  );
}

function lineExplicitlyRequestsDependencyChange(line: string): boolean {
  return /\b(npm\s+install|pnpm\s+add|yarn\s+add|bun\s+add|install\s+(?:the\s+)?(?:package|dependency|library)|add\s+(?:the\s+)?(?:package|dependency|library)|declare\s+(?:the\s+)?(?:package|dependency|dependencies|devdependencies)|new\s+(?:package|dependency|dependencies|library))\b/i.test(line);
}

function lineRequestsDevDependency(line: string, packageSpec: string): boolean {
  return packageNameFromSpec(packageSpec).startsWith("@types/") || /\b(dev|development|devdependencies|typings?|types)\b/i.test(line);
}

function addToPlan(plan: DependencyPlan, line: string, packageSpec: string): void {
  if (lineRequestsDevDependency(line, packageSpec)) {
    plan.devDependencies.push(packageSpec);
  } else {
    plan.dependencies.push(packageSpec);
  }
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function candidateTokens(value: string): string[] {
  return value
    .replace(/[`'",]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !token.startsWith("-"));
}

function addCommandPackages(packages: Set<string>, commandText: string): void {
  const match = commandText.trim().match(/^(?:npm\s+install|pnpm\s+add|yarn\s+add|bun\s+add)\s+(.+)$/i);
  if (match === null) {
    return;
  }

  for (const token of candidateTokens(match[1] ?? "")) {
    if (token.startsWith("-")) {
      continue;
    }
    addPackage(packages, token);
  }
}

function addQuotedPackages(packages: Set<string>, line: string): void {
  if (!lineExplicitlyRequestsDependencyChange(line)) {
    return;
  }
  for (const match of line.matchAll(/[`'"]([^`'"]+)[`'"]/g)) {
    const value = match[1] ?? "";
    addCommandPackages(packages, value);
    addPackage(packages, value);
  }
}

function addImportSpecifierPackages(packages: Set<string>, line: string): void {
  for (const match of line.matchAll(/\bfrom\s+["'`]([^"'`]+)["'`]/gi)) {
    const packageName = packageNameFromImportSpecifier(match[1] ?? "");
    if (packageName !== null) {
      addPackage(packages, packageName);
    }
  }
}

function extractDependencyPlan(task: TaskRecord): DependencyPlan {
  if (isRepairTask(task)) {
    return { dependencies: [], devDependencies: [] };
  }

  const targetFiles = metadataList(task, "targetFiles");
  const targetsPackageManifest = targetFiles.some((file) => file.replace(/\\/g, "/") === "package.json");
  if (!targetsPackageManifest) {
    return { dependencies: [], devDependencies: [] };
  }

  const lines = [
    task.title,
    task.description,
    metadataText(task, "objective"),
    ...metadataList(task, "expectedChanges"),
    ...task.acceptanceCriteria,
  ].filter((line) => {
    if (/package\.json does not define script/i.test(line)) {
      return false;
    }
    return lineExplicitlyRequestsDependencyChange(line) || (isPackageManifestOnlyTask(task) && /\bfrom\s+["'`][^"'`]+["'`]/i.test(line));
  });

  const plan: DependencyPlan = { dependencies: [], devDependencies: [] };
  for (const line of lines) {
    const packages = new Set<string>();
    addQuotedPackages(packages, line);
    addImportSpecifierPackages(packages, line);
    addCommandPackages(packages, line);

    for (const packageSpec of packages) {
      addToPlan(plan, line, packageSpec);
    }
  }

  return {
    dependencies: unique(plan.dependencies),
    devDependencies: unique(plan.devDependencies),
  };
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

function installArgs(packageManager: "npm" | "pnpm" | "yarn" | "bun", packages: string[], dev: boolean): string[] {
  if (packageManager === "npm") {
    return ["install", ...(dev ? ["--save-dev"] : []), ...packages, "--no-audit", "--no-fund"];
  }
  if (packageManager === "pnpm") {
    return ["add", ...(dev ? ["-D"] : []), ...packages];
  }
  if (packageManager === "yarn") {
    return ["add", ...(dev ? ["-D"] : []), ...packages];
  }
  return ["add", ...(dev ? ["-d"] : []), ...packages];
}

function renderedCommand(packageManager: "npm" | "pnpm" | "yarn" | "bun", args: string[]): string {
  return `${packageManager} ${args.join(" ")}`;
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z-.]+)?/);
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  };
}

function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease ? -1 : 1;
}

function satisfiesComparator(version: ParsedVersion, comparator: string): boolean {
  const trimmed = comparator.trim();
  if (trimmed.length === 0 || trimmed === "*" || trimmed.toLowerCase() === "x") {
    return true;
  }

  const operatorMatch = trimmed.match(/^(>=|>|<=|<|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?)/);
  if (operatorMatch === null) {
    return true;
  }

  const operator = operatorMatch[1] ?? "=";
  const target = parseVersion(operatorMatch[2]);
  if (target === null) {
    return true;
  }

  const comparison = compareVersions(version, target);
  if (operator === ">=") return comparison >= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === "<") return comparison < 0;
  return comparison === 0;
}

function satisfiesCaret(version: ParsedVersion, range: string): boolean {
  const target = parseVersion(range);
  if (target === null || compareVersions(version, target) < 0) {
    return false;
  }
  if (target.major > 0) {
    return version.major === target.major;
  }
  if (target.minor > 0) {
    return version.major === 0 && version.minor === target.minor;
  }
  return version.major === 0 && version.minor === 0 && version.patch === target.patch;
}

function satisfiesTilde(version: ParsedVersion, range: string): boolean {
  const target = parseVersion(range);
  if (target === null || compareVersions(version, target) < 0) {
    return false;
  }
  return version.major === target.major && version.minor === target.minor;
}

function versionSatisfiesRange(versionValue: string, range: string): boolean {
  const version = parseVersion(versionValue);
  if (version === null) {
    return true;
  }

  return range.split("||").some((alternative) => {
    const trimmed = alternative.trim();
    if (trimmed.length === 0 || trimmed === "*" || trimmed.toLowerCase() === "x") {
      return true;
    }
    if (trimmed.startsWith("^")) {
      return satisfiesCaret(version, trimmed.slice(1));
    }
    if (trimmed.startsWith("~")) {
      return satisfiesTilde(version, trimmed.slice(1));
    }
    return trimmed.split(/\s+/).every((comparator) => satisfiesComparator(version, comparator));
  });
}

function peerDependenciesAreCompatible(peerDependencies: Record<string, unknown> | null, rootDependencies: Map<string, string>): boolean {
  if (peerDependencies === null) {
    return true;
  }
  for (const [name, range] of Object.entries(peerDependencies)) {
    const rootVersion = rootDependencies.get(name);
    if (rootVersion !== undefined && typeof range === "string" && !versionSatisfiesRange(rootVersion, range)) {
      return false;
    }
  }
  return true;
}

async function npmViewJson(input: { workspacePath: string; args: string[]; timeoutMs: number }): Promise<unknown | null> {
  const result = await runProcess({
    command: await packageManagerCommand("npm"),
    args: ["view", ...input.args, "--json"],
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    env: createSanitizedProcessEnv({
      CI: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    }),
  });
  if (result.exitCode !== 0 || result.timedOut || result.stdout.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function peerDependenciesFor(input: { workspacePath: string; packageSpec: string; timeoutMs: number }): Promise<Record<string, unknown> | null> {
  return jsonRecord(await npmViewJson({
    workspacePath: input.workspacePath,
    args: [input.packageSpec, "peerDependencies"],
    timeoutMs: input.timeoutMs,
  }));
}

async function packageVersions(input: { workspacePath: string; packageName: string; timeoutMs: number }): Promise<string[]> {
  const value = await npmViewJson({
    workspacePath: input.workspacePath,
    args: [input.packageName, "versions"],
    timeoutMs: input.timeoutMs,
  });
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && parseVersion(entry) !== null)
    .sort((a, b) => {
      const parsedA = parseVersion(a);
      const parsedB = parseVersion(b);
      if (parsedA === null || parsedB === null) {
        return 0;
      }
      return compareVersions(parsedB, parsedA);
    });
}

async function filterToPublishedPackages(input: {
  workspacePath: string;
  packages: string[];
  timeoutMs: number;
}): Promise<{ kept: string[]; dropped: string[] }> {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const packageSpec of input.packages) {
    const versions = await packageVersions({
      workspacePath: input.workspacePath,
      packageName: packageNameFromSpec(packageSpec),
      timeoutMs: input.timeoutMs,
    });
    if (versions.length > 0) {
      kept.push(packageSpec);
    } else {
      dropped.push(packageSpec);
    }
  }
  return { kept, dropped };
}

async function resolveCompatiblePackageSpec(input: {
  workspacePath: string;
  packageJson: Record<string, unknown>;
  packageSpec: string;
  timeoutMs: number;
}): Promise<PackageResolution> {
  const packageName = packageNameFromSpec(input.packageSpec);
  const rootDependencies = dependencyVersionMap(input.packageJson);
  const requestedVersion = packageSpecHasVersion(input.packageSpec) ? input.packageSpec.slice(packageName.length + 1) : null;
  const requestedVersionIsRange = requestedVersion !== null && /[\^~<>|*x\s]/i.test(requestedVersion);
  let peerLookupSpec = packageSpecHasVersion(input.packageSpec) ? input.packageSpec : `${packageName}@latest`;
  if (requestedVersionIsRange) {
    const versions = await packageVersions({ workspacePath: input.workspacePath, packageName, timeoutMs: input.timeoutMs });
    const concrete = versions.find((version) => parseVersion(version)?.prerelease !== true && versionSatisfiesRange(version, requestedVersion));
    peerLookupSpec = concrete !== undefined ? `${packageName}@${concrete}` : `${packageName}@latest`;
  }
  const requestedPeerDependencies = await peerDependenciesFor({
    workspacePath: input.workspacePath,
    packageSpec: peerLookupSpec,
    timeoutMs: input.timeoutMs,
  });
  if (peerDependenciesAreCompatible(requestedPeerDependencies, rootDependencies)) {
    return { requested: input.packageSpec, resolved: requestedVersionIsRange ? peerLookupSpec : input.packageSpec };
  }

  const versions = await packageVersions({
    workspacePath: input.workspacePath,
    packageName,
    timeoutMs: input.timeoutMs,
  });
  for (const version of versions) {
    const parsed = parseVersion(version);
    if (parsed?.prerelease) {
      continue;
    }
    const packagePeerDependencies = await peerDependenciesFor({
      workspacePath: input.workspacePath,
      packageSpec: `${packageName}@${version}`,
      timeoutMs: input.timeoutMs,
    });
    if (peerDependenciesAreCompatible(packagePeerDependencies, rootDependencies)) {
      return { requested: input.packageSpec, resolved: `${packageName}@${version}` };
    }
  }

  return { requested: input.packageSpec, resolved: requestedVersionIsRange ? peerLookupSpec : input.packageSpec };
}

async function resolveCompatiblePackageSpecs(input: {
  workspacePath: string;
  packageJson: Record<string, unknown>;
  packages: string[];
  timeoutMs: number;
}): Promise<PackageResolution[]> {
  const resolved: PackageResolution[] = [];
  for (const packageSpec of input.packages) {
    resolved.push(await resolveCompatiblePackageSpec({
      workspacePath: input.workspacePath,
      packageJson: input.packageJson,
      packageSpec,
      timeoutMs: input.timeoutMs,
    }));
  }
  return resolved;
}

function resolvedPackageSpecs(resolutions: PackageResolution[]): string[] {
  return resolutions.map((resolution) => resolution.resolved);
}

function changedResolutionLines(resolutions: PackageResolution[]): string[] {
  return resolutions
    .filter((resolution) => resolution.requested !== resolution.resolved)
    .map((resolution) => `${resolution.requested} -> ${resolution.resolved}`);
}

async function installPackageBatch(input: {
  workspacePath: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  packages: string[];
  dev: boolean;
  timeoutMs: number;
}): Promise<{ command: string; failed: boolean; output: string }> {
  const args = installArgs(input.packageManager, input.packages, input.dev);
  const command = renderedCommand(input.packageManager, args);
  const result = await runProcess({
    command: await packageManagerCommand(input.packageManager),
    args,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    env: createSanitizedProcessEnv({
      CI: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    }),
  });

  return {
    command,
    failed: result.exitCode !== 0 || result.timedOut,
    output: `$ ${command}
exit=${result.exitCode === null ? "null" : String(result.exitCode)} timedOut=${result.timedOut ? "true" : "false"}

STDOUT:
${result.stdout}

STDERR:
${result.stderr}
`,
  };
}

export interface ManifestSyncResult {
  attempted: boolean;
  status: "completed" | "failed" | "skipped";
  command: string;
  summary: string;
}

function manifestDependencyHash(packageJson: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({
    dependencies: packageJson.dependencies ?? {},
    devDependencies: packageJson.devDependencies ?? {},
    optionalDependencies: packageJson.optionalDependencies ?? {},
    packageManager: packageJson.packageManager ?? "",
  })).digest("hex").slice(0, 32);
}

const manifestSyncMarkerFile = ".closed-loop-manifest-hash";

export async function syncWorkspaceManifestDependencies(input: {
  workSession: WorkSessionRecord;
  taskId: string;
}): Promise<ManifestSyncResult> {
  await assertSafeWorkspace(input.workSession.activeWorktreePath, { operation: "dependency installation" });
  const results = [
    await syncNodeManifestDependencies(input),
    await syncPythonManifestDependencies(input),
    await syncRManifestDependencies(input),
  ];
  const attempted = results.filter((result) => result.attempted);
  if (attempted.length === 0) {
    return {
      attempted: false,
      status: "skipped",
      command: "",
      summary: results.map((result) => result.summary).join(" "),
    };
  }
  return {
    attempted: true,
    status: attempted.some((result) => result.status === "failed") ? "failed" : "completed",
    command: attempted.map((result) => result.command).filter((command) => command !== "").join(" && "),
    summary: attempted.map((result) => result.summary).join(" "),
  };
}

async function syncNodeManifestDependencies(input: {
  workSession: WorkSessionRecord;
  taskId: string;
}): Promise<ManifestSyncResult> {
  const workspacePath = input.workSession.activeWorktreePath;
  const packageJson = await readPackageJson(workspacePath);
  if (packageJson === null) {
    return { attempted: false, status: "skipped", command: "", summary: "No package.json to sync." };
  }
  const declaredCount = dependencyNames(packageJson.dependencies).size + dependencyNames(packageJson.devDependencies).size;
  if (declaredCount === 0) {
    return { attempted: false, status: "skipped", command: "", summary: "Manifest declares no dependencies." };
  }
  const hash = manifestDependencyHash(packageJson);
  const markerPath = path.join(workspacePath, "node_modules", manifestSyncMarkerFile);
  try {
    if ((await readFile(markerPath, "utf8")).trim() === hash) {
      return { attempted: false, status: "skipped", command: "", summary: "Workspace dependencies already in sync." };
    }
  } catch {
  }
  const config = getConfig();
  const packageManager = await detectPackageManager(workspacePath);
  const args = packageManager === "npm"
    ? ["install", "--no-audit", "--no-fund"]
    : packageManager === "pnpm"
      ? ["install", "--no-frozen-lockfile"]
      : ["install"];
  const command = renderedCommand(packageManager, args);
  const result = await runProcess({
    command: await packageManagerCommand(packageManager),
    args,
    cwd: workspacePath,
    timeoutMs: Math.max(config.shellTimeoutMs, 180000),
    env: createSanitizedProcessEnv({
      CI: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    }),
  });
  const failed = result.exitCode !== 0 || result.timedOut;
  if (!failed) {
    try {
      await writeFile(markerPath, hash, "utf8");
    } catch {
    }
  }
  await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `dependency-sync-${input.taskId}.txt`,
    content: `$ ${command}\nexit=${result.exitCode === null ? "null" : String(result.exitCode)} timedOut=${result.timedOut ? "true" : "false"}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n`,
    metadata: { taskId: input.taskId, command, status: failed ? "failed" : "completed", mode: "manifest_sync" },
  });
  return {
    attempted: true,
    status: failed ? "failed" : "completed",
    command,
    summary: failed
      ? `Workspace dependency sync failed (${command}); the executor may lack node_modules until the verification-gate install.`
      : `Workspace dependencies installed (${command}) so the executor can run fast self-checks against its own changes.`,
  };
}

function pythonRequirementsHash(requirementsSource: string): string {
  const meaningfulLines = requirementsSource
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  return createHash("sha256").update(meaningfulLines.join("\n")).digest("hex").slice(0, 32);
}

async function syncPythonManifestDependencies(input: {
  workSession: WorkSessionRecord;
  taskId: string;
}): Promise<ManifestSyncResult> {
  const workspacePath = input.workSession.activeWorktreePath;
  let requirementsSource: string;
  try {
    requirementsSource = await readFile(path.join(workspacePath, "requirements.txt"), "utf8");
  } catch {
    return { attempted: false, status: "skipped", command: "", summary: "No requirements.txt to sync." };
  }
  const hash = pythonRequirementsHash(requirementsSource);
  if (hash === pythonRequirementsHash("")) {
    return { attempted: false, status: "skipped", command: "", summary: "requirements.txt declares no dependencies." };
  }
  const markerPath = path.join(workspaceVenvDir(workspacePath), manifestSyncMarkerFile);
  try {
    if ((await readFile(markerPath, "utf8")).trim() === hash) {
      return { attempted: false, status: "skipped", command: "", summary: "Python workspace dependencies already in sync." };
    }
  } catch {
  }
  const config = getConfig();
  if (config.mlPipelineEnabled && analyzeRequirements(requirementsSource).torchRequested) {
    const manifest = await readExperimentManifest(workspacePath);
    if (manifest !== null) {
      return {
        attempted: false,
        status: "skipped",
        command: "",
        summary: "ML workspace (torch + experiment manifest): torch dependencies are deferred to the governed experiment-runtime / verification-gate installer.",
      };
    }
  }
  const timeoutMs = Math.max(config.shellTimeoutMs, 180000);
  const command = "python -m pip install -r requirements.txt";
  const python = await ensurePythonWorkspaceEnvironment({
    workspacePath,
    timeoutMs,
    env: createSanitizedProcessEnv({ CI: "true" }),
  });
  const outputs: string[] = [];
  if (python.setupResult !== null) {
    outputs.push(`$ ${python.setupCommand ?? "python -m venv .venv"}\nexit=${python.setupResult.exitCode === null ? "null" : String(python.setupResult.exitCode)} timedOut=${python.setupResult.timedOut ? "true" : "false"}\n\nSTDOUT:\n${python.setupResult.stdout}\n\nSTDERR:\n${python.setupResult.stderr}\n`);
  }
  const setupFailed = python.setupResult !== null && (python.setupResult.exitCode !== 0 || python.setupResult.timedOut);
  let failed = setupFailed;
  if (!setupFailed) {
    const result = await runProcess({
      command: python.command,
      args: ["-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "-r", "requirements.txt"],
      cwd: workspacePath,
      timeoutMs,
      env: pythonWorkspaceEnv(workspacePath, { CI: "true" }),
    });
    outputs.push(`$ ${command}\nexit=${result.exitCode === null ? "null" : String(result.exitCode)} timedOut=${result.timedOut ? "true" : "false"}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n`);
    failed = result.exitCode !== 0 || result.timedOut;
    if (!failed) {
      try {
        await writeFile(markerPath, hash, "utf8");
      } catch {
      }
    }
  }
  await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `dependency-sync-python-${input.taskId}.txt`,
    content: outputs.join("\n---\n"),
    metadata: { taskId: input.taskId, command, status: failed ? "failed" : "completed", mode: "manifest_sync" },
  });
  return {
    attempted: true,
    status: failed ? "failed" : "completed",
    command,
    summary: failed
      ? `Python workspace dependency sync failed (${setupFailed ? "python -m venv .venv" : command}); the executor may lack a usable .venv until the verification-gate install.`
      : `Python workspace dependencies installed (${command}) so the executor can run framework self-checks (e.g. manage.py check) against its own changes.`,
  };
}

function rDescriptionHash(packages: string[]): string {
  return createHash("sha256").update([...packages].sort().join("\n")).digest("hex").slice(0, 32);
}

async function syncRManifestDependencies(input: {
  workSession: WorkSessionRecord;
  taskId: string;
}): Promise<ManifestSyncResult> {
  const workspacePath = input.workSession.activeWorktreePath;
  let descriptionSource: string;
  try {
    descriptionSource = await readFile(path.join(workspacePath, "DESCRIPTION"), "utf8");
  } catch {
    return { attempted: false, status: "skipped", command: "", summary: "No DESCRIPTION to sync." };
  }
  const packages = parseRDescriptionPackages(descriptionSource);
  if (packages.length === 0) {
    return { attempted: false, status: "skipped", command: "", summary: "DESCRIPTION declares no R package dependencies." };
  }
  const hash = rDescriptionHash(packages);
  const markerPath = path.join(workspacePath, ".rlib", manifestSyncMarkerFile);
  try {
    if ((await readFile(markerPath, "utf8")).trim() === hash) {
      return { attempted: false, status: "skipped", command: "", summary: "R workspace dependencies already in sync." };
    }
  } catch {
  }
  await ensureRLibraryDir(workspacePath);
  const config = getConfig();
  const timeoutMs = Math.max(config.shellTimeoutMs, 600000);
  const command = `Rscript -e 'install.packages(${JSON.stringify(packages)})'`;
  const rscript = await resolveRscriptCommand();
  const result = await runProcess({
    command: rscript.command,
    args: ["--vanilla", "-e", rInstallExpression(packages)],
    cwd: workspacePath,
    timeoutMs,
    env: rWorkspaceEnv(workspacePath, { CI: "true" }),
  });
  const failed = result.exitCode !== 0 || result.timedOut;
  if (!failed) {
    try {
      await writeFile(markerPath, hash, "utf8");
    } catch {
    }
  }
  await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `dependency-sync-r-${input.taskId}.txt`,
    content: `$ ${command}\nexit=${result.exitCode === null ? "null" : String(result.exitCode)} timedOut=${result.timedOut ? "true" : "false"}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}\n`,
    metadata: { taskId: input.taskId, command, status: failed ? "failed" : "completed", mode: "manifest_sync" },
  });
  return {
    attempted: true,
    status: failed ? "failed" : "completed",
    command,
    summary: failed
      ? "R workspace dependency sync failed (install.packages); the executor may lack installed CRAN packages until the preview/verification install."
      : "R workspace dependencies installed into .rlib so the executor and preview can load them.",
  };
}

export async function installDependenciesForTask(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
}): Promise<DependencyInstallResult> {
  await assertSafeWorkspace(input.workSession.activeWorktreePath, { operation: "dependency installation" });
  const packageJson = await readPackageJson(input.workSession.activeWorktreePath);
  if (packageJson === null) {
    return {
      handled: false,
      status: "completed",
      packages: [],
      command: "",
      summary: "No package.json was found for dependency installation.",
      rawOutput: "",
      manifestOnly: false,
    };
  }

  const requestedPlan = extractDependencyPlan(input.task);
  const requestedPackages = [...requestedPlan.dependencies, ...requestedPlan.devDependencies];
  if (requestedPackages.length === 0) {
    return {
      handled: false,
      status: "completed",
      packages: [],
      command: "",
      summary: "Task did not contain exact package specs for dependency installation.",
      rawOutput: "",
      manifestOnly: false,
    };
  }

  const config = getConfig();
  const installTimeoutMs = Math.max(config.shellTimeoutMs, 180000);
  const existingDependencies = new Set([
    ...dependencyNames(packageJson.dependencies),
    ...dependencyNames(packageJson.devDependencies),
  ]);
  const dedupedDependencies = requestedPlan.dependencies.filter((packageSpec) => !existingDependencies.has(packageNameFromSpec(packageSpec)));
  const dedupedDevDependencies = requestedPlan.devDependencies.filter((packageSpec) => !existingDependencies.has(packageNameFromSpec(packageSpec)));

  const dependencyFilter = await filterToPublishedPackages({
    workspacePath: input.workSession.activeWorktreePath,
    packages: dedupedDependencies,
    timeoutMs: installTimeoutMs,
  });
  const devDependencyFilter = await filterToPublishedPackages({
    workspacePath: input.workSession.activeWorktreePath,
    packages: dedupedDevDependencies,
    timeoutMs: installTimeoutMs,
  });
  const dependencies = dependencyFilter.kept;
  const devDependencies = devDependencyFilter.kept;
  const droppedPackages = [...dependencyFilter.dropped, ...devDependencyFilter.dropped];
  const packages = [...dependencies, ...devDependencies];

  if (packages.length === 0) {
    const summary = droppedPackages.length > 0
      ? `No installable packages: dropped ${droppedPackages.length} candidate(s) the registry does not publish (${droppedPackages.join(", ")}).`
      : `Dependency task already satisfied: ${requestedPackages.join(", ")}.`;
    await saveArtifact({
      workSessionId: input.workSession.id,
      kind: "log",
      fileName: `dependency-install-${input.task.id}.txt`,
      content: summary,
      metadata: {
        taskId: input.task.id,
        packages: requestedPackages.join(","),
        skipped: droppedPackages.length > 0 ? "unpublished-candidates" : "already-declared",
        droppedPackages: droppedPackages.join(","),
      },
    });
    return {
      handled: true,
      status: "completed",
      packages: requestedPackages,
      command: "",
      summary,
      rawOutput: summary,
      manifestOnly: isPackageManifestOnlyTask(input.task),
    };
  }

  const packageManager = await detectPackageManager(input.workSession.activeWorktreePath);
  const dependencyResolutions = await resolveCompatiblePackageSpecs({
    workspacePath: input.workSession.activeWorktreePath,
    packageJson,
    packages: dependencies,
    timeoutMs: installTimeoutMs,
  });
  const devDependencyResolutions = await resolveCompatiblePackageSpecs({
    workspacePath: input.workSession.activeWorktreePath,
    packageJson,
    packages: devDependencies,
    timeoutMs: installTimeoutMs,
  });
  const resolvedDependencies = resolvedPackageSpecs(dependencyResolutions);
  const resolvedDevDependencies = resolvedPackageSpecs(devDependencyResolutions);
  const resolvedPackages = [...resolvedDependencies, ...resolvedDevDependencies];
  const changedResolutions = [
    ...changedResolutionLines(dependencyResolutions),
    ...changedResolutionLines(devDependencyResolutions),
  ];
  const commands: string[] = [];
  const outputs: string[] = [];
  let failed = false;

  for (const batch of [
    { packages: resolvedDependencies, dev: false },
    { packages: resolvedDevDependencies, dev: true },
  ]) {
    if (batch.packages.length === 0 || failed) {
      continue;
    }
    const result = await installPackageBatch({
      workspacePath: input.workSession.activeWorktreePath,
      packageManager,
      packages: batch.packages,
      dev: batch.dev,
      timeoutMs: installTimeoutMs,
    });
    commands.push(result.command);
    outputs.push(result.output);
    failed = result.failed;
  }

  const resolutionOutput = `Dependency resolution
Requested runtime dependencies: ${dependencies.length > 0 ? dependencies.join(", ") : "none"}
Resolved runtime dependencies: ${resolvedDependencies.length > 0 ? resolvedDependencies.join(", ") : "none"}
Requested dev dependencies: ${devDependencies.length > 0 ? devDependencies.join(", ") : "none"}
Resolved dev dependencies: ${resolvedDevDependencies.length > 0 ? resolvedDevDependencies.join(", ") : "none"}${changedResolutions.length > 0 ? `\nPeer-compatible substitutions:\n${changedResolutions.map((line) => `- ${line}`).join("\n")}` : ""}${droppedPackages.length > 0 ? `\nDropped (not published on the registry): ${droppedPackages.join(", ")}` : ""}
`;
  const rawOutput = [resolutionOutput, ...outputs].join("\n---\n");
  const command = commands.join(" && ");
  const resolutionSummary = changedResolutions.length > 0
    ? ` Peer-compatible substitutions: ${changedResolutions.join(", ")}.`
    : "";
  const summary = failed
    ? `Dependency install failed for ${resolvedPackages.join(", ")}.${resolutionSummary}`
    : `Installed dependencies: ${resolvedPackages.join(", ")}.${resolutionSummary}`;

  await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "log",
    fileName: `dependency-install-${input.task.id}.txt`,
    content: rawOutput,
    metadata: {
      taskId: input.task.id,
      packages: resolvedPackages.join(","),
      requestedPackages: packages.join(","),
      resolvedPackages: resolvedPackages.join(","),
      substitutions: changedResolutions.join(","),
      command,
      status: failed ? "failed" : "completed",
    },
  });

  return {
    handled: true,
    status: failed ? "failed" : "completed",
    packages: resolvedPackages,
    command,
    summary,
    rawOutput,
    manifestOnly: isPackageManifestOnlyTask(input.task),
  };
}
