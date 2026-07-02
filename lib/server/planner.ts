import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { mlMethodologyGuidance } from "@/lib/server/ml/ml-methodology";
import { logProcess } from "@/lib/server/logging";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolveCodexCliBin } from "@/lib/server/runtime/codex-cli-resolver";
import { codexReadOnlySandboxArgs, codexReadOnlySandboxEnv, resolveCodexReadOnlySandbox, summarizeReadOnlyWorkspaceChanges } from "@/lib/server/runtime/codex-readonly-sandbox";
import { resolveClaudeCodeBin } from "@/lib/server/runtime/claude-code-resolver";
import { validateClaudeModelEffort } from "@/lib/server/runtime/claude-model-catalog";
import { parseClaudeStreamJson } from "@/lib/server/runtime/claude-stream-parse";
import { resolveAgyCliBin } from "@/lib/server/runtime/agy-cli-resolver";
import { applyAgyRuntimeModel } from "@/lib/server/runtime/agy-runtime-options";
import { runProcess } from "@/lib/server/runtime/process-runner";
import { createOllamaClient } from "@/lib/server/runtime/ollama-client";
import { compareWorkspaceSnapshots, snapshotWorkspace } from "@/lib/server/runtime/workspace-diff";
import { workspaceAnalysisToJson, type WorkspaceAnalysis } from "@/lib/server/workspace-analysis";
import { intentRelevantRequestText, isBrowserGameRequest, validateRequestIntentCoverage } from "@/lib/shared/request-intent";
import { isWeakPlan, normalizeTask, planToMarkdown, sanitizePlanForOperator, stringArray } from "@/lib/shared/plan";
import { allowedTargetStacks, isAllowedTargetStack } from "@/lib/shared/stack-catalog";
import { filterBuildVerificationCommands, userExplicitlyRequestedBuildVerification } from "@/lib/shared/verification-commands";
import type { AgentProvider, PlanJson, PlanTaskInput } from "@/lib/shared/types";

function hasComplexAppScope(userRequest: string): boolean {
  const requestText = intentRelevantRequestText(userRequest);
  const lower = requestText.toLowerCase();
  const featureHits = [
    "dashboard",
    "stats",
    "analytics",
    "settings",
    "theme",
    "import",
    "export",
    "offline",
    "timer",
    "route",
    "routes",
    "view",
    "views",
    "history",
    "responsive",
    "accessibility",
    "localstorage",
    "local storage",
    "sync",
  ].filter((needle) => lower.includes(needle)).length;
  return requestText.length > 900 || featureHits >= 4;
}

const targetStackEnumText = allowedTargetStacks.map((stack) => `"${stack}"`).join("|");

function plannerOutputRules(): string {
  const mlRule = getConfig().mlPipelineEnabled
    ? `\n- Use "python-ml" when the request is machine-learning or scientific-compute work: training/evaluating a model (classical ML such as scikit-learn/XGBoost, or deep learning), fine-tuning, inference/serving a model, numerical simulation, or any "experiment" with measured metrics. Prefer "python-ml" over "python-script" whenever the deliverable is a trained/evaluated model or a measured numerical experiment rather than a one-shot plot/report.
- For a "python-ml" plan, target ROOT-level files only: the orchestrator runs the workspace-root entrypoint (\`python train.py --smoke\` / \`python train.py\`, no other args) plus a root \`predict.py\`, reading hyperparameters and dataset locations from run_config.json. So plan root-level files (e.g. train.py, model.py, predict.py, and supporting modules/packages at the root) and do NOT nest the project under a subdirectory or a named repo folder, do NOT plan a separate training CLI, and do NOT require extra command-line args — a trainer placed in a subdirectory or behind a custom CLI will never be run. All data preparation (tokenize/encode/split/pack) happens INSIDE the entrypoint at run time; do NOT plan a separate data-prep task/command or any pre-built artifact (e.g. tokenized .bin/.npz shards) — the orchestrator only runs the entrypoint.`
    : "";
  return `Operator plan rules:
- Declare "targetStack" at the top level: exactly one of ${targetStackEnumText}, plus a one-line "stackRationale". Choose from the user's request and the workspace analysis; an existing workspace's detected stack wins unless the user asks to change it. When the workspace analysis has isEmpty=true (no detected stack), infer targetStack from the user's request alone and do NOT default to a web framework: a request for a script, program, plot, chart, graph, data visualization, math/numeric computation, simulation, or report output is "python-script" when it names Python or "py" (or otherwise implies a runnable program rather than a website); reserve web stacks (next/vite-react/node-express/python-flask/python-django/static-html/etc.) for requests that ask for a web page, site, app, server, API, or browser UI. Phrases like "plain HTML forms" or "vanilla JS interactions" describe page technique, not the stack — when the request names or clearly implies a server runtime, framework, or templating engine, the stack is that runtime. Use "static-html" only for genuinely frontend-only static pages with no server-side behavior.${mlRule}
- The approval card is a control surface. Tasks are the primary visible output.
- Keep title <= 72 chars and goal <= 220 chars.
- Goal must be a one-line intent summary, not the full user request.
- Never paste attachment metadata, absolute file paths from uploaded files, workspace analysis, or verification command blocks into title, goal, task titles, or task objectives.
- Decompose broad app requests into skip/re-run-friendly tasks by route, feature, or file group. Prefer 4-8 concrete tasks for multi-feature apps.
- Each task title should name the feature/surface being changed, and each task should name concrete targetFiles whenever possible.
- Every implementation task must specify at least 2 concrete expectedChanges and at least 2 verifiable acceptanceCriteria, and must name at least one targetFile (unless its taskKind is "handoff").
- Match taskKind to the workspace analysis: use "create" for files that do not exist yet (for example when isEmpty is true, or the file is absent from importantFiles and detectedRoutes), and reserve "modify" for files that already exist.
- Shape every task as one durable step: independently executable, restartable, narrowly repairable, and verifiable from concrete evidence (a command result, observable UI/API behavior, or file existence).
- Write evidence-friendly acceptanceCriteria that describe observable behavior (for example "POST to the create endpoint returns a 4xx error body when required fields are missing" or "the dashboard lists the new record after creation"), never intentions like "works correctly".
- Any task that adds or modifies a user-input surface (form, mutation endpoint, command/argument parsing) must include at least one acceptanceCriteria for the invalid or empty-input path, phrased as graceful behavior (inline error message or 4xx response), never an unhandled crash.
- When a flow mutates persisted state, prefer a shape the verifier can probe later (an HTTP-reachable endpoint or a unit-testable pure function) over logic that no command or browser check can observe.${mlMethodologyGuidance()}`;
}

