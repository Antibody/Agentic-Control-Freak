import { constants } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createWorkspaceComponentGraphFromLegacyStack } from "@/lib/server/stacks/registry";
import type { ProductShape } from "@/lib/shared/request-intent";
import { filterBuildVerificationCommands } from "@/lib/shared/verification-commands";
import type { JsonObject, PreviewAppType, ProjectStack } from "@/lib/shared/types";
import type { WorkspaceComponentAnalysis, WorkspaceDependencyGraph } from "@/lib/shared/workspace-components";

export interface WorkspaceAnalysis {
  workspacePath: string;
  isEmpty: boolean;
  appType: PreviewAppType;
  stack: ProjectStack;
  productShape: ProductShape;
  pythonMode: "script" | "web" | "unknown";
  components: WorkspaceComponentAnalysis[];
  dependencyGraph: WorkspaceDependencyGraph;
  suggestedPrimaryComponentId: string | null;
  packageManager: string | null;
  packageJson: {
    scripts: Record<string, string>;
    dependencies: string[];
    devDependencies: string[];
  } | null;
  detectedRoutes: string[];
  importantFiles: string[];
  verificationCommands: string[];
  notes: string[];
}

const ignoredEmptyWorkspaceEntries = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".orchestrator",
  "node_modules",
  "storage",
  "vendor",
  "AGENTS.md",
  "CLAUDE.md",
]);
const importantNames = new Set([
  "package.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.js",
  "vite.config.ts",
  "tsconfig.json",
  "index.html",
  "requirements.txt",
  "pyproject.toml",
  "manage.py",
  "app.py",
  "main.py",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Program.cs",
  "_ViewImports.cshtml",
  "_ViewStart.cshtml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "composer.lock",
  "Gemfile",
  "Gemfile.lock",
  "config.ru",
  "app.rb",
  "DESCRIPTION",
  "renv.lock",
  "app.R",
  "main.R",
  "ui.R",
  "server.R",
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

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) {
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

function dependencyNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.keys(value).sort();
}

async function collectFiles(root: string, current = "", depth = 0): Promise<string[]> {
  if (depth > 4) {
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
    if (ignoredEmptyWorkspaceEntries.has(entry.name) || entry.name.startsWith(".turbo")) {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (["app", "pages", "Pages", "src", "components", "public", "wwwroot", "templates", "static", "generated_project", "backend", "api", "server", "services", "routes", "resources", "bootstrap", "config"].includes(entry.name) || current.length > 0) {
        files.push(...await collectFiles(root, relative, depth + 1));
      }
      continue;
    }
    files.push(relative.replace(/\\/g, "/"));
  }
  return files;
}

function routeFromAppFile(file: string): string | null {
  const normalized = file.replace(/\\/g, "/");
  const match = normalized.match(/^app\/(.+)\/page\.(tsx|ts|jsx|js)$/);
  if (normalized.match(/^app\/page\.(tsx|ts|jsx|js)$/)) {
    return "/";
  }
  if (match === null) {
    return null;
  }
  return `/${match[1]}`.replace(/\/\([^)]+\)/g, "").replace(/\/+/g, "/");
}

function routeFromPagesFile(file: string): string | null {
  const normalized = file.replace(/\\/g, "/");
  const match = normalized.match(/^pages\/(.+)\.(tsx|ts|jsx|js)$/);
  if (match === null || match[1].startsWith("_")) {
    return null;
  }
  return `/${match[1].replace(/\/index$/, "")}`.replace(/\/+/g, "/");
}

function routeFromPublicHtmlFile(file: string): string | null {
  const normalized = file.replace(/\\/g, "/");
  const match = normalized.match(/^public\/(.+)\.html$/);
  if (match === null) {
    return null;
  }
  return match[1] === "index" ? "/" : `/${match[1]}`.replace(/\/+/g, "/");
}

