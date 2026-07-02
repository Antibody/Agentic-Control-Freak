import type { PlanJson, PlanTaskInput, PlanTaskKind, RiskLevel } from "@/lib/shared/types";

export const PLAN_TASK_KINDS: PlanTaskKind[] = ["inspect", "create", "modify", "wire", "style", "verify", "handoff"];
export const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high"];
const DISPLAY_GOAL_MAX = 220;
const PLAN_TITLE_MAX = 72;
const TASK_TITLE_MAX = 96;
const TASK_OBJECTIVE_MAX = 320;
const LIST_ITEM_MAX = 240;
const MAX_RISKS = 5;
const MAX_TASK_LIST_ITEMS = 5;

export const EDITABLE_TASK_KINDS: PlanTaskKind[] = ["inspect", "create", "modify", "wire", "style"];

const genericTaskTitles = new Set([
  "inspect current workspace for the requested change",
  "implement the requested change",
  "integrate and polish the implementation",
  "run targeted self-checks before formal verification",
  "prepare final handoff",
]);

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function limitText(value: string, maxLength: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function stripPlannerSourceContext(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split(/\n\s*(?:Attached files from the user:|Attachment context:|Workspace analysis:|Configured verification commands:)\s*\n/i)[0]
    .replace(/\n\s*Prior research context to preserve:.*$/is, "")
    .trim();
}

function firstUsefulSentence(value: string): string {
  const normalized = collapseWhitespace(stripPlannerSourceContext(value));
  if (normalized.length === 0) {
    return "";
  }
  const sentence = normalized.match(/^.{40,}?[.!?](?:\s|$)/);
  return sentence?.[0]?.trim() ?? normalized;
}

function sanitizeList(values: string[], maxItems: number): string[] {
  return values
    .map((entry) => limitText(stripPlannerSourceContext(entry), LIST_ITEM_MAX))
    .filter((entry) => entry.length > 0)
    .slice(0, maxItems);
}

function sanitizeTargetFiles(values: string[] | undefined): string[] {
  return Array.from(new Set((values ?? [])
    .map((entry) => collapseWhitespace(entry))
    .filter((entry) => entry.length > 0 && !/^attached files from the user:?$/i.test(entry))
    .slice(0, 12)));
}

export function concisePlanGoal(value: string): string {
  const useful = firstUsefulSentence(value);
  return useful.length > 0 ? limitText(useful, DISPLAY_GOAL_MAX) : "Implement the requested change.";
}

export function concisePlanTitle(title: string, fallbackGoal: string): string {
  const source = title.trim().length > 0 ? title : fallbackGoal;
  const stripped = stripPlannerSourceContext(source);
  return limitText(stripped.length > 0 ? stripped : "Implementation plan", PLAN_TITLE_MAX);
}

function listBlock(title: string, values: string[]): string {
  if (values.length === 0) {
    return "";
  }
  return `\n   ${title}:\n${values.map((value) => `   - ${value}`).join("\n")}`;
}

export function planToMarkdown(plan: PlanJson): string {
  const risks = plan.risks.map((risk) => `- ${risk}`).join("\n");
  const tasks = plan.tasks
    .map((task, index) => {
      const criteria = task.acceptanceCriteria.map((criterion) => `   - ${criterion}`).join("\n");
      return `${index + 1}. ${task.title}
   Kind: ${task.taskKind ?? "modify"} | Risk: ${task.riskLevel ?? "low"}
   ${task.objective ?? task.description}${listBlock("Target files", task.targetFiles ?? [])}${listBlock("Expected changes", task.expectedChanges ?? [])}
   Acceptance criteria:
${criteria}`;
    })
    .join("\n\n");
  const commands = plan.verificationCommands.length > 0 ? plan.verificationCommands.map((command) => `- ${command}`).join("\n") : "- No verification commands configured. The verification engine will record a pass-through note.";

  return `# ${plan.title}

## Goal
${plan.goal}

## Workspace
- Type: ${typeof plan.workspace?.appType === "string" ? plan.workspace.appType : "unknown"}
- Stack: ${typeof plan.workspace?.stack === "string" ? plan.workspace.stack : "unknown"}
- Important files: ${Array.isArray(plan.workspace?.importantFiles) ? plan.workspace.importantFiles.join(", ") || "none" : "none"}

## Risks
${risks}

## Tasks
${tasks}

## Verification
${commands}
`;
}

export function normalizeTask(value: unknown): PlanTaskInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.title !== "string") {
    return null;
  }
  const objective = typeof candidate.objective === "string"
    ? candidate.objective
    : typeof candidate.description === "string"
      ? candidate.description
      : "";
  const acceptanceCriteria = stringArray(candidate.acceptanceCriteria);
  if (objective.length === 0 || acceptanceCriteria.length === 0) {
    return null;
  }
  const taskKind = typeof candidate.taskKind === "string" && PLAN_TASK_KINDS.includes(candidate.taskKind as PlanTaskKind)
    ? candidate.taskKind as PlanTaskInput["taskKind"]
    : "modify";
  const riskLevel = typeof candidate.riskLevel === "string" && RISK_LEVELS.includes(candidate.riskLevel as RiskLevel)
    ? candidate.riskLevel as PlanTaskInput["riskLevel"]
    : "low";

  return {
    title: limitText(stripPlannerSourceContext(candidate.title), TASK_TITLE_MAX),
    description: limitText(stripPlannerSourceContext(objective), TASK_OBJECTIVE_MAX),
    objective: limitText(stripPlannerSourceContext(objective), TASK_OBJECTIVE_MAX),
    taskKind,
    targetFiles: sanitizeTargetFiles(stringArray(candidate.targetFiles)),
    expectedChanges: sanitizeList(stringArray(candidate.expectedChanges), MAX_TASK_LIST_ITEMS),
    acceptanceCriteria: sanitizeList(acceptanceCriteria, MAX_TASK_LIST_ITEMS),
    verificationHints: sanitizeList(stringArray(candidate.verificationHints), MAX_TASK_LIST_ITEMS),
    riskLevel,
  };
}

