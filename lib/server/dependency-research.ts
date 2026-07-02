import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { saveArtifact } from "@/lib/server/artifacts";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolvePackageManagerCommand } from "@/lib/server/runtime/package-manager-resolver";
import { resolvePythonCommand } from "@/lib/server/runtime/python-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";
import { eslintFlatConfigFiles, nextEslintConfig } from "@/lib/server/next-eslint-config";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import { classifyProductIntent } from "@/lib/shared/request-intent";
import type { PlanRecord, TaskRecord, WorkSessionRecord } from "@/lib/shared/types";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: boolean;
}

interface NpmPackageResearch {
  packageName: string;
  declaredVersion: string | null;
  requestedSpec: string;
  latestVersion: string | null;
  chosenSpec: string | null;
  status: "kept" | "chosen" | "unresolved";
  note: string;
}

interface PythonPackageResearch {
  packageName: string;
  declaredSpec: string | null;
  requestedSpec: string;
  latestVersion: string | null;
  chosenSpec: string | null;
  status: "kept" | "chosen" | "unresolved";
  note: string;
  lineIndex?: number;
  replacementLine?: string;
}

export interface DependencyResearchResult {
  status: "completed";
  summary: string;
  report: string;
  npmPackages: NpmPackageResearch[];
  pythonPackages: PythonPackageResearch[];
  manifestUpdates: string[];
}