function extractJsonObject(text: string): string | null {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }
  return text.slice(firstBrace, lastBrace + 1);
}

function extractMarkedJsonObject(text: string): string | null {
  const start = text.indexOf("PLAN_JSON_START");
  const end = text.indexOf("PLAN_JSON_END");
  if (start === -1 || end === -1 || end <= start) {
    return extractJsonObject(text);
  }
  return extractJsonObject(text.slice(start, end));
}

function normalizePlan(value: unknown, analysis: WorkspaceAnalysis): PlanJson | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const tasks = Array.isArray(candidate.tasks)
    ? candidate.tasks
      .map(normalizeTask)
      .filter((task): task is PlanTaskInput => task !== null && task.taskKind !== "verify")
    : [];
  if (typeof candidate.title !== "string" || typeof candidate.goal !== "string" || tasks.length === 0) {
    return null;
  }
  return sanitizePlanForOperator({
    schemaVersion: 2,
    title: candidate.title,
    goal: candidate.goal,
    targetStack: isAllowedTargetStack(candidate.targetStack)
      && !(candidate.targetStack === "python-ml" && !getConfig().mlPipelineEnabled)
      ? candidate.targetStack
      : undefined,
    stackRationale: typeof candidate.stackRationale === "string" && candidate.stackRationale.trim().length > 0
      ? candidate.stackRationale.trim().slice(0, 240)
      : undefined,
    risks: stringArray(candidate.risks),
    verificationCommands: stringArray(candidate.verificationCommands),
    workspace: workspaceAnalysisToJson(analysis),
    tasks,
  });
}

function steeringPromptBlock(steeringNote: string): string {
  const note = steeringNote.trim();
  return note.length > 0 ? `\n\nUser steering preferences (honor unless they conflict with the rules above):\n${note}` : "";
}

function researchContextPromptBlock(priorResearchContext: string): string {
  const context = priorResearchContext.trim();
  if (context.length === 0) {
    return "";
  }
  return `\n\n${context}

Research-context rules:
- The user is referring to prior research. Treat the above research context as source material for the implementation plan.
- The plan must name concrete researched concepts, behaviors, domain objects, and user-facing surfaces instead of saying only "the researched app".
- If creating a simplified version, preserve the researched app's core concept while deliberately reducing scope.`;
}

function planLooksResearchGeneric(plan: PlanJson, priorResearchContext: string): boolean {
  if (priorResearchContext.trim().length === 0) {
    return false;
  }
  const text = [
    plan.title,
    plan.goal,
    ...plan.risks,
    ...plan.tasks.flatMap((task) => [
      task.title,
      task.description,
      task.objective ?? "",
      ...(task.expectedChanges ?? []),
      ...(task.acceptanceCriteria ?? []),
    ]),
  ].join("\n").toLowerCase();
  const genericHits = (text.match(/researched app|researched concept|core workflow|core purpose/g) ?? []).length;
  const specificHints = [
    "civilization",
    "simulation",
    "agent",
    "resource",
    "timeline",
    "canvas",
    "world",
    "tick",
    "seed",
    "branching",
    "sync",
  ].filter((hint) => text.includes(hint)).length;
  return genericHits > 0 && specificHints < 2;
}

function researchPlanReminder(priorResearchContext: string): string {
  return priorResearchContext
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) =>
      line.length > 0 &&
      !line.startsWith("- Research artifact") &&
      !line.startsWith("Relevant prior research context") &&
      !line.startsWith("Full research report excerpt")
    )
    .slice(0, 14)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 1400);
}

