import path from "node:path";
import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolveStackFromRequestPlugins } from "@/lib/server/stacks/registry";
import { classifyProductIntent, isPlainStaticWebPageRequest } from "@/lib/shared/request-intent";
import { getConfig } from "@/lib/server/config";
import type { ProjectStack } from "@/lib/shared/types";

const mlFrameworkNamePattern =
  /\b(scikit-?learn|sklearn|pytorch|tensorflow|keras|jax|xgboost|lightgbm|catboost|transformers|hugging\s?face|sentence-?transformers|qlora|peft|bitsandbytes|gguf|onnxruntime)\b/;
const mlTaskPattern =
  /\b(machine learning|deep learning|neural network|\bcnn\b|\bllm\b|large language model|small language model|language model|embeddings?|reinforcement learning|transfer learning|fine[-\s]?tun(?:e|ing)|model training|train(?:ing)?\s+(?:a |an |the )?(?:\w+\s+){0,3}(?:model|classifier|network|regressor|transformer|detector|predictor|cnn)|classifier|regression model|distillation|quantiz(?:e|ation)|tiny recursive model|\btrm\b)\b/;

const mlWebIntentPattern = /\b(web app|website|rest api|http server)\b/;
const genericPythonWebIntentPattern = /\b(web app|website|site|server|api|route|page|dashboard|frontend|full[-\s]?stack)\b/;

function requestMentionsMl(normalized: string): boolean {
  return mlFrameworkNamePattern.test(normalized) || mlTaskPattern.test(normalized);
}

function requirementsMentionMl(requirements: string): boolean {
  return /\b(scikit-learn|sklearn|torch|tensorflow|keras|jax|xgboost|lightgbm|catboost|transformers|sentence-transformers|peft|bitsandbytes|accelerate|onnxruntime|datasets)\b/i.test(requirements);
}

function sourceImportsMl(source: string): boolean {
  return /\b(?:import|from)\s+(?:sklearn|torch|tensorflow|keras|jax|xgboost|lightgbm|catboost|transformers|datasets|peft|accelerate)\b/.test(source);
}

export type StackResolutionSource = "request" | "workspace" | "default";

export interface StackResolution {
  stack: ProjectStack;
  confidence: "high" | "medium" | "low";
  reason: string;
  source: StackResolutionSource;
}

const ignoredEntries = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".orchestrator",
  "node_modules",
  ".turbo",
  ".rlib",
  "renv",
  ".Rproj.user",
  "packrat",
  "AGENTS.md",
  "CLAUDE.md",
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

function dependencyNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.keys(value);
}

function hasDependency(packageJson: Record<string, unknown> | null, dependency: string): boolean {
  if (packageJson === null) {
    return false;
  }
  return [
    ...dependencyNames(packageJson.dependencies),
    ...dependencyNames(packageJson.devDependencies),
  ].includes(dependency);
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
    if (ignoredEntries.has(entry.name)) {
      continue;
    }
    const relative = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(root, relative, depth + 1));
    } else {
      files.push(relative.replace(/\\/g, "/"));
    }
  }
  return files;
}