function routeFromRazorPageFile(file: string): string | null {
  const normalized = file.replace(/\\/g, "/");
  const match = normalized.match(/^Pages\/(.+)\.cshtml$/);
  if (match === null || match[1].startsWith("_") || match[1].split("/").some((part) => part.startsWith("_"))) {
    return null;
  }
  const pagePath = match[1].replace(/(?:^|\/)Index$/i, "");
  return pagePath.length === 0 ? "/" : `/${pagePath}`.replace(/\/+/g, "/");
}

function detectRoutes(files: string[]): string[] {
  return Array.from(new Set(files.map((file) => routeFromAppFile(file) ?? routeFromPagesFile(file) ?? routeFromPublicHtmlFile(file) ?? routeFromRazorPageFile(file)).filter((route): route is string => route !== null))).sort();
}

function detectPackageManager(packageJson: Record<string, unknown> | null, files: string[]): string | null {
  if (files.includes("go.mod")) return "go";
  if (files.includes("Cargo.toml")) return "cargo";
  if (files.some((file) => file.endsWith(".csproj")) || files.some((file) => file.endsWith(".sln"))) return "dotnet";
  if (files.includes("pom.xml")) return "maven";
  if (files.includes("build.gradle") || files.includes("build.gradle.kts")) return "gradle";
  if (files.includes("composer.json")) return "composer";
  if (files.includes("Gemfile")) return "bundler";
  const packageManager = packageJson?.packageManager;
  if (typeof packageManager === "string") {
    if (packageManager.startsWith("pnpm@")) return "pnpm";
    if (packageManager.startsWith("yarn@")) return "yarn";
    if (packageManager.startsWith("bun@")) return "bun";
    if (packageManager.startsWith("npm@")) return "npm";
  }
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("yarn.lock")) return "yarn";
  if (files.includes("bun.lock") || files.includes("bun.lockb")) return "bun";
  if (packageJson !== null || files.includes("package-lock.json")) return "npm";
  return null;
}

function detectStack(packageJson: Record<string, unknown> | null, files: string[]): ProjectStack {
  const dependencies = new Set([
    ...dependencyNames(packageJson?.dependencies),
    ...dependencyNames(packageJson?.devDependencies),
  ]);
  const scripts = stringRecord(packageJson?.scripts);
  if (dependencies.has("next") || files.some((file) => file.startsWith("app/") || file.startsWith("pages/"))) {
    return "next";
  }
  if (dependencies.has("vite") || Object.values(scripts).some((script) => script.includes("vite"))) {
    return "vite-react";
  }
  if (dependencies.has("express") || dependencies.has("fastify")) {
    return "node-express";
  }
  if (files.includes("go.mod") || files.some((file) => file.endsWith(".go"))) {
    return "go";
  }
  if (files.includes("Cargo.toml") || files.some((file) => file.endsWith(".rs"))) {
    return "rust";
  }
  if (files.some((file) => file.endsWith(".csproj") || file.endsWith(".sln") || file.endsWith(".cs"))) {
    return "csharp";
  }
  if (files.includes("pom.xml") || files.includes("build.gradle") || files.includes("build.gradle.kts") || files.some((file) => file.endsWith(".java"))) {
    return "java";
  }
  if (files.includes("composer.json") || files.some((file) => file.endsWith(".php"))) {
    return "php";
  }
  if (files.includes("Gemfile") || files.includes("config.ru") || files.some((file) => file.endsWith(".rb"))) {
    return "ruby";
  }
  if (
    files.some((file) => /(^|\/)app\.r$/i.test(file))
    || (files.some((file) => /(^|\/)ui\.r$/i.test(file)) && files.some((file) => /(^|\/)server\.r$/i.test(file)))
  ) {
    return "r-shiny";
  }
  if (files.some((file) => /\.[rR]$/.test(file)) || files.includes("DESCRIPTION") || files.includes("renv.lock")) {
    return "r-script";
  }
  if (files.includes("manage.py")) {
    return "python-django";
  }
  if (files.includes("app.py") || dependencies.has("flask")) {
    return "python-flask";
  }
  if (packageJson !== null) {
    return "node-cli";
  }
  if (files.some((file) => file.endsWith(".py")) || files.includes("pyproject.toml")) {
    return "python-script";
  }
  if (files.includes("index.html")) {
    return "static-html";
  }
  return "unknown";
}