function attachResearchReminder(plan: PlanJson, priorResearchContext: string): PlanJson {
  const reminder = researchPlanReminder(priorResearchContext);
  if (reminder.length === 0) {
    return plan;
  }
  return {
    ...plan,
    goal: `${plan.goal}\n\nPrior research context to preserve: ${reminder}`,
    risks: Array.from(new Set([
      ...plan.risks,
      "This is a follow-up to prior research; implementation must preserve the researched app's concrete domain model and user-facing behavior, not a generic placeholder workflow.",
    ])),
    tasks: plan.tasks.map((task) => ({
      ...task,
      expectedChanges: Array.from(new Set([
        ...(task.expectedChanges ?? []),
        `Use the prior research context when choosing content, labels, sample data, interactions, and visual structure: ${reminder}`,
      ])),
      acceptanceCriteria: Array.from(new Set([
        ...task.acceptanceCriteria,
        "The result includes concrete concepts from the prior research rather than generic references to a researched app.",
      ])),
    })),
  };
}

async function createCodexCliPlan(userRequest: string, analysis: WorkspaceAnalysis, steeringNote: string, priorResearchContext: string, imagePaths: string[] = []): Promise<PlanJson> {
  const config = getConfig();
  const executable = await resolveCodexCliBin();
  const systemPrompt = `You are the planning stage inside a closed development loop.
Create a concrete implementation plan only. Do not edit files, run commands, install packages, or start servers.
Return the plan JSON between PLAN_JSON_START and PLAN_JSON_END markers.

Required JSON shape:
{ "schemaVersion": 2, "title": string, "goal": string, "targetStack": ${targetStackEnumText}, "stackRationale": string, "risks": string[], "verificationCommands": string[], "tasks": [{ "title": string, "objective": string, "taskKind": "create"|"modify"|"wire"|"style"|"handoff", "targetFiles": string[], "expectedChanges": string[], "acceptanceCriteria": string[], "verificationHints": string[], "riskLevel": "low"|"medium"|"high" }] }

Rules:
- Do not create generic tasks like "Inspect current workspace" or "Implement the requested change".
- Inspection has already happened.
- Tasks must name concrete files whenever possible.
- Do not create a verification task. The orchestrator runs formal verification after implementation tasks.
- Use workspaceAnalysis.stack/appType to choose framework-specific files. Do not assume Next.js when the analyzed stack is Node, Python, Vite, or static HTML.
- For stack="static-html" or productShape="static-frontend", plan a front-end-only browser page using index.html, styles.css, and script.js. Do not add package.json, Next.js, React, Vite, backend routes, or server code unless the user explicitly requested that framework/runtime.
- Use workspaceAnalysis.productShape and workspaceAnalysis.pythonMode to distinguish Python scripts from Python web apps:
  - pythonMode="script" or productShape="data-visualization"/"generated-report"/"script": plan a standalone script/report with an entrypoint such as main.py.
  - pythonMode="web" or productShape="fullstack-web"/"server-rendered-web": plan a real Python web app with backend routes plus browser-facing frontend files.
  - For Python full-stack/web work, tasks must target both backend files (for example app.py/manage.py) and frontend files (templates/*.html and static CSS/JS, or the framework equivalent). Do not collapse a Python web app into only main.py or a single inline HTML string.
  - For Python web stacks, do not add package.json, src/index.js, or Node verification shell files unless the user explicitly asks for Node tooling or a JavaScript build step.
  - For Django apps, preserve a runnable development settings baseline: pathlib Path/BASE_DIR, concrete DATABASES default backend, TEMPLATES, STATIC_URL/staticfiles wiring, and any installed app entries needed by models or assets.
  - For FastAPI/ASGI apps, keep app.py importable as app:app, put browser UI in templates/static when HTML is requested, declare fastapi + uvicorn + jinja2 when using Jinja2Templates, and prefer the base uvicorn package unless optional uvicorn extras are explicitly needed.
- For stack="r-script" (R script / visualization / report), plan a standalone R program with an entrypoint named main.R that produces plots or printed output. Explicitly print() or ggsave() any plot you want visible — a ggplot object only renders when printed. Declare CRAN package dependencies in a DESCRIPTION file under an Imports: field (one package per line). Do not add package.json, Python files, or a web server.
- For stack="r-shiny" (interactive Shiny web app), plan a Shiny app whose entrypoint is app.R ending in a shinyApp(ui, server) object (or split ui.R + server.R). Put reactive logic in the server function and inputs/outputs in the UI; place static assets under www/. Declare shiny (plus any other CRAN packages) in DESCRIPTION Imports. The orchestrator starts the app via shiny::runApp(host, port) — do not call runApp() at the top level, hardcode a port, or set launch.browser=TRUE. Do not collapse a Shiny app into a non-reactive script.
- For stack="csharp" and productShape="server-rendered-web"/browser page/form requests, plan ASP.NET Core Razor Pages around Program.cs, Pages/*.cshtml, Pages/*.cshtml.cs, Pages/_ViewImports.cshtml, and wwwroot assets. Program.cs must register AddRazorPages(), use static files when assets exist, and map MapRazorPages().
- For ASP.NET Core Razor Pages, put PageModel classes in the matching project .Pages namespace, include Microsoft.AspNetCore.Mvc.RazorPages for PageModel, and include Microsoft.AspNetCore.Mvc when using BindProperty, IActionResult, validation, or Page().
- For ASP.NET Core Razor Pages that use asp-* tag helpers or ~/ asset paths, include Pages/_ViewImports.cshtml with @namespace <ProjectName>.Pages and @addTagHelper *, Microsoft.AspNetCore.Mvc.TagHelpers. Do not use @model IndexModel without either that namespace/import wiring or a fully qualified model type.
- For C# API-only requests, keep minimal API/JSON endpoint style and do not add Razor Pages unless browser/server-rendered output is requested.
- For stack="php" and explicit Laravel requests, plan a minimal server-rendered Laravel app around composer.json, public/index.php, bootstrap/app.php, routes/web.php, resources/views/**/*.blade.php, public assets, and storage files. Mutating Blade forms must include @csrf. Avoid Composer post-autoload/post-update artisan hooks in generated minimal apps; the orchestrator runs composer install separately. Do not plan ad hoc duplicate service-provider/exception-handler bindings unless the target files already establish that pattern.
- Preserve existing scaffold asset paths and file conventions unless the request explicitly asks to change them.
- For dependency tasks, name exact npm package specs in expectedChanges using quoted or backticked package names, separate runtime dependencies from dev/type dependencies, and avoid version ranges that require changing existing framework/runtime dependencies unless the task explicitly includes those upgrades.

${plannerOutputRules()}`;
  const prompt = `${systemPrompt}

User request:
${userRequest}

Workspace analysis:
${JSON.stringify(workspaceAnalysisToJson(analysis), null, 2)}

Configured verification commands:
${analysis.verificationCommands.join("\n") || "No verification commands configured."}${researchContextPromptBlock(priorResearchContext)}${steeringPromptBlock(steeringNote)}`;
  const readOnlySandbox = resolveCodexReadOnlySandbox();
  const beforeSnapshot = readOnlySandbox.enforceNoChanges ? await snapshotWorkspace(analysis.workspacePath) : null;
  const args = [
    "exec",
    "--cd",
    analysis.workspacePath,
    ...codexReadOnlySandboxArgs(readOnlySandbox),
    "-c",
    'approval_policy="never"',
    "--skip-git-repo-check",
    "--color",
    "never",
    ...imagePaths.flatMap((imagePath) => ["-i", imagePath]),
    ...config.codexExtraArgs,
    "-",
  ];
  const result = await runProcess({
    command: executable.command,
    args,
    cwd: analysis.workspacePath,
    timeoutMs: config.plannerTimeoutMs,
    stdin: prompt,
    env: createSanitizedProcessEnv({
      ...codexReadOnlySandboxEnv(readOnlySandbox),
      CODEX_APPROVAL_POLICY: "never",
      CI: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    }),
  });
  if (beforeSnapshot !== null) {
    const afterSnapshot = await snapshotWorkspace(analysis.workspacePath);
    const changes = await compareWorkspaceSnapshots({ workspacePath: analysis.workspacePath, before: beforeSnapshot, after: afterSnapshot });
    if (changes.length > 0) {
      throw new Error(summarizeReadOnlyWorkspaceChanges(changes));
    }
  }
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(result.stderr || result.stdout || "Codex CLI planner failed without output.");
  }
  const jsonText = extractMarkedJsonObject(`${result.stdout}\n${result.stderr}`);
  if (jsonText === null) {
    throw new Error("Codex CLI planner did not return marked JSON.");
  }
  const plan = normalizePlan(JSON.parse(jsonText) as unknown, analysis);
  if (plan === null) {
    throw new Error("Codex CLI planner returned JSON that does not match PlanJson v2.");
  }
  if (isWeakPlan(plan)) {
    throw new Error("Codex CLI planner returned a generic or target-free plan.");
  }
  return plan;
}