function stackFromRequest(userRequest: string): Omit<StackResolution, "source"> | null {
  const normalized = userRequest.toLowerCase();
  const productIntent = classifyProductIntent(userRequest);
  if (/\b(django)\b/.test(normalized)) {
    return { stack: "python-django", confidence: "high", reason: "The request explicitly mentions Django." };
  }
  if (/\b(flask)\b/.test(normalized)) {
    return { stack: "python-flask", confidence: "high", reason: "The request explicitly mentions Flask." };
  }
  if (/\b(fastapi)\b/.test(normalized)) {
    return { stack: "python-flask", confidence: "high", reason: "The request explicitly mentions FastAPI, which is handled by the Python web stack." };
  }
  if (requestMentionsMl(normalized)) {
    const webIntent = productIntent.pythonMode === "web" || mlWebIntentPattern.test(normalized);
    if (!webIntent) {
      return { stack: "python-ml", confidence: "high", reason: "The request asks for machine-learning / scientific-compute work." };
    }
  }
  if (/\bpython\b/.test(normalized)) {
    const webIntent = productIntent.pythonMode === "web" || genericPythonWebIntentPattern.test(normalized);
    return {
      stack: webIntent ? "python-flask" : "python-script",
      confidence: "high",
      reason: webIntent
        ? `The request asks for Python web functionality (${productIntent.productShape}).`
        : `The request asks for Python script/report functionality (${productIntent.productShape}).`,
    };
  }
  if (/\bshiny\b/.test(normalized)) {
    return { stack: "r-shiny", confidence: "high", reason: "The request explicitly mentions Shiny." };
  }
  if (
    /\b(ggplot2?|tidyverse|dplyr|rscript|cran)\b/.test(normalized)
    || /\br\s+(?:script|plot|chart|graph|visuali[sz]ation|markdown|analysis|programming|language)\b/.test(normalized)
    || /\b(?:in|using|with|via)\s+r\b/.test(normalized)
  ) {
    const webIntent = /\b(dashboard|web app|interactive app)\b/.test(normalized);
    return {
      stack: webIntent ? "r-shiny" : "r-script",
      confidence: "high",
      reason: webIntent
        ? "The request asks for an interactive R/Shiny web app."
        : "The request asks for R script/visualization functionality.",
    };
  }
  if (/\bgo(?:lang)?\b/.test(normalized)) {
    return { stack: "go", confidence: "high", reason: "The request explicitly mentions Go." };
  }
  if (/\brust\b|\bcargo\b/.test(normalized)) {
    return { stack: "rust", confidence: "high", reason: "The request explicitly mentions Rust or Cargo." };
  }
  if (/\bc#\b|\bcsharp\b|\bdotnet\b|\basp\.?net\b/.test(normalized)) {
    return { stack: "csharp", confidence: "high", reason: "The request explicitly mentions C#/.NET." };
  }
  if (/\bjava\b|\bspring boot\b|\bmaven\b|\bgradle\b/.test(normalized)) {
    return { stack: "java", confidence: "high", reason: "The request explicitly mentions Java." };
  }
  if (/\bphp\b|\blaravel\b|\bcomposer\b/.test(normalized)) {
    return { stack: "php", confidence: "high", reason: "The request explicitly mentions PHP." };
  }
  if (/\bruby\b|\brails\b|\brack\b|\bbundler\b/.test(normalized)) {
    return { stack: "ruby", confidence: "high", reason: "The request explicitly mentions Ruby." };
  }
  if (/\b(express|fastify)\b/.test(normalized)) {
    return { stack: "node-express", confidence: "high", reason: "The request explicitly mentions a Node web framework." };
  }
  if (/\bnode(?:\.js|js)?\b/.test(normalized)) {
    const cliIntent = /\b(cli|command line|script|terminal)\b/.test(normalized);
    const webIntent = /\b(web app|server|api|route|endpoint|website|site)\b/.test(normalized);
    return {
      stack: cliIntent && !webIntent ? "node-cli" : "node-express",
      confidence: "high",
      reason: "The request explicitly mentions Node.js.",
    };
  }
  if (/\bnext(?:\.js|js)?\b/.test(normalized)) {
    return { stack: "next", confidence: "high", reason: "The request explicitly mentions Next.js." };
  }
  if (/\bvite\b/.test(normalized)) {
    return { stack: "vite-react", confidence: "high", reason: "The request explicitly mentions Vite." };
  }
  if (isPlainStaticWebPageRequest(userRequest)) {
    return { stack: "static-html", confidence: "high", reason: "The request asks for a simple front-end-only/static web page." };
  }
  if (/\b(cli|command line|terminal script)\b/.test(normalized)) {
    return { stack: "node-cli", confidence: "medium", reason: "The request asks for CLI behavior without naming a language." };
  }
  if (/\b(web app|app|interface|page|site|website|button|form|dashboard|tracker|counter)\b/.test(normalized)) {
    return null;
  }
  return null;
}