function appTypeFromStack(stack: ProjectStack): PreviewAppType {
  return stack;
}

function productShapeFromStack(stack: ProjectStack, files: string[]): { productShape: ProductShape; pythonMode: "script" | "web" | "unknown" } {
  if (stack === "python-script") {
    return { productShape: "script", pythonMode: "script" };
  }
  if (stack === "python-flask" || stack === "python-django") {
    const hasFrontendAssets = files.some((file) =>
      file.startsWith("templates/") ||
      file.includes("/templates/") ||
      file.startsWith("static/") ||
      file.includes("/static/") ||
      file.endsWith(".html")
    );
    return { productShape: hasFrontendAssets ? "fullstack-web" : "server-rendered-web", pythonMode: "web" };
  }
  if (stack === "r-script") {
    return { productShape: "script", pythonMode: "unknown" };
  }
  if (stack === "r-shiny") {
    const hasFrontendAssets = files.some((file) => file.startsWith("www/") || file.includes("/www/") || file.endsWith(".html"));
    return { productShape: hasFrontendAssets ? "fullstack-web" : "server-rendered-web", pythonMode: "unknown" };
  }
  if (stack === "static-html") {
    return { productShape: "static-frontend", pythonMode: "unknown" };
  }
  if (stack === "node-express" || stack === "go" || stack === "rust" || stack === "csharp" || stack === "java" || stack === "php" || stack === "ruby") {
    return { productShape: "server-rendered-web", pythonMode: "unknown" };
  }
  if (stack === "next" || stack === "vite-react") {
    return { productShape: "fullstack-web", pythonMode: "unknown" };
  }
  if (stack === "node-cli") {
    return { productShape: "cli", pythonMode: "unknown" };
  }
  return { productShape: "unknown", pythonMode: "unknown" };
}