function stripReasoningBlocks(text: string): string {
  const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const lastClose = withoutBlocks.toLowerCase().lastIndexOf("</think>");
  const tail = lastClose === -1 ? withoutBlocks : withoutBlocks.slice(lastClose + "</think>".length);
  return tail.replace(/<\/?think>/gi, "").trim();
}

function ollamaPlannerRepairBlock(rejectionReason: string, previousJson: string | null): string {
  const previous = previousJson !== null
    ? `\n\nYour previous answer (fix it; do not repeat the mistake):\n${previousJson.slice(0, 800)}`
    : "";
  return `\n\nThe previous attempt was rejected for this reason: ${rejectionReason}
Return a corrected JSON object that resolves every issue. It must satisfy all of these:
- Each task specifies at least 2 concrete expectedChanges and at least 2 verifiable acceptanceCriteria.
- Each task names at least one concrete targetFile (unless its taskKind is "handoff").
- Use taskKind "create" for files that do not exist yet in the workspace.
Respond with the corrected JSON object only, no prose, no markdown fences.${previous}`;
}

async function createOllamaPlan(userRequest: string, analysis: WorkspaceAnalysis, steeringNote: string, priorResearchContext: string, model: string): Promise<PlanJson> {
  const config = getConfig();
  const system = `You are a senior software planning agent. Return only valid JSON for a concrete implementation plan.
Use schemaVersion 2 and this shape:
{ "schemaVersion": 2, "title": string, "goal": string, "targetStack": ${targetStackEnumText}, "stackRationale": string, "risks": string[], "verificationCommands": string[], "tasks": [{ "title": string, "objective": string, "taskKind": "create"|"modify"|"wire"|"style"|"handoff", "targetFiles": string[], "expectedChanges": string[], "acceptanceCriteria": string[], "verificationHints": string[], "riskLevel": "low"|"medium"|"high" }] }
Do not create generic tasks like "Inspect current workspace" or "Implement the requested change". Inspection has already happened. Tasks must name concrete files whenever possible.
Do not create a verification task. The orchestrator runs formal verification after implementation tasks.
Respond with the JSON object only, no prose, no markdown fences.
${plannerOutputRules()}`;
  const baseUser = `User request:
${userRequest}

Workspace analysis:
${JSON.stringify(workspaceAnalysisToJson(analysis), null, 2)}

Configured verification commands:
${analysis.verificationCommands.join("\n") || "No verification commands configured."}${researchContextPromptBlock(priorResearchContext)}${steeringPromptBlock(steeringNote)}`;

  const maxAttempts = Math.max(1, config.ollamaPlannerMaxAttempts);
  const timeoutSeconds = Math.round(config.plannerTimeoutMs / 1000);
  let rejectionReason = "Ollama planner did not return a JSON object.";
  let previousJson: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const user = attempt === 1 ? baseUser : `${baseUser}${ollamaPlannerRepairBlock(rejectionReason, previousJson)}`;
    const startedAt = Date.now();
    let result: Awaited<ReturnType<ReturnType<typeof createOllamaClient>["chat"]>>;
    try {
      result = await createOllamaClient().chat(
        model,
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        { temperature: 0.1, numCtx: config.ollamaPlannerNumCtx, timeoutMs: config.plannerTimeoutMs },
      );
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : typeof caught === "string" ? caught : String(caught);
      logProcess("warn", "planner.ollama.attempt", { attempt, maxAttempts, model, outcome: "transport_error", ms: Date.now() - startedAt, detail });
      throw new Error(`Ollama planner request did not complete within ${timeoutSeconds}s on attempt ${attempt} (${detail}). The model may need a larger context window (set OLLAMA_PLANNER_NUM_CTX, e.g. 8192) or a smaller retry budget (OLLAMA_PLANNER_MAX_ATTEMPTS).`);
    }
    const elapsedMs = Date.now() - startedAt;

    const jsonText = extractJsonObject(stripReasoningBlocks(result.content));
    if (jsonText === null) {
      rejectionReason = "Ollama planner did not return a JSON object.";
      previousJson = null;
      logProcess("warn", "planner.ollama.attempt", { attempt, maxAttempts, model, outcome: "no_json", ms: elapsedMs, promptTokens: result.usage?.promptTokens ?? null, outputTokens: result.usage?.outputTokens ?? null });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText) as unknown;
    } catch {
      rejectionReason = "Ollama planner returned invalid JSON.";
      previousJson = jsonText;
      logProcess("warn", "planner.ollama.attempt", { attempt, maxAttempts, model, outcome: "invalid_json", ms: elapsedMs });
      continue;
    }
    const plan = normalizePlan(parsed, analysis);
    if (plan === null) {
      rejectionReason = "Ollama planner returned JSON that does not match PlanJson v2.";
      previousJson = jsonText;
      logProcess("warn", "planner.ollama.attempt", { attempt, maxAttempts, model, outcome: "schema_mismatch", ms: elapsedMs });
      continue;
    }
    if (isWeakPlan(plan)) {
      rejectionReason = "Ollama planner returned a generic or target-free plan.";
      previousJson = jsonText;
      logProcess("warn", "planner.ollama.attempt", { attempt, maxAttempts, model, outcome: "weak_plan", ms: elapsedMs });
      continue;
    }
    const qualityError = planQualityError(userRequest, plan);
    if (qualityError !== null) {
      rejectionReason = qualityError;
      previousJson = jsonText;
      logProcess("warn", "planner.ollama.attempt", { attempt, maxAttempts, model, outcome: "quality_gate", ms: elapsedMs, reason: qualityError });
      continue;
    }
    logProcess("info", "planner.ollama.attempt", { attempt, maxAttempts, model, outcome: "accepted", ms: elapsedMs, taskCount: plan.tasks.length });
    return plan;
  }

  throw new Error(rejectionReason);
}