const packageSpecPattern = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._~^*<>=-]+)?$/;
const ignoredPackageCandidates = new Set([
  "add",
  "app",
  "build",
  "button",
  "cli",
  "code",
  "component",
  "config",
  "css",
  "dependency",
  "dev",
  "file",
  "framework",
  "install",
  "javascript",
  "library",
  "lint",
  "main",
  "module",
  "node",
  "package",
  "react",
  "route",
  "script",
  "server",
  "style",
  "test",
  "tsx",
  "typecheck",
  "typescript",
  "ui",
  "version",
]);
const ignoredPythonPackageCandidates = new Set([
  "any",
  "app",
  "argparse",
  "asyncio",
  "code",
  "collections",
  "contextlib",
  "csv",
  "dataclasses",
  "datetime",
  "decimal",
  "functools",
  "glob",
  "hashlib",
  "http",
  "importlib",
  "inspect",
  "io",
  "itertools",
  "json",
  "logging",
  "math",
  "module",
  "modules",
  "multiprocessing",
  "os",
  "package",
  "packages",
  "pathlib",
  "pickle",
  "platform",
  "random",
  "re",
  "shutil",
  "sqlite3",
  "statistics",
  "string",
  "subprocess",
  "sys",
  "tempfile",
  "threading",
  "time",
  "traceback",
  "typing",
  "unittest",
  "urllib",
  "uuid",
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

async function writePackageJson(workspacePath: string, packageJson: Record<string, unknown>): Promise<void> {
  await writeFile(path.join(workspacePath, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

async function readTextIfExists(pathname: string): Promise<string | null> {
  try {
    return await readFile(pathname, "utf8");
  } catch {
    return null;
  }
}

function recordEntries(value: unknown): Array<[string, string]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

function mutableRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function packageNameFromSpec(packageSpec: string): string {
  const scoped = packageSpec.match(/^(@[^/]+\/[^@]+)(?:@.+)?$/);
  if (scoped !== null) {
    return scoped[1];
  }
  return packageSpec.split("@")[0] ?? packageSpec;
}

function packageSpecHasVersion(packageSpec: string): boolean {
  return packageSpec !== packageNameFromSpec(packageSpec);
}

function versionFromPackageSpec(packageSpec: string): string | null {
  const packageName = packageNameFromSpec(packageSpec);
  return packageSpec.startsWith(`${packageName}@`) ? packageSpec.slice(packageName.length + 1) : null;
}

function normalizePackageSpec(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/[.,;:)]+$/g, "");
  const lower = cleaned.toLowerCase();
  if (ignoredPackageCandidates.has(lower) || !packageSpecPattern.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function metadataList(task: TaskRecord, key: string): string[] {
  const value = task.metadata[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function metadataText(task: TaskRecord, key: string): string {
  const value = task.metadata[key];
  return typeof value === "string" ? value : "";
}

function lineRequestsDependencyContext(line: string): boolean {
  return /\b(npm\s+install|pnpm\s+add|yarn\s+add|bun\s+add|install|package|dependency|library|sdk|client|import|from)\b/i.test(line);
}

function collectPackageCandidatesFromText(text: string): string[] {
  const packages = new Set<string>();
  for (const match of text.matchAll(/\b(?:from|import)\s+["'`]([^"'`]+)["'`]/gi)) {
    const specifier = match[1] ?? "";
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0] ?? "";
      const normalized = normalizePackageSpec(packageName);
      if (normalized !== null) {
        packages.add(normalized);
      }
    }
  }
  for (const match of text.matchAll(/(?:npm\s+install|pnpm\s+add|yarn\s+add|bun\s+add)\s+([^\n]+)/gi)) {
    for (const token of (match[1] ?? "").split(/\s+/)) {
      if (!token.startsWith("-")) {
        const normalized = normalizePackageSpec(token);
        if (normalized !== null) {
          packages.add(normalized);
        }
      }
    }
  }
  for (const line of text.split(/\r?\n/).filter(lineRequestsDependencyContext)) {
    for (const match of line.matchAll(/[`'"]((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._~^*<>=-]+)?)["'`]/gi)) {
      const normalized = normalizePackageSpec(match[1] ?? "");
      if (normalized !== null) {
        packages.add(normalized);
      }
    }
  }
  return Array.from(packages);
}

function collectRequestedNpmPackages(plan: PlanRecord, tasks: TaskRecord[]): string[] {
  const packages = new Set<string>();
  const planText = [
    plan.title,
    plan.goal,
    ...plan.planJson.risks,
    ...plan.planJson.verificationCommands,
  ].join("\n");
  for (const candidate of collectPackageCandidatesFromText(planText)) {
    packages.add(candidate);
  }
  for (const task of tasks) {
    const taskText = [
      task.title,
      task.description,
      metadataText(task, "objective"),
      ...metadataList(task, "expectedChanges"),
      ...metadataList(task, "verificationHints"),
      ...task.acceptanceCriteria,
    ].filter(lineRequestsDependencyContext).join("\n");
    for (const candidate of collectPackageCandidatesFromText(taskText)) {
      packages.add(candidate);
    }
  }
  return Array.from(packages).sort();
}

function metadataTargets(task: TaskRecord): string[] {
  return metadataList(task, "targetFiles").map((file) => file.replace(/\\/g, "/"));
}

function planTargetsPackageJson(plan: PlanRecord, tasks: TaskRecord[]): boolean {
  const plannedTargets = plan.planJson.tasks
    .flatMap((task) => task.targetFiles ?? [])
    .map((file) => file.replace(/\\/g, "/"));
  const taskTargets = tasks.flatMap(metadataTargets);
  return [...plannedTargets, ...taskTargets].some((file) => file === "package.json");
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      output[key] = entry;
    }
  }
  return output;
}

function isWeakNodeCliPackageJson(packageJson: Record<string, unknown>): boolean {
  const dependencies = recordEntries(packageJson.dependencies);
  const devDependencies = recordEntries(packageJson.devDependencies);
  const scripts = stringMap(packageJson.scripts);
  return dependencies.length === 0 &&
    devDependencies.length === 0 &&
    scripts.start === "node src/index.js" &&
    scripts.typecheck === "node --check src/index.js";
}

function shouldCollectRequestedNpmPackages(input: {
  workSession: WorkSessionRecord;
  plan: PlanRecord;
  tasks: TaskRecord[];
  packageJson: Record<string, unknown> | null;
}): boolean {
  if (input.packageJson === null) {
    return false;
  }
  const productIntent = classifyProductIntent(input.workSession.lastUserMessage);
  if (
    productIntent.pythonMode !== "unknown" &&
    isWeakNodeCliPackageJson(input.packageJson) &&
    !planTargetsPackageJson(input.plan, input.tasks)
  ) {
    return false;
  }
  return true;
}

function normalizePythonPackageName(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/[.,;:)]+$/g, "");
  const packageName = cleaned.replace(/\[.*\]$/, "");
  const normalized = packageName.toLowerCase().replace(/_/g, "-");
  if (
    normalized.length === 0 ||
    ignoredPythonPackageCandidates.has(normalized) ||
    !/^[a-z0-9][a-z0-9.-]*$/.test(normalized)
  ) {
    return null;
  }
  return packageName;
}

function collectPythonPackageCandidatesFromText(text: string): string[] {
  const packages = new Set<string>();
  for (const match of text.matchAll(/(?:python\s+-m\s+pip|pip|pip3)\s+install\s+([^\n]+)/gi)) {
    for (const token of (match[1] ?? "").split(/\s+/)) {
      if (token.startsWith("-") || token.includes("://")) {
        continue;
      }
      const name = token.split(/[<>=!~;]/)[0] ?? "";
      const normalized = normalizePythonPackageName(name);
      if (normalized !== null) {
        packages.add(normalized);
      }
    }
  }
  for (const line of text.split(/\r?\n/).filter((entry) => /\b(python|requirements|pyproject|package|dependency|library)\b/i.test(entry))) {
    for (const match of line.matchAll(/[`'"]([A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_, .-]+\])?)[`'"]/g)) {
      const normalized = normalizePythonPackageName(match[1] ?? "");
      if (normalized !== null) {
        packages.add(normalized);
      }
    }
  }
  return Array.from(packages);
}

function collectRequestedPythonPackages(plan: PlanRecord, tasks: TaskRecord[]): string[] {
  const packages = new Set<string>();
  const planText = [
    plan.title,
    plan.goal,
    ...plan.planJson.risks,
    ...plan.planJson.verificationCommands,
  ].join("\n");
  for (const candidate of collectPythonPackageCandidatesFromText(planText)) {
    packages.add(candidate);
  }
  for (const task of tasks) {
    const taskText = [
      task.title,
      task.description,
      metadataText(task, "objective"),
      ...metadataList(task, "expectedChanges"),
      ...metadataList(task, "verificationHints"),
      ...task.acceptanceCriteria,
    ].filter((line) => /\b(pip|python|requirements|pyproject|package|dependency|library|use)\b/i.test(line)).join("\n");
    for (const candidate of collectPythonPackageCandidatesFromText(taskText)) {
      packages.add(candidate);
    }
  }
  return Array.from(packages).sort((a, b) => a.localeCompare(b));
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z-.]+)?/);
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
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
  const target = parseVersion(operatorMatch[2] ?? "");
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

function dependencyVersionMap(packageJson: Record<string, unknown>): Map<string, string> {
  const versions = new Map<string, string>();
  for (const [name, version] of [...recordEntries(packageJson.dependencies), ...recordEntries(packageJson.devDependencies)]) {
    versions.set(name, version);
  }
  return versions;
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

async function packageManagerCommand(packageManager: "npm"): Promise<string> {
  return (await resolvePackageManagerCommand(packageManager)).command;
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

async function npmLatestVersion(workspacePath: string, packageName: string, timeoutMs: number): Promise<string | null> {
  const value = await npmViewJson({ workspacePath, args: [packageName, "version"], timeoutMs });
  return typeof value === "string" ? value : null;
}

async function npmPeerDependencies(workspacePath: string, packageSpec: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return jsonRecord(await npmViewJson({ workspacePath, args: [packageSpec, "peerDependencies"], timeoutMs }));
}

async function npmDependencies(workspacePath: string, packageSpec: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return jsonRecord(await npmViewJson({ workspacePath, args: [packageSpec, "dependencies"], timeoutMs }));
}

export async function npmMaxSatisfyingVersion(workspacePath: string, packageName: string, range: string, timeoutMs: number): Promise<string | null> {
  return npmVersionForRange(workspacePath, packageName, range, timeoutMs);
}

async function npmVersionForRange(workspacePath: string, packageName: string, range: string, timeoutMs: number): Promise<string | null> {
  const versions = await npmVersions(workspacePath, packageName, timeoutMs);
  for (const version of versions) {
    if (parseVersion(version)?.prerelease) {
      continue;
    }
    if (versionSatisfiesRange(version, range)) {
      return version;
    }
  }
  return null;
}

async function npmVersions(workspacePath: string, packageName: string, timeoutMs: number): Promise<string[]> {
  const value = await npmViewJson({ workspacePath, args: [packageName, "versions"], timeoutMs });
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && parseVersion(entry) !== null)
    .sort((a, b) => {
      const parsedA = parseVersion(a);
      const parsedB = parseVersion(b);
      return parsedA === null || parsedB === null ? 0 : compareVersions(parsedB, parsedA);
    });
}

async function researchNpmPackage(input: {
  workspacePath: string;
  packageJson: Record<string, unknown>;
  packageSpec: string;
  declaredVersion: string | null;
  timeoutMs: number;
}): Promise<NpmPackageResearch> {
  const packageName = packageNameFromSpec(input.packageSpec);
  const rootDependencies = dependencyVersionMap(input.packageJson);
  const latestVersion = await npmLatestVersion(input.workspacePath, packageName, input.timeoutMs);
  if (latestVersion === null) {
    return {
      packageName,
      declaredVersion: input.declaredVersion,
      requestedSpec: input.packageSpec,
      latestVersion: null,
      chosenSpec: input.declaredVersion === null ? null : `${packageName}@${input.declaredVersion}`,
      status: "unresolved",
      note: "Registry lookup failed; keep existing declarations and avoid adding this package unless later dependency installation succeeds.",
    };
  }

  if (input.declaredVersion !== null) {
    return {
      packageName,
      declaredVersion: input.declaredVersion,
      requestedSpec: input.packageSpec,
      latestVersion,
      chosenSpec: `${packageName}@${latestVersion}`,
      status: latestVersion === input.declaredVersion ? "kept" : "chosen",
      note: latestVersion === input.declaredVersion
        ? "Already declared at the latest registry version."
        : "Declared version is behind npm latest; package.json will be updated before Codex starts coding.",
    };
  }

  const requestedSpec = packageSpecHasVersion(input.packageSpec) ? input.packageSpec : `${packageName}@latest`;
  const requestedPeers = await npmPeerDependencies(input.workspacePath, requestedSpec, input.timeoutMs);
  if (peerDependenciesAreCompatible(requestedPeers, rootDependencies)) {
    return {
      packageName,
      declaredVersion: null,
      requestedSpec: input.packageSpec,
      latestVersion,
      chosenSpec: packageSpecHasVersion(input.packageSpec) ? input.packageSpec : `${packageName}@latest`,
      status: "chosen",
      note: "Latest requested version is compatible with declared workspace peer dependencies.",
    };
  }

  const versions = await npmVersions(input.workspacePath, packageName, input.timeoutMs);
  for (const version of versions) {
    const parsed = parseVersion(version);
    if (parsed?.prerelease) {
      continue;
    }
    const peers = await npmPeerDependencies(input.workspacePath, `${packageName}@${version}`, input.timeoutMs);
    if (peerDependenciesAreCompatible(peers, rootDependencies)) {
      return {
        packageName,
        declaredVersion: null,
        requestedSpec: input.packageSpec,
        latestVersion,
        chosenSpec: `${packageName}@${version}`,
        status: "chosen",
        note: "Latest version has incompatible peer dependencies; chose the newest compatible stable version.",
      };
    }
  }

  return {
    packageName,
    declaredVersion: null,
    requestedSpec: input.packageSpec,
    latestVersion,
    chosenSpec: null,
    status: "unresolved",
    note: "No compatible stable version was found against declared workspace peer dependencies.",
  };
}

function chosenVersion(item: NpmPackageResearch): string | null {
  return item.chosenSpec === null ? null : versionFromPackageSpec(item.chosenSpec);
}

function rootVersionMapFromResearch(packageJson: Record<string, unknown>, packages: NpmPackageResearch[]): Map<string, string> {
  const versions = dependencyVersionMap(packageJson);
  for (const item of packages) {
    const version = chosenVersion(item);
    if (version !== null) {
      versions.set(item.packageName, version);
    }
  }
  return versions;
}

function addPeerConstraints(input: {
  constraints: Map<string, Set<string>>;
  peerDependencies: Record<string, unknown> | null;
  rootDependencies: Map<string, string>;
}): void {
  if (input.peerDependencies === null) {
    return;
  }
  for (const [name, range] of Object.entries(input.peerDependencies)) {
    if (typeof range !== "string" || !input.rootDependencies.has(name)) {
      continue;
    }
    const ranges = input.constraints.get(name) ?? new Set<string>();
    ranges.add(range);
    input.constraints.set(name, ranges);
  }
}

function versionSatisfiesAll(version: string, ranges: Iterable<string>): boolean {
  for (const range of ranges) {
    if (!versionSatisfiesRange(version, range)) {
      return false;
    }
  }
  return true;
}

async function newestVersionSatisfyingRanges(input: {
  workspacePath: string;
  packageName: string;
  ranges: Iterable<string>;
  timeoutMs: number;
}): Promise<string | null> {
  const versions = await npmVersions(input.workspacePath, input.packageName, input.timeoutMs);
  for (const version of versions) {
    if (parseVersion(version)?.prerelease) {
      continue;
    }
    if (versionSatisfiesAll(version, input.ranges)) {
      return version;
    }
  }
  return null;
}

async function peerConstraintsForDeclaredPackages(input: {
  workspacePath: string;
  packageJson: Record<string, unknown>;
  npmPackages: NpmPackageResearch[];
  timeoutMs: number;
}): Promise<Map<string, Set<string>>> {
  const rootDependencies = rootVersionMapFromResearch(input.packageJson, input.npmPackages);
  const constraints = new Map<string, Set<string>>();

  for (const item of input.npmPackages) {
    const version = chosenVersion(item);
    if (version === null) {
      continue;
    }
    const packageSpec = `${item.packageName}@${version}`;
    const peerDependencies = await npmPeerDependencies(input.workspacePath, packageSpec, input.timeoutMs);
    addPeerConstraints({ constraints, peerDependencies, rootDependencies });

    const dependencies = await npmDependencies(input.workspacePath, packageSpec, input.timeoutMs);
    for (const [dependencyName, dependencyRange] of Object.entries(dependencies ?? {})) {
      if (typeof dependencyRange !== "string") {
        continue;
      }
      if (!dependencyName.toLowerCase().includes("eslint")) {
        continue;
      }
      const dependencyVersion = await npmVersionForRange(input.workspacePath, dependencyName, dependencyRange, input.timeoutMs);
      if (dependencyVersion === null) {
        continue;
      }
      const dependencyPeers = await npmPeerDependencies(input.workspacePath, `${dependencyName}@${dependencyVersion}`, input.timeoutMs);
      addPeerConstraints({ constraints, peerDependencies: dependencyPeers, rootDependencies });
    }
  }

  return constraints;
}

async function enforceDeclaredNpmPeerCompatibility(input: {
  workspacePath: string;
  packageJson: Record<string, unknown>;
  npmPackages: NpmPackageResearch[];
  timeoutMs: number;
}): Promise<NpmPackageResearch[]> {
  const constraints = await peerConstraintsForDeclaredPackages(input);
  const nextPackages = input.npmPackages.map((item) => ({ ...item }));
  for (const item of nextPackages) {
    if (item.declaredVersion === null) {
      continue;
    }
    const ranges = constraints.get(item.packageName);
    const version = chosenVersion(item);
    if (ranges === undefined || version === null || versionSatisfiesAll(version, ranges)) {
      continue;
    }
    const compatibleVersion = await newestVersionSatisfyingRanges({
      workspacePath: input.workspacePath,
      packageName: item.packageName,
      ranges,
      timeoutMs: input.timeoutMs,
    });
    if (compatibleVersion === null) {
      item.status = "unresolved";
      item.chosenSpec = `${item.packageName}@${item.declaredVersion}`;
      item.note = `Latest version ${version} conflicts with discovered peer constraints (${Array.from(ranges).join(", ")}); no compatible registry version was found, so the existing declaration is kept.`;
      continue;
    }
    item.chosenSpec = `${item.packageName}@${compatibleVersion}`;
    item.status = compatibleVersion === item.declaredVersion ? "kept" : "chosen";
    item.note = compatibleVersion === item.latestVersion
      ? item.note
      : `Latest version ${version} conflicts with discovered peer constraints (${Array.from(ranges).join(", ")}); chose newest compatible version ${compatibleVersion}.`;
  }
  return nextPackages;
}

interface ParsedRequirement {
  lineIndex: number;
  name: string;
  packagePart: string;
  spec: string;
  versionPart: string;
  markerPart: string;
  commentPart: string;
  prefix: string;
}

function splitRequirementComment(rawLine: string): { requirementPart: string; commentPart: string } {
  const match = rawLine.match(/^(.*?)(\s+#.*)?$/);
  return {
    requirementPart: match?.[1]?.trimEnd() ?? rawLine.trimEnd(),
    commentPart: match?.[2] ?? "",
  };
}

function parseRequirements(content: string): ParsedRequirement[] {
  const requirements: ParsedRequirement[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const { requirementPart, commentPart } = splitRequirementComment(rawLine);
    const line = requirementPart.trim();
    if (line.length === 0 || line.startsWith("-") || line.includes("://")) {
      continue;
    }
    const match = requirementPart.match(/^(\s*)([A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_, .-]+\])?)(\s*.*)$/);
    if (match !== null) {
      const packagePart = match[2] ?? "";
      const markerSplit = (match[3] ?? "").split(/;(.*)/s);
      const versionPart = markerSplit[0]?.trim() ?? "";
      const markerPart = markerSplit[1] === undefined ? "" : `;${markerSplit[1]}`;
      const normalizedName = normalizePythonPackageName(packagePart);
      if (normalizedName !== null) {
        requirements.push({
          lineIndex: index,
          name: normalizedName,
          packagePart,
          spec: `${requirementPart.trim()}${commentPart}`,
          versionPart,
          markerPart,
          commentPart,
          prefix: match[1] ?? "",
        });
      }
    }
  }
  return requirements.filter((entry) => entry.name.length > 0);
}

function exactPythonVersionFromRequirement(requirement: ParsedRequirement): string | null {
  const match = requirement.versionPart.match(/^==\s*([A-Za-z0-9_.!+~-]+)$/);
  return match?.[1] ?? null;
}

function pythonRequirementReplacement(requirement: ParsedRequirement, latestVersion: string): string {
  return `${requirement.prefix}${requirement.packagePart}==${latestVersion}${requirement.markerPart}${requirement.commentPart}`;
}

async function pipIndexLatestVersion(input: { workspacePath: string; packageName: string; timeoutMs: number }): Promise<string | null> {
  const result = await runProcess({
    command: (await resolvePythonCommand(input.workspacePath)).command,
    args: ["-m", "pip", "index", "versions", input.packageName, "--disable-pip-version-check"],
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    env: createSanitizedProcessEnv({
      CI: "true",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
    }),
  });
  if (result.exitCode !== 0 || result.timedOut) {
    return null;
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const latestMatch = output.match(/\bLATEST:\s*([^\s]+)/i);
  if (latestMatch?.[1] !== undefined) {
    return latestMatch[1];
  }
  const headerMatch = output.match(/^[^(]+?\(([^)\s]+)\)/m);
  return headerMatch?.[1] ?? null;
}

async function pypiLatestVersion(packageName: string): Promise<string | null> {
  try {
    const response = await fetch(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as { info?: { version?: unknown } };
    return typeof data.info?.version === "string" ? data.info.version : null;
  } catch {
    return null;
  }
}

async function latestPythonPackageVersion(input: { workspacePath: string; packageName: string; timeoutMs: number }): Promise<string | null> {
  return await pipIndexLatestVersion(input) ?? await pypiLatestVersion(input.packageName);
}

async function researchPythonRequirement(input: {
  workspacePath: string;
  requirement: ParsedRequirement;
  timeoutMs: number;
}): Promise<PythonPackageResearch> {
  const latestVersion = await latestPythonPackageVersion({
    workspacePath: input.workspacePath,
    packageName: input.requirement.name,
    timeoutMs: input.timeoutMs,
  });
  if (latestVersion === null) {
    return {
      packageName: input.requirement.name,
      declaredSpec: input.requirement.spec,
      requestedSpec: input.requirement.spec,
      latestVersion: null,
      chosenSpec: null,
      status: "unresolved",
      note: "PyPI lookup failed; keep existing requirement unless dependency installation later succeeds.",
      lineIndex: input.requirement.lineIndex,
    };
  }
  const currentExactVersion = exactPythonVersionFromRequirement(input.requirement);
  const replacementLine = pythonRequirementReplacement(input.requirement, latestVersion);
  return {
    packageName: input.requirement.name,
    declaredSpec: input.requirement.spec,
    requestedSpec: input.requirement.spec,
    latestVersion,
    chosenSpec: `${input.requirement.packagePart}==${latestVersion}`,
    status: currentExactVersion === latestVersion ? "kept" : "chosen",
    note: currentExactVersion === latestVersion
      ? "Already declared at the latest Python package version."
      : "Declared requirement is not pinned to the current Python package version; requirements.txt will be updated before Codex starts coding.",
    lineIndex: input.requirement.lineIndex,
    replacementLine,
  };
}

async function researchRequestedPythonPackage(input: {
  workspacePath: string;
  packageName: string;
  timeoutMs: number;
}): Promise<PythonPackageResearch> {
  const latestVersion = await latestPythonPackageVersion(input);
  return {
    packageName: input.packageName,
    declaredSpec: null,
    requestedSpec: input.packageName,
    latestVersion,
    chosenSpec: latestVersion === null ? null : `${input.packageName}==${latestVersion}`,
    status: latestVersion === null ? "unresolved" : "chosen",
    note: latestVersion === null
      ? "PyPI lookup failed; avoid adding this package unless later dependency installation succeeds."
      : "Not declared yet; if this Python package is needed, add the current version shown here.",
  };
}

async function researchPythonPackages(input: {
  workspacePath: string;
  plan: PlanRecord;
  tasks: TaskRecord[];
  timeoutMs: number;
}): Promise<{ packages: PythonPackageResearch[]; updates: string[] }> {
  const requirementsPath = path.join(input.workspacePath, "requirements.txt");
  const requirementsContent = await readTextIfExists(requirementsPath);
  const requirements = requirementsContent === null ? [] : parseRequirements(requirementsContent);
  const output: PythonPackageResearch[] = [];
  const updates: string[] = [];
  for (const requirement of requirements) {
    output.push(await researchPythonRequirement({ workspacePath: input.workspacePath, requirement, timeoutMs: input.timeoutMs }));
  }

  if (requirementsContent !== null) {
    const lines = requirementsContent.split(/\r?\n/);
    for (const item of output) {
      if (
        item.declaredSpec === null ||
        item.lineIndex === undefined ||
        item.replacementLine === undefined ||
        lines[item.lineIndex] === item.replacementLine
      ) {
        continue;
      }
      const previous = lines[item.lineIndex] ?? item.declaredSpec;
      lines[item.lineIndex] = item.replacementLine;
      updates.push(`requirements.txt ${item.packageName}: ${previous.trim()} -> ${item.replacementLine.trim()}`);
    }
    if (updates.length > 0) {
      await writeFile(requirementsPath, lines.join("\n"), "utf8");
    }
  }

  const declaredPythonNames = new Set(requirements.map((requirement) => requirement.name.toLowerCase().replace(/_/g, "-")));
  const requestedPython = collectRequestedPythonPackages(input.plan, input.tasks)
    .filter((packageName) => !declaredPythonNames.has(packageName.toLowerCase().replace(/_/g, "-")));
  for (const packageName of requestedPython) {
    output.push(await researchRequestedPythonPackage({ workspacePath: input.workspacePath, packageName, timeoutMs: input.timeoutMs }));
  }

  return { packages: output, updates };
}

function renderReport(input: {
  workSession: WorkSessionRecord;
  plan: PlanRecord;
  npmPackages: NpmPackageResearch[];
  pythonPackages: PythonPackageResearch[];
  manifestUpdates: string[];
}): string {
  const manifestLines = input.manifestUpdates.length === 0
    ? ["- No dependency manifest updates were applied."]
    : input.manifestUpdates.map((line) => `- ${line}`);
  const npmLines = input.npmPackages.length === 0
    ? ["- No npm package candidates detected."]
    : input.npmPackages.map((item) => {
        const declared = item.declaredVersion === null ? "not declared" : item.declaredVersion;
        const latest = item.latestVersion ?? "unknown";
        const chosen = item.chosenSpec ?? "none";
        return `- ${item.packageName}: declared=${declared}; latest=${latest}; recommended=${chosen}; ${item.note}`;
      });
  const pythonLines = input.pythonPackages.length === 0
    ? ["- No Python requirement candidates detected."]
    : input.pythonPackages.map((item) => {
        const latest = item.latestVersion ?? "unknown";
        const chosen = item.chosenSpec ?? "none";
        return `- ${item.packageName}: declared=${item.declaredSpec ?? "not declared"}; latest=${latest}; recommended=${chosen}; ${item.note}`;
      });

  return `# Dependency Research

Plan: ${input.plan.title}
Workspace: ${input.workSession.activeWorktreePath}

Policy:
- Prefer npm/PyPI latest for declared packages and update stale generated workspace manifests before coding.
- Prefer the newest compatible stable package when a new dependency is explicitly needed.
- Treat registry lookup failures as guidance gaps, not proof that app source is broken.

## Manifest updates
${manifestLines.join("\n")}

## npm
${npmLines.join("\n")}

## Python
${pythonLines.join("\n")}
`;
}

function compactSummary(result: DependencyResearchResult): string {
  const lines = [
    ...result.manifestUpdates.slice(0, 12).map((line) => `Applied: ${line}`),
    ...result.npmPackages.slice(0, 12).map((item) => {
      const latest = item.latestVersion ?? "unknown";
      const chosen = item.chosenSpec ?? "none";
      return `${item.packageName}: latest ${latest}, recommended ${chosen}. ${item.note}`;
    }),
    ...result.pythonPackages.slice(0, 8).map((item) => {
      const latest = item.latestVersion ?? "unknown";
      const chosen = item.chosenSpec ?? "none";
      return `${item.packageName}: latest ${latest}, recommended ${chosen}. ${item.note}`;
    }),
  ];
  return lines.length === 0
    ? "No external dependency candidates were detected. Use current workspace declarations."
    : lines.join("\n");
}

async function workspaceHasAnyFile(workspacePath: string, fileNames: string[]): Promise<boolean> {
  for (const fileName of fileNames) {
    if (await fileExists(path.join(workspacePath, fileName))) {
      return true;
    }
  }
  return false;
}

async function applyNpmManifestUpdates(input: {
  workspacePath: string;
  packageJson: Record<string, unknown>;
  npmPackages: NpmPackageResearch[];
}): Promise<{ packageJson: Record<string, unknown>; updates: string[] }> {
  const packageJson = cloneJsonRecord(input.packageJson);
  const updates: string[] = [];

  for (const groupName of ["dependencies", "devDependencies"]) {
    const group = mutableRecord(packageJson[groupName]);
    if (group === null) {
      continue;
    }
    for (const item of input.npmPackages) {
      if (item.declaredVersion === null || item.chosenSpec === null) {
        continue;
      }
      const chosenVersion = versionFromPackageSpec(item.chosenSpec);
      if (chosenVersion === null || typeof group[item.packageName] !== "string") {
        continue;
      }
      const previous = group[item.packageName];
      if (previous !== chosenVersion) {
        group[item.packageName] = chosenVersion;
        updates.push(`${item.packageName}: ${previous} -> ${chosenVersion}`);
      }
    }
  }

  const scripts = mutableRecord(packageJson.scripts);
  const dependencies = mutableRecord(packageJson.dependencies);
  if (
    dependencies?.next !== undefined &&
    scripts !== null &&
    (scripts.lint === "next lint" || scripts.lint === "eslint .")
  ) {
    const previous = scripts.lint;
    scripts.lint = "eslint app components src --no-error-on-unmatched-pattern";
    updates.push(`lint script: ${previous} -> ${scripts.lint}`);
  }

  if (dependencies?.next !== undefined && !(await workspaceHasAnyFile(input.workspacePath, eslintFlatConfigFiles))) {
    await writeFile(path.join(input.workspacePath, "eslint.config.mjs"), nextEslintConfig, "utf8");
    updates.push("added eslint.config.mjs for current Next/ESLint.");
  }

  if (updates.length > 0) {
    await writePackageJson(input.workspacePath, packageJson);
  }

  return { packageJson, updates };
}

export async function researchDependenciesForApprovedPlan(input: {
  workSession: WorkSessionRecord;
  plan: PlanRecord;
  tasks: TaskRecord[];
}): Promise<DependencyResearchResult> {
  const config = getConfig();
  await assertSafeWorkspace(input.workSession.activeWorktreePath, { operation: "dependency research" });
  const packageJson = await readPackageJson(input.workSession.activeWorktreePath);
  const declaredNpm = packageJson === null
    ? []
    : [...recordEntries(packageJson.dependencies), ...recordEntries(packageJson.devDependencies)]
        .map(([name, version]) => ({ packageSpec: name, declaredVersion: version }));
  const declaredNames = new Set(declaredNpm.map((entry) => entry.packageSpec));
  const requestedNpm = shouldCollectRequestedNpmPackages({
    workSession: input.workSession,
    plan: input.plan,
    tasks: input.tasks,
    packageJson,
  })
    ? collectRequestedNpmPackages(input.plan, input.tasks)
    .filter((packageSpec) => !declaredNames.has(packageNameFromSpec(packageSpec)))
    .map((packageSpec) => ({ packageSpec, declaredVersion: null }))
    : [];
  const timeoutMs = Math.min(Math.max(config.shellTimeoutMs, 30000), 120000);

  let declaredNpmPackages: NpmPackageResearch[] = [];
  if (packageJson !== null) {
    for (const candidate of declaredNpm) {
      declaredNpmPackages.push(await researchNpmPackage({
        workspacePath: input.workSession.activeWorktreePath,
        packageJson,
        packageSpec: candidate.packageSpec,
        declaredVersion: candidate.declaredVersion,
        timeoutMs,
      }));
    }
    declaredNpmPackages = await enforceDeclaredNpmPeerCompatibility({
      workspacePath: input.workSession.activeWorktreePath,
      packageJson,
      npmPackages: declaredNpmPackages,
      timeoutMs,
    });
  }

  const manifest = packageJson === null
    ? { packageJson: null, updates: [] as string[] }
    : await applyNpmManifestUpdates({
        workspacePath: input.workSession.activeWorktreePath,
        packageJson,
        npmPackages: declaredNpmPackages,
      });
  const requestedNpmPackages: NpmPackageResearch[] = [];
  if (manifest.packageJson !== null) {
    for (const candidate of requestedNpm) {
      requestedNpmPackages.push(await researchNpmPackage({
        workspacePath: input.workSession.activeWorktreePath,
        packageJson: manifest.packageJson,
        packageSpec: candidate.packageSpec,
        declaredVersion: candidate.declaredVersion,
        timeoutMs,
      }));
    }
  }

  const npmPackages = [...declaredNpmPackages, ...requestedNpmPackages];
  const pythonResearch = await researchPythonPackages({
    workspacePath: input.workSession.activeWorktreePath,
    plan: input.plan,
    tasks: input.tasks,
    timeoutMs,
  });
  const manifestUpdates = [...manifest.updates, ...pythonResearch.updates];
  const report = renderReport({ ...input, npmPackages, pythonPackages: pythonResearch.packages, manifestUpdates });
  const result: DependencyResearchResult = {
    status: "completed",
    report,
    npmPackages,
    pythonPackages: pythonResearch.packages,
    manifestUpdates,
    summary: "",
  };
  result.summary = compactSummary(result);

  await saveArtifact({
    workSessionId: input.workSession.id,
    kind: "report",
    fileName: `dependency-research-${input.plan.id}.md`,
    content: report,
    metadata: {
      artifactRole: "dependency_research_report",
      reportType: "dependency_research",
      summary: result.summary,
      planId: input.plan.id,
      workspacePath: input.workSession.activeWorktreePath,
      npmPackageCount: npmPackages.length,
      pythonPackageCount: pythonResearch.packages.length,
      manifestUpdateCount: manifestUpdates.length,
      status: result.status,
    },
  });

  return result;
}