async function stackFromWorkspace(workspacePath: string): Promise<Omit<StackResolution, "source"> | null> {
  const files = await collectFiles(workspacePath);
  const packageJson = await readPackageJson(workspacePath);
  if (files.includes("go.mod") || files.some((file) => file.endsWith(".go"))) {
    return { stack: "go", confidence: "high", reason: "Go module or source files were detected." };
  }
  if (files.includes("Cargo.toml") || files.some((file) => file.endsWith(".rs"))) {
    return { stack: "rust", confidence: "high", reason: "Cargo manifest or Rust source files were detected." };
  }
  if (files.some((file) => file.endsWith(".csproj") || file.endsWith(".sln") || file.endsWith(".cs"))) {
    return { stack: "csharp", confidence: "high", reason: ".NET project or C# source files were detected." };
  }
  if (files.includes("pom.xml") || files.includes("build.gradle") || files.includes("build.gradle.kts") || files.some((file) => file.endsWith(".java"))) {
    return { stack: "java", confidence: "high", reason: "Java build or source files were detected." };
  }
  if (files.includes("composer.json") || files.some((file) => file.endsWith(".php"))) {
    return { stack: "php", confidence: "high", reason: "PHP manifest or source files were detected." };
  }
  if (files.includes("Gemfile") || files.includes("config.ru") || files.some((file) => file.endsWith(".rb"))) {
    return { stack: "ruby", confidence: "high", reason: "Ruby manifest or source files were detected." };
  }
  const rSourceFiles = files.filter((file) => /\.[rR]$/.test(file));
  const hasShinyEntry = files.some((file) => /(^|\/)app\.r$/i.test(file))
    || (files.some((file) => /(^|\/)ui\.r$/i.test(file)) && files.some((file) => /(^|\/)server\.r$/i.test(file)));
  if (hasShinyEntry || rSourceFiles.length > 0 || files.includes("DESCRIPTION") || files.includes("renv.lock")) {
    const shinyMarker = /\bshinyApp\s*\(|\bshinyUI\s*\(|\bfluidPage\s*\(|\bnavbarPage\s*\(|\bdashboardPage\s*\(|\blibrary\s*\(\s*["']?shiny["']?\s*\)/;
    if (hasShinyEntry) {
      const candidates = files.filter((file) => /(^|\/)(app|ui|server)\.r$/i.test(file)).slice(0, 4);
      for (const file of candidates) {
        const source = await readFile(path.join(workspacePath, file), "utf8").catch(() => "");
        if (shinyMarker.test(source)) {
          return { stack: "r-shiny", confidence: "high", reason: `Shiny app files were detected (${file}).` };
        }
      }
    }
    return { stack: "r-script", confidence: "medium", reason: "R source files were detected." };
  }
  if (await fileExists(path.join(workspacePath, "manage.py"))) {
    return { stack: "python-django", confidence: "high", reason: "manage.py was detected." };
  }
  if (files.includes("app.py")) {
    return { stack: "python-flask", confidence: "medium", reason: "Python app files were detected." };
  }
  if (hasDependency(packageJson, "next") || files.some((file) => file.startsWith("app/") || file.startsWith("pages/"))) {
    return { stack: "next", confidence: "high", reason: "Next.js app files or dependency were detected." };
  }
  if (hasDependency(packageJson, "vite")) {
    return { stack: "vite-react", confidence: "high", reason: "Vite dependency was detected." };
  }
  if (hasDependency(packageJson, "express") || hasDependency(packageJson, "fastify")) {
    return { stack: "node-express", confidence: "high", reason: "Node web framework dependency was detected." };
  }
  if (packageJson !== null) {
    return { stack: "node-cli", confidence: "medium", reason: "package.json was detected without a known web framework." };
  }
  if (files.some((file) => file.endsWith(".py")) || files.includes("pyproject.toml")) {
    const requirements = files.includes("requirements.txt")
      ? await readFile(path.join(workspacePath, "requirements.txt"), "utf8").catch(() => "")
      : "";
    if (requirementsMentionMl(requirements)) {
      return { stack: "python-ml", confidence: "high", reason: "ML frameworks were detected in requirements.txt." };
    }
    const pyFiles = files.filter((file) => file.endsWith(".py")).slice(0, 12);
    for (const file of pyFiles) {
      const source = await readFile(path.join(workspacePath, file), "utf8").catch(() => "");
      if (sourceImportsMl(source)) {
        return { stack: "python-ml", confidence: "high", reason: `ML framework imports were detected in ${file}.` };
      }
    }
    return { stack: "python-script", confidence: "medium", reason: "Python files were detected." };
  }
  if (files.includes("index.html")) {
    return { stack: "static-html", confidence: "high", reason: "index.html was detected." };
  }
  return null;
}

function gateStack(resolution: StackResolution): StackResolution {
  if (resolution.stack === "python-ml" && !getConfig().mlPipelineEnabled) {
    return {
      stack: "python-script",
      confidence: resolution.confidence,
      reason: `${resolution.reason} (ML pipeline disabled; using python-script.)`,
      source: resolution.source,
    };
  }
  return resolution;
}

export async function resolveProjectStack(input: {
  userRequest: string;
  workspacePath: string;
  defaultStack: ProjectStack;
}): Promise<StackResolution> {
  return gateStack(await resolveProjectStackInner(input));
}

async function resolveProjectStackInner(input: {
  userRequest: string;
  workspacePath: string;
  defaultStack: ProjectStack;
}): Promise<StackResolution> {
  const requested = await resolveStackFromRequestPlugins(input.userRequest) ?? stackFromRequest(input.userRequest);
  const workspace = await stackFromWorkspace(input.workspacePath);
  if (workspace !== null) {
    if (
      requested !== null &&
      requested.confidence === "high" &&
      workspace.stack !== requested.stack &&
      (workspace.stack === "node-cli" || workspace.stack === "python-script" || workspace.stack === "r-script")
    ) {
      return {
        ...requested,
        reason: `${requested.reason} Existing ${workspace.stack} scaffold evidence is weak and will not override the explicit request.`,
        source: "request",
      };
    }
    return { ...workspace, source: "workspace" };
  }

  if (requested !== null) {
    return { ...requested, source: "request" };
  }

  return {
    stack: input.defaultStack,
    confidence: "low",
    reason: `No existing files or explicit stack were detected. Using DEFAULT_PROJECT_STACK=${input.defaultStack}.`,
    source: "default",
  };
}