async function createClaudeCodePlan(userRequest: string, analysis: WorkspaceAnalysis, steeringNote: string, priorResearchContext: string, model: string | null, reasoningEffort: string | null): Promise<PlanJson> {
  const config = getConfig();
  const executable = await resolveClaudeCodeBin();
  const allowExploration = config.claudePlannerAllowExploration;
  const system = `You are a senior software planning agent. Return only valid JSON for a concrete implementation plan.
Use schemaVersion 2 and this shape:
{ "schemaVersion": 2, "title": string, "goal": string, "targetStack": ${targetStackEnumText}, "stackRationale": string, "risks": string[], "verificationCommands": string[], "tasks": [{ "title": string, "objective": string, "taskKind": "create"|"modify"|"wire"|"style"|"handoff", "targetFiles": string[], "expectedChanges": string[], "acceptanceCriteria": string[], "verificationHints": string[], "riskLevel": "low"|"medium"|"high" }] }
Do not create generic tasks like "Inspect current workspace" or "Implement the requested change". Inspection has already happened. Tasks must name concrete files whenever possible.
Do not create a verification task. The orchestrator runs formal verification after implementation tasks.
${allowExploration ? "" : "Do not explore or read the workspace; the workspace analysis below is authoritative and complete. Emit the plan JSON immediately.\n"}Respond with the JSON object only, no prose, no markdown fences.
${plannerOutputRules()}`;
  const prompt = `${system}

User request:
${userRequest}

Workspace analysis:
${JSON.stringify(workspaceAnalysisToJson(analysis), null, 2)}

Configured verification commands:
${analysis.verificationCommands.join("\n") || "No verification commands configured."}${researchContextPromptBlock(priorResearchContext)}${steeringPromptBlock(steeringNote)}`;
  const args = [
    "-p",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    allowExploration ? "plan" : "bypassPermissions",
    "--tools",
    allowExploration ? "Read,Glob,Grep" : "",
  ];
  if (config.claudeBare) {
    args.push("--bare");
  }
  const requestedModel = model?.trim() ? model.trim() : config.claudeModel.trim() || null;
  const requestedEffort = reasoningEffort?.trim() ? reasoningEffort.trim() : config.claudeEffort.trim() || null;
  const validatedRuntime = await validateClaudeModelEffort({ model: requestedModel, reasoningEffort: requestedEffort });
  if (validatedRuntime.model !== null) {
    args.push("--model", validatedRuntime.model);
  }
  if (validatedRuntime.reasoningEffort !== null) {
    args.push("--effort", validatedRuntime.reasoningEffort);
  }
  args.push(...config.claudeExtraArgs);
  const result = await runProcess({
    command: executable.command,
    args,
    cwd: analysis.workspacePath,
    timeoutMs: config.plannerTimeoutMs,
    stdin: prompt,
    env: createSanitizedProcessEnv({ CI: "true", NEXT_TELEMETRY_DISABLED: "1" }),
  });
  const telemetry = parseClaudeStreamJson(result.stdout);
  if (result.timedOut) {
    throw new Error(`Claude Code planner timed out after ${config.plannerTimeoutMs}ms before returning a plan${telemetry.resultSubtype !== null ? ` (last result: ${telemetry.resultSubtype})` : " (no result event)"}.`);
  }
  if (telemetry.apiErrorStatus !== null) {
    throw new Error(`Claude Code planner hit a provider API error (${telemetry.apiErrorStatus})${telemetry.rateLimitDetail !== null ? ` [${telemetry.rateLimitDetail}]` : ""}; this is a transient backend condition, not a plan defect.`);
  }
  const finalText = telemetry.summary;
  if (finalText === null || finalText.trim().length === 0) {
    const detail = result.stderr.trim()
      || (result.exitCode !== 0 ? `exit code ${result.exitCode}` : telemetry.resultSubtype !== null ? `result ${telemetry.resultSubtype}` : "no result event");
    throw new Error(`Claude Code planner produced no plan output (${detail}).`);
  }
  const jsonText = extractJsonObject(finalText);
  if (jsonText === null) {
    throw new Error(`Claude Code planner did not return a JSON object. Final message: ${finalText.slice(0, 200)}`);
  }
  const plan = normalizePlan(JSON.parse(jsonText) as unknown, analysis);
  if (plan === null) {
    throw new Error("Claude Code planner returned JSON that does not match PlanJson v2.");
  }
  if (isWeakPlan(plan)) {
    throw new Error("Claude Code planner returned a generic or target-free plan.");
  }
  return plan;
}