function importantFilesFor(files: string[]): string[] {
  return files
    .filter((file) => importantNames.has(file) || /^[^/]+\.(py|go|rb|php|cs|csproj|sln|java|[rR])$/.test(file) || /^(app|pages|Pages|src|components|public|wwwroot|templates|static|www|generated_project|backend|api|server|services|routes|resources|bootstrap|config|R)\//.test(file))
    .slice(0, 80);
}

function quoteCommandArgument(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function pythonEntrypointFromFiles(files: string[]): string | null {
  const pythonFiles = files.filter((file) => file.endsWith(".py") && !file.split("/").includes("__pycache__"));
  if (pythonFiles.length === 0) {
    return null;
  }
  return pythonFiles.find((file) => file === "main.py")
    ?? pythonFiles.find((file) => file === "app.py")
    ?? pythonFiles.find((file) => !file.includes("/"))
    ?? pythonFiles[0]
    ?? null;
}

function rEntrypointFromFiles(files: string[]): string | null {
  const shinyNames = new Set(["app.r", "ui.r", "server.r", "global.r"]);
  const rFiles = files.filter((file) => /\.[rR]$/.test(file) && !/(^|\/)(\.rlib|renv|packrat|\.Rproj\.user)\//.test(file));
  if (rFiles.length === 0) {
    return null;
  }
  return rFiles.find((file) => file === "main.R")
    ?? rFiles.find((file) => !file.includes("/") && !shinyNames.has(file.toLowerCase()))
    ?? rFiles.find((file) => !shinyNames.has(file.toLowerCase()))
    ?? rFiles[0]
    ?? null;
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

function phpVerificationCommands(files: string[]): string[] {
  const lintTargets = files
    .filter(isPhpLintCandidate)
    .sort((left, right) => phpLintPriority(left) - phpLintPriority(right) || left.localeCompare(right))
    .slice(0, 64);
  const commands = files.includes("composer.json") ? ["composer install --no-interaction"] : [];
  if (lintTargets.length > 0) {
    commands.push(...lintTargets.map((file) => `php -l ${quoteCommandArgument(file)}`));
  } else if (files.includes("public/index.php")) {
    commands.push("php -l public/index.php");
  } else if (files.includes("index.php")) {
    commands.push("php -l index.php");
  }
  return Array.from(new Set(commands));
}

function defaultVerificationCommands(stack: ProjectStack, files: string[]): string[] {
  const dotnetProjectFiles = files.filter((file) => file.endsWith(".csproj") || file.endsWith(".sln"));
  const dotnetSolutionFiles = dotnetProjectFiles.filter((file) => file.endsWith(".sln"));
  const dotnetBuildTargets = dotnetSolutionFiles.length > 0
    ? dotnetSolutionFiles
    : dotnetProjectFiles.filter((file) => file.endsWith(".csproj"));
  const dotnetBuildCommands = dotnetBuildTargets.map((file) => `dotnet build ${quoteCommandArgument(file)}`);

  if (stack === "next" || stack === "vite-react") {
    return Array.from(new Set(["npm run typecheck", "npm run lint", ...dotnetBuildCommands]));
  }
  if (stack === "node-cli" || stack === "node-express") {
    return Array.from(new Set(["npm run typecheck", "npm run lint", ...dotnetBuildCommands]));
  }
  if (stack === "python-script") {
    const entrypoint = pythonEntrypointFromFiles(files);
    return entrypoint === null ? [] : [`python -m py_compile ${quoteCommandArgument(entrypoint)}`];
  }
  if (stack === "python-flask") {
    return ["python -m py_compile app.py"];
  }
  if (stack === "python-django") {
    return ["python -m py_compile manage.py", "python manage.py check", "python manage.py makemigrations --check --dry-run", "python manage.py migrate --plan --noinput"];
  }
  if (stack === "r-shiny") {
    if (files.some((file) => /(^|\/)app\.r$/i.test(file))) {
      return [`Rscript -e invisible(parse(file="app.R"))`];
    }
    const commands: string[] = [];
    if (files.some((file) => /(^|\/)ui\.r$/i.test(file))) commands.push(`Rscript -e invisible(parse(file="ui.R"))`);
    if (files.some((file) => /(^|\/)server\.r$/i.test(file))) commands.push(`Rscript -e invisible(parse(file="server.R"))`);
    return commands.length > 0 ? commands : [`Rscript -e invisible(parse(file="app.R"))`];
  }
  if (stack === "r-script") {
    const entrypoint = rEntrypointFromFiles(files);
    return entrypoint === null ? [] : [`Rscript -e invisible(parse(file="${entrypoint}"))`];
  }
  if (stack === "go") {
    return ["go test ./...", "go vet ./..."];
  }
  if (stack === "rust") {
    return ["cargo check", "cargo test"];
  }
  if (stack === "csharp") {
    return dotnetBuildCommands.length > 0 ? dotnetBuildCommands : ["dotnet build"];
  }
  if (stack === "java") {
    return files.includes("pom.xml")
      ? ["mvn test"]
      : files.includes("build.gradle") || files.includes("build.gradle.kts")
        ? ["gradle test"]
        : [`javac -d ${quoteCommandArgument(path.join(".orchestrator", "java-verify-classes"))} ${files.filter((file) => file.endsWith(".java")).map(quoteCommandArgument).join(" ")}`];
  }
  if (stack === "php") {
    return phpVerificationCommands(files);
  }
  if (stack === "ruby") {
    return files.includes("Gemfile") ? ["bundle install", "ruby -c app.rb"] : ["ruby -c app.rb"];
  }
  return [];
}

function verificationCommandsFor(stack: ProjectStack, configured: string[], files: string[]): string[] {
  if (configured.length === 0) {
    return defaultVerificationCommands(stack, files);
  }
  const hasPackageJson = stack === "next" || stack === "vite-react" || stack === "node-cli" || stack === "node-express";
  if (hasPackageJson) {
    return Array.from(new Set([...filterBuildVerificationCommands(configured, { allowBuild: false }), ...defaultVerificationCommands(stack, files).filter((command) => command.startsWith("dotnet "))]));
  }
  const compatible = configured.filter((command) => /^(python|py|go|cargo|dotnet|mvn|gradle|php|composer|ruby|bundle)(?:\.(?:exe|cmd|bat))?\s+/i.test(command.trim()));
  if (compatible.length > 0 && stack === "python-django") {
    return Array.from(new Set([...compatible, ...defaultVerificationCommands(stack, files)]));
  }
  if (compatible.length > 0 && stack === "php") {
    return Array.from(new Set([...compatible, ...defaultVerificationCommands(stack, files)]));
  }
  return compatible.length > 0 ? compatible : defaultVerificationCommands(stack, files);
}

export async function analyzeWorkspace(workspacePath: string, verificationCommands: string[]): Promise<WorkspaceAnalysis> {
  const files = await collectFiles(workspacePath);
  const visibleFiles = files.filter((file) => !file.split("/").some((part) => ignoredEmptyWorkspaceEntries.has(part)));
  const packageJsonRaw = await readPackageJson(workspacePath);
  const scripts = stringRecord(packageJsonRaw?.scripts);
  const dependencies = dependencyNames(packageJsonRaw?.dependencies);
  const devDependencies = dependencyNames(packageJsonRaw?.devDependencies);
  const stack = detectStack(packageJsonRaw, visibleFiles);
  const appType = appTypeFromStack(stack);
  const productIntent = productShapeFromStack(stack, visibleFiles);
  const packageManager = detectPackageManager(packageJsonRaw, visibleFiles);
  const detectedRoutes = detectRoutes(visibleFiles);
  const importantFiles = importantFilesFor(visibleFiles);
  const resolvedVerificationCommands = verificationCommandsFor(stack, verificationCommands, visibleFiles);
  const notes: string[] = [];

  if (visibleFiles.length === 0) {
    notes.push("Workspace has no user app files yet.");
  }
  if (packageJsonRaw === null) {
    notes.push("No package.json was detected.");
  }
  if (appType === "next" && !(await fileExists(path.join(workspacePath, "app", "layout.tsx")))) {
    notes.push("Next.js app layout may need to be created or verified.");
  }
  const componentGraph = createWorkspaceComponentGraphFromLegacyStack({
    workspacePath,
    stack,
    packageManager,
    importantFiles,
    detectedRoutes,
    verificationCommands: resolvedVerificationCommands,
    notes,
  });

  return {
    workspacePath,
    isEmpty: visibleFiles.length === 0,
    appType,
    stack,
    productShape: productIntent.productShape,
    pythonMode: productIntent.pythonMode,
    components: componentGraph.components,
    dependencyGraph: componentGraph.dependencyGraph,
    suggestedPrimaryComponentId: componentGraph.suggestedPrimaryComponentId,
    packageManager,
    packageJson: packageJsonRaw === null ? null : { scripts, dependencies, devDependencies },
    detectedRoutes,
    importantFiles,
    verificationCommands: resolvedVerificationCommands,
    notes,
  };
}

export function workspaceAnalysisToJson(analysis: WorkspaceAnalysis): JsonObject {
  return {
    workspacePath: analysis.workspacePath,
    isEmpty: analysis.isEmpty,
    appType: analysis.appType,
    stack: analysis.stack,
    productShape: analysis.productShape,
    pythonMode: analysis.pythonMode,
    components: analysis.components as unknown as JsonObject[],
    dependencyGraph: analysis.dependencyGraph as unknown as JsonObject,
    suggestedPrimaryComponentId: analysis.suggestedPrimaryComponentId,
    packageManager: analysis.packageManager,
    packageJson: analysis.packageJson,
    detectedRoutes: analysis.detectedRoutes,
    importantFiles: analysis.importantFiles,
    verificationCommands: analysis.verificationCommands,
    notes: analysis.notes,
  };
}