export function sanitizePlanForOperator(plan: PlanJson): PlanJson {
  const goal = concisePlanGoal(plan.goal);
  return {
    ...plan,
    title: concisePlanTitle(plan.title, goal),
    goal,
    risks: sanitizeList(plan.risks, MAX_RISKS),
    verificationCommands: stringArray(plan.verificationCommands).map((entry) => collapseWhitespace(entry)).filter((entry) => entry.length > 0),
    tasks: plan.tasks.map((task) => {
      const objective = limitText(stripPlannerSourceContext(task.objective ?? task.description), TASK_OBJECTIVE_MAX);
      return {
        ...task,
        title: limitText(stripPlannerSourceContext(task.title), TASK_TITLE_MAX),
        description: objective,
        objective,
        targetFiles: sanitizeTargetFiles(task.targetFiles),
        expectedChanges: sanitizeList(task.expectedChanges ?? [], MAX_TASK_LIST_ITEMS),
        acceptanceCriteria: sanitizeList(task.acceptanceCriteria, MAX_TASK_LIST_ITEMS),
        verificationHints: sanitizeList(task.verificationHints ?? [], MAX_TASK_LIST_ITEMS),
      };
    }),
  };
}

export function isWeakPlan(plan: PlanJson): boolean {
  if (stripPlannerSourceContext(plan.goal).length > DISPLAY_GOAL_MAX * 2) {
    return true;
  }
  return plan.tasks.some((task) => {
    const title = task.title.toLowerCase();
    const hasTargets = (task.targetFiles ?? []).length > 0;
    const hasPromptDump = stripPlannerSourceContext(`${task.title}\n${task.objective ?? task.description}`).length > TASK_TITLE_MAX + TASK_OBJECTIVE_MAX;
    return genericTaskTitles.has(title) || hasPromptDump || ((task.taskKind ?? "modify") !== "handoff" && (task.taskKind ?? "modify") !== "verify" && !hasTargets);
  });
}