function agyPrintTimeoutArg(timeoutMs: number): string {
  return `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;
}

async function writeAgyPlannerPrompt(workspacePath: string, prompt: string): Promise<string> {
  const dir = path.join(workspacePath, ".orchestrator");
  await mkdir(dir, { recursive: true });
  const fileName = `agy-plan-prompt-${Date.now()}.md`;
  await writeFile(path.join(dir, fileName), prompt, "utf8");
  return `.orchestrator/${fileName}`;
}

async function readAgyPlanOutput(workspacePath: string, fileName: string): Promise<string | null> {
  const candidates = [
    path.join(workspacePath, ".orchestrator", fileName),
    path.join(path.dirname(path.dirname(workspacePath)), ".orchestrator", fileName),
  ];
  for (const candidate of candidates) {
    try {
      const content = await readFile(candidate, "utf8");
      const jsonText = extractMarkedJsonObject(content);
      if (jsonText !== null && jsonText.trim().length > 0) {
        return jsonText;
      }
    } catch {
    }
  }
  return null;
}

async function createAgyPlan(userRequest: string, analysis: WorkspaceAnalysis, steeringNote: string, priorResearchContext: string, model: string | null): Promise<PlanJson> {
  const config = getConfig();
  const executable = await resolveAgyCliBin();
  const modelApplication = await applyAgyRuntimeModel(model);
  if (modelApplication.error !== null) {
    throw new Error(`AGY model selection failed before planner launch: ${modelApplication.error}`);
  }
  const system = `You are a senior software planning agent. Return only valid JSON for a concrete implementation plan.
Use schemaVersion 2 and this shape:
{ "schemaVersion": 2, "title": string, "goal": string, "targetStack": ${targetStackEnumText}, "stackRationale": string, "risks": string[], "verificationCommands": string[], "tasks": [{ "title": string, "objective": string, "taskKind": "create"|"modify"|"wire"|"style"|"handoff", "targetFiles": string[], "expectedChanges": string[], "acceptanceCriteria": string[], "verificationHints": string[], "riskLevel": "low"|"medium"|"high" }] }
Do not create generic tasks like "Inspect current workspace" or "Implement the requested change". Inspection has already happened. Tasks must name concrete files whenever possible.
Do not create a verification task. The orchestrator runs formal verification after implementation tasks.
Do not run commands, install packages, start servers, or create background subagents. The only file you may write is the plan output file specified in the output instructions below; do not edit any project files.
${plannerOutputRules()}`;
  const outputFileName = `agy-plan-output-${Date.now()}.json`;
  const outputPath = path.join(analysis.workspacePath, ".orchestrator", outputFileName);
  const prompt = `${system}

User request:
${userRequest}

Workspace analysis:
${JSON.stringify(workspaceAnalysisToJson(analysis), null, 2)}

Configured verification commands:
${analysis.verificationCommands.join("\n") || "No verification commands configured."}${researchContextPromptBlock(priorResearchContext)}${steeringPromptBlock(steeringNote)}

Output instructions (required):
Write the plan as a single JSON object to this exact file using your file-writing tool:
${outputPath}
Wrap the JSON object between the markers PLAN_JSON_START and PLAN_JSON_END inside that file. Create the file if it does not exist and overwrite it if it does. Do not print the plan to the terminal and do not edit any other file.`;
  const promptPath = await writeAgyPlannerPrompt(analysis.workspacePath, prompt);
  const promptAbsPath = path.join(analysis.workspacePath, promptPath);
  const launcherPrompt = `Read the file at ${promptAbsPath} and follow its instructions exactly. Write only the requested JSON object to ${outputPath}. Do not edit any other files.`;
  const timeoutMs = config.plannerTimeoutMs;
  const args = [
    "--add-dir",
    analysis.workspacePath,
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
  const result = await runProcess({
    command: executable.command,
    args,
    cwd: analysis.workspacePath,
    timeoutMs: timeoutMs + 15_000,
    env: createSanitizedProcessEnv({
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      CI: "true",
      NEXT_TELEMETRY_DISABLED: "1",
    }),
  });
  let jsonText = await readAgyPlanOutput(analysis.workspacePath, outputFileName);
  if (jsonText === null) {
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(result.stderr || result.stdout || "AGY planner failed without output.");
    }
    const output = `${result.stdout}\n${result.stderr}`;
    jsonText = extractMarkedJsonObject(output);
    if (jsonText === null) {
      throw new Error(output.trim().length > 0 ? "AGY planner did not return a JSON object." : "AGY planner returned no output.");
    }
  }
  const plan = normalizePlan(JSON.parse(jsonText) as unknown, analysis);
  if (plan === null) {
    throw new Error("AGY planner returned JSON that does not match PlanJson v2.");
  }
  if (isWeakPlan(plan)) {
    throw new Error("AGY planner returned a generic or target-free plan.");
  }
  return plan;
}

export interface PlanGenerationResult {
  planJson: PlanJson;
  planMarkdown: string;
  createdByAgent: string;
}

function filterPlanBuildCommands(plan: PlanJson, allowBuild: boolean): PlanJson {
  return {
    ...plan,
    verificationCommands: filterBuildVerificationCommands(plan.verificationCommands, { allowBuild }),
    tasks: plan.tasks.map((task) => ({
      ...task,
      verificationHints: filterBuildVerificationCommands(task.verificationHints ?? [], { allowBuild }),
    })),
  };
}

function planIntentText(plan: PlanJson, options: { includeGoal: boolean }): string {
  const headingText = options.includeGoal ? [plan.title, plan.goal] : [];
  return [
    ...headingText,
    ...plan.tasks.flatMap((task) => [
      task.title,
      task.description,
      task.objective ?? "",
      ...(task.targetFiles ?? []),
      ...(task.expectedChanges ?? []),
      ...(task.acceptanceCriteria ?? []),
      ...(task.verificationHints ?? []),
    ]),
  ].join("\n");
}

function assertPlanCoversRequest(userRequest: string, plan: PlanJson): void {
  const coverage = validateRequestIntentCoverage(userRequest, planIntentText(plan, { includeGoal: false }), { mode: "plan" });
  if (!coverage.applicable || coverage.passed) {
    return;
  }
  const blockingMessages = coverage.messages.filter((message) => !message.startsWith("Missing quoted request anchor:"));
  if (blockingMessages.length === 0) {
    return;
  }
  throw new Error(`Generated plan does not preserve the original request intent: ${blockingMessages.join(" ")}`);
}

function minimumConcreteTaskCount(userRequest: string): number {
  if (isBrowserGameRequest(userRequest)) {
    return 4;
  }
  if (hasComplexAppScope(userRequest)) {
    return 3;
  }
  return 1;
}

function assertPlanDepthMatchesRequest(userRequest: string, plan: PlanJson): void {
  const minimumTaskCount = minimumConcreteTaskCount(userRequest);
  if (plan.tasks.length < minimumTaskCount) {
    throw new Error(`Generated plan is too shallow for the request scope: expected at least ${minimumTaskCount} concrete implementation tasks, got ${plan.tasks.length}.`);
  }
  const thinTasks = plan.tasks.filter((task) =>
    (task.expectedChanges ?? []).length < 2 ||
    task.acceptanceCriteria.length < 2 ||
    ((task.targetFiles ?? []).length === 0 && (task.taskKind ?? "modify") !== "handoff")
  );
  if (thinTasks.length > 0) {
    throw new Error(`Generated plan has under-specified tasks: ${thinTasks.map((task) => task.title).join(", ")}.`);
  }
}

function assertPlanQuality(userRequest: string, plan: PlanJson): void {
  assertPlanCoversRequest(userRequest, plan);
  assertPlanDepthMatchesRequest(userRequest, plan);
}

function planQualityError(userRequest: string, plan: PlanJson): string | null {
  try {
    assertPlanQuality(userRequest, plan);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function planningFailed(provider: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : `Unknown ${provider} planning error`;
  return new Error(`${provider} planning failed. No substitute plan was created because substituting a generic plan can produce the wrong app. Resolve the planner error or switch the planner provider explicitly. Cause: ${message}`);
}

function planGenerationResult(planJson: PlanJson, createdByAgent: string, userRequest: string): PlanGenerationResult {
  const sanitized = filterPlanBuildCommands(sanitizePlanForOperator(planJson), userExplicitlyRequestedBuildVerification(userRequest));
  return {
    planJson: sanitized,
    planMarkdown: planToMarkdown(sanitized),
    createdByAgent,
  };
}

export async function generatePlan(input: { userRequest: string; workspaceAnalysis: WorkspaceAnalysis; steeringNote?: string; priorResearchContext?: string; provider?: AgentProvider; ollamaModel?: string | null; claudeModel?: string | null; claudeEffort?: string | null; agyModel?: string | null; imagePaths?: string[] }): Promise<PlanGenerationResult> {
  const config = getConfig();
  const steeringNote = input.steeringNote ?? "";
  const priorResearchContext = input.priorResearchContext ?? "";
  const effectiveProvider = input.provider ?? config.agentProvider;

  if (effectiveProvider === "ollama") {
    const model = (input.ollamaModel ?? "").trim().length > 0 ? (input.ollamaModel as string).trim() : config.ollamaModel.trim();
    if (model.length > 0) {
      try {
        const planJson = await createOllamaPlan(input.userRequest, input.workspaceAnalysis, steeringNote, priorResearchContext, model);
        if (planLooksResearchGeneric(planJson, priorResearchContext)) {
          throw new Error("Planner produced a generic research follow-up plan without concrete researched concepts.");
        }
        const planWithResearch = attachResearchReminder(planJson, priorResearchContext);
        assertPlanQuality(input.userRequest, planWithResearch);
        return planGenerationResult(planWithResearch, "ollama-planner", input.userRequest);
      } catch (error) {
        throw planningFailed("Ollama", error);
      }
    }
    throw new Error("Ollama planning failed. No Ollama model is configured for this session, and no substitute plan was created because substituting a generic plan can produce the wrong app.");
  }

  if (effectiveProvider === "claude-code") {
    try {
      const planJson = await createClaudeCodePlan(input.userRequest, input.workspaceAnalysis, steeringNote, priorResearchContext, input.claudeModel ?? null, input.claudeEffort ?? null);
      if (planLooksResearchGeneric(planJson, priorResearchContext)) {
        throw new Error("Planner produced a generic research follow-up plan without concrete researched concepts.");
      }
      const planWithResearch = attachResearchReminder(planJson, priorResearchContext);
      assertPlanQuality(input.userRequest, planWithResearch);
      return planGenerationResult(planWithResearch, "claude-code-planner", input.userRequest);
    } catch (error) {
      throw planningFailed("Claude Code", error);
    }
  }

  if (effectiveProvider === "antigravity-cli") {
    try {
      const planJson = await createAgyPlan(input.userRequest, input.workspaceAnalysis, steeringNote, priorResearchContext, input.agyModel ?? null);
      if (planLooksResearchGeneric(planJson, priorResearchContext)) {
        throw new Error("Planner produced a generic research follow-up plan without concrete researched concepts.");
      }
      const planWithResearch = attachResearchReminder(planJson, priorResearchContext);
      assertPlanQuality(input.userRequest, planWithResearch);
      return planGenerationResult(planWithResearch, "antigravity-cli-planner", input.userRequest);
    } catch (error) {
      throw planningFailed("AGY", error);
    }
  }

  if (effectiveProvider === "codex-cli" || config.plannerProvider === "codex-cli") {
    try {
      const planJson = await createCodexCliPlan(input.userRequest, input.workspaceAnalysis, steeringNote, priorResearchContext, input.imagePaths ?? []);
      if (planLooksResearchGeneric(planJson, priorResearchContext)) {
        throw new Error("Planner produced a generic research follow-up plan without concrete researched concepts.");
      }
      const planWithResearch = attachResearchReminder(planJson, priorResearchContext);
      assertPlanQuality(input.userRequest, planWithResearch);
      return planGenerationResult(planWithResearch, "codex-cli-planner", input.userRequest);
    } catch (error) {
      throw planningFailed("Codex CLI", error);
    }
  }

  throw new Error(`Planner provider ${config.plannerProvider} is not available for this session. No plan was created. Choose a supported planner provider explicitly.`);
}