export type PlanEditValidation =
  | { ok: true; plan: PlanJson; warnings: string[] }
  | { ok: false; errors: string[] };

export function validateAndNormalizeEditedPlan(raw: unknown, previous: PlanJson): PlanEditValidation {
  const errors: string[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: ["The edited plan is not a valid object."] };
  }
  const candidate = raw as Record<string, unknown>;

  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  const goal = typeof candidate.goal === "string" ? concisePlanGoal(candidate.goal) : "";
  if (title.length === 0) {
    errors.push("Plan title is required.");
  }
  if (goal.length === 0) {
    errors.push("Plan goal is required.");
  }

  const rawTasks = Array.isArray(candidate.tasks) ? candidate.tasks : [];
  if (rawTasks.length === 0) {
    errors.push("The plan needs at least one task.");
  }

  const tasks: PlanTaskInput[] = [];
  rawTasks.forEach((rawTask, index) => {
    const position = index + 1;
    if (typeof rawTask !== "object" || rawTask === null) {
      errors.push(`Task ${position} is not a valid object.`);
      return;
    }
    const taskCandidate = rawTask as Record<string, unknown>;
    const taskTitle = typeof taskCandidate.title === "string" ? taskCandidate.title.trim() : "";
    const objective = typeof taskCandidate.objective === "string" && taskCandidate.objective.trim().length > 0
      ? taskCandidate.objective.trim()
      : typeof taskCandidate.description === "string"
        ? taskCandidate.description.trim()
        : "";
    const acceptanceCriteria = stringArray(taskCandidate.acceptanceCriteria)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (taskTitle.length === 0) {
      errors.push(`Task ${position} needs a title.`);
    }
    if (objective.length === 0) {
      errors.push(`Task ${position} needs an objective.`);
    }
    if (acceptanceCriteria.length === 0) {
      errors.push(`Task ${position} needs at least one acceptance criterion.`);
    }

    const rawKind = typeof taskCandidate.taskKind === "string" ? taskCandidate.taskKind : "modify";
    if (!EDITABLE_TASK_KINDS.includes(rawKind as PlanTaskKind)) {
      errors.push(`Task ${position} has an unsupported kind "${rawKind}". The orchestrator owns verification and handoff.`);
    }
    const taskKind = EDITABLE_TASK_KINDS.includes(rawKind as PlanTaskKind) ? (rawKind as PlanTaskKind) : "modify";
    const riskLevel = typeof taskCandidate.riskLevel === "string" && RISK_LEVELS.includes(taskCandidate.riskLevel as RiskLevel)
      ? (taskCandidate.riskLevel as RiskLevel)
      : "low";

    if (taskTitle.length > 0 && objective.length > 0 && acceptanceCriteria.length > 0) {
      tasks.push({
        title: taskTitle,
        description: objective,
        objective,
        taskKind,
        targetFiles: stringArray(taskCandidate.targetFiles).map((entry) => entry.trim()).filter((entry) => entry.length > 0),
        expectedChanges: stringArray(taskCandidate.expectedChanges).map((entry) => entry.trim()).filter((entry) => entry.length > 0),
        acceptanceCriteria,
        verificationHints: stringArray(taskCandidate.verificationHints).map((entry) => entry.trim()).filter((entry) => entry.length > 0),
        riskLevel,
      });
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const plan: PlanJson = {
    schemaVersion: previous.schemaVersion ?? 2,
    title: concisePlanTitle(title, goal),
    goal,
    risks: sanitizeList(stringArray(candidate.risks), MAX_RISKS),
    verificationCommands: stringArray(candidate.verificationCommands).map((entry) => entry.trim()).filter((entry) => entry.length > 0),
    workspace: previous.workspace,
    tasks: sanitizePlanForOperator({ schemaVersion: previous.schemaVersion ?? 2, title, goal, risks: [], verificationCommands: [], workspace: previous.workspace, tasks }).tasks,
  };

  const warnings: string[] = [];
  if (isWeakPlan(plan)) {
    warnings.push("Some tasks have no target files. Codex will choose files itself, which is less precise.");
  }

  return { ok: true, plan, warnings };
}
