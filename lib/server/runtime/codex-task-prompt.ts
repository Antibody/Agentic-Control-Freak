import { buildCodexOrchestratorContext } from "@/lib/server/orchestrator-state";
import { renderProjectMemoryPromptBlock } from "@/lib/server/project-memory";
import { renderUserMemoryPromptBlock } from "@/lib/server/user-memory";
import { attachmentPromptBlock } from "@/lib/server/chat-attachments";
import { renderRelevantPlaybooksForPrompt } from "@/lib/server/playbooks";
import { mlMethodologyGuidance } from "@/lib/server/ml/ml-methodology";
import type { TaskRecord, WorkSessionRecord } from "@/lib/shared/types";


function metadataString(task: TaskRecord, key: string, fallback: string): string {
  const value = task.metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}

function metadataStringList(task: TaskRecord, key: string): string[] {
  const value = task.metadata[key];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function metadataSteeringMessages(task: TaskRecord): string[] {
  const value = task.metadata.appliedSteeringMessages;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (typeof entry === "object" && entry !== null && "content" in entry) {
        const content = (entry as { content?: unknown }).content;
        return typeof content === "string" ? content : "";
      }
      return "";
    })
    .filter((entry) => entry.trim().length > 0);
}

export function metadataSteeringMessageIds(task: TaskRecord): string[] {
  const value = task.metadata.appliedSteeringMessages;
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (typeof entry === "object" && entry !== null && "id" in entry) {
        const id = (entry as { id?: unknown }).id;
        return typeof id === "string" ? id : "";
      }
      return "";
    })
    .filter((entry) => entry.length > 0);
}

function bulletList(values: string[], fallback: string): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${fallback}`;
}

function stackSpecificGuidance(input: { userGoal: string; task: TaskRecord }): string {
  const haystack = [
    input.userGoal,
    input.task.title,
    input.task.description,
    metadataString(input.task, "objective", ""),
    ...metadataStringList(input.task, "targetFiles"),
    ...metadataStringList(input.task, "expectedChanges"),
    ...input.task.acceptanceCriteria,
    ...metadataStringList(input.task, "verificationHints"),
  ].join("\n");
  const sections: string[] = [];
  if (/\bnext(?:\.js)?\b|next\.config|next-env\.d\.ts|app\/(?:api\/[^/\n]+\/)?(?:page|route)\.tsx?/i.test(haystack)) {
    sections.push(`Next.js/App Router TypeScript guardrails:
- Before using @/... imports, inspect tsconfig.json or jsconfig.json for a matching compilerOptions.paths alias. The generated Next scaffold does not guarantee @/*.
- If no alias is configured, use a correct relative import computed from the importing file. For app/api/<segment>/route.ts or app/api/[param]/route.ts importing a root-level lib/foo.ts, the path is ../../../lib/foo.
- Do not add compilerOptions.baseUrl solely to make @/... imports work under TypeScript 6+. Prefer relative imports unless the project already has alias conventions.
- In API route handlers, parse JSON as unknown and narrow it before property access. Avoid patterns like await parseBody(request).catch(() => ({})) when the success type is a typed object; the catch fallback widens the value to Type | {} and strict TypeScript will reject body.title/body.content access.
- For shared client/server DTOs, keep pure type definitions in a side-effect-free module and import them with import type across API routes and client components.`);
  }
  if (/\blaravel\b|bootstrap\/app\.php|routes\/web\.php|resources\/views|AppServiceProvider|composer install/i.test(haystack)) {
    sections.push(`Laravel/PHP guardrails:
- Keep the Laravel bootstrap coherent: use Application::configure in bootstrap/app.php and avoid hand-binding ExceptionHandler or Http Kernel contracts in multiple places.
- Do not add Composer post-autoload-dump or post-update-cmd artisan hooks for a generated minimal Laravel app unless the artisan/console kernel path is already present and verified.
- If editing a PHP class or provider, replace the file with one complete PHP document. It must have exactly one <?php opening tag at the top and must not contain a second appended copy of the same class.
- Prefer routes/web.php, controllers or route closures, Blade views in resources/views, public assets, and file/session storage. Include @csrf in every mutating Blade form. Keep bootstrap/cache and storage/framework/{cache/data,sessions,views,testing} available for preview.
- When repairing verification, run or reason against php -l for every touched PHP file before reporting the repair as complete.`);
  }
  return sections.join("\n\n");
}

export function requestsNativeCodexSubagents(input: { workSession: WorkSessionRecord; task?: TaskRecord }): boolean {
  const haystack = [
    input.workSession.lastUserMessage,
    input.workSession.steeringNote,
    input.task?.title ?? "",
    input.task?.description ?? "",
    input.task !== undefined ? metadataString(input.task, "objective", "") : "",
    ...(input.task !== undefined ? metadataStringList(input.task, "expectedChanges") : []),
  ].join("\n").toLowerCase();
  return /\b(subagent|subagents|sub-agent|sub-agents|multi-agent|multi agent|parallel agents|delegate to agents|spawn agents)\b/.test(haystack);
}

function nativeSubagentPromptBlock(input: { workSession: WorkSessionRecord; task: TaskRecord }): string {
  if (!requestsNativeCodexSubagents(input)) {
    return "";
  }
  return `Native Codex subagent request:
- The user asked to use Codex subagents. When the native spawn_agent tool is available, delegate independent backend/frontend/research slices to subagents before making final edits.
- Give each subagent a narrow task name and prompt, wait for its useful output, then integrate the result yourself into the workspace.
- Keep delegation shallow. Prefer a few direct subagents from the root turn. Subagents must report back instead of spawning their own children unless you explicitly tell that child it may spawn nested subagents.
- Do not override spawn_agent model or reasoning effort unless the user explicitly requested a different child model. Inherit the active runtime settings by default.
- Only close agents when you must free capacity before spawning another child. Do not issue close_agent as final cleanup after a child has reported.
- If a spawned helper does not produce useful output after one wait, continue the task directly instead of repeatedly polling or depending on that helper.
- If native subagent tools are unavailable in this runtime, continue the task directly and explicitly mention that no native subagent tool was available.`;
}

export function buildSteeringBlock(sessionNote: string, taskNote: string, pendingMessages: string[] = []): string {
  const session = sessionNote.trim();
  const task = taskNote.trim();
  const boundedPending = pendingMessages
    .map((message) => message.trim())
    .filter((message) => message.length > 0)
    .slice(0, 5);
  return [
    session.length > 0 ? `User steering (applies to every task; honor unless it conflicts with a hard constraint above):\n${session}` : "",
    task.length > 0 ? `Steering for this specific task:\n${task}` : "",
    boundedPending.length > 0
      ? `User steering received while previous work was running:\n${boundedPending.map((message) => `- ${message}`).join("\n")}\nApply this guidance from this point forward. Preserve useful completed work unless it conflicts with the steering.`
      : "",
  ]
    .filter((entry) => entry.length > 0)
    .join("\n\n");
}

export interface CodexTaskPrompt {
  prompt: string;
  steeringBlock: string;
  steeringMessageIds: string[];
}

export async function buildCodexTaskPrompt(input: {
  workSession: WorkSessionRecord;
  task: TaskRecord;
  includeOrchestratorContext?: boolean;
}): Promise<CodexTaskPrompt> {
  const taskKind = metadataString(input.task, "taskKind", "modify");
  const riskLevel = metadataString(input.task, "riskLevel", "low");
  const objective = metadataString(input.task, "objective", input.task.description);
  const targetFiles = metadataStringList(input.task, "targetFiles");
  const expectedChanges = metadataStringList(input.task, "expectedChanges");
  const verificationHints = metadataStringList(input.task, "verificationHints");
  const dependencyResearchSummary = metadataString(input.task, "dependencyResearchSummary", "No dependency research report is attached to this task.");
  const dependencyInstallSummary = metadataString(input.task, "dependencyInstallSummary", "");
  const dispatchRetryContext = metadataString(input.task, "dispatchRetryContext", "");
  const priorResearchContext = metadataString(input.task, "priorResearchContext", "");
  const orchestratorContext = input.includeOrchestratorContext === false
    ? ""
    : await buildCodexOrchestratorContext(input.workSession.id);
  const projectMemory = input.includeOrchestratorContext === false
    ? await renderProjectMemoryPromptBlock(input.workSession.id)
    : "";
  const userMemory = input.includeOrchestratorContext === false
    ? await renderUserMemoryPromptBlock()
    : "";
  const attachmentsBlock = await attachmentPromptBlock(input.workSession);
  const playbooksBlock = await renderRelevantPlaybooksForPrompt({ workSession: input.workSession, task: input.task });
  const skillsBlock = metadataString(input.task, "activatedSkillPrompt", "");
  const stackGuidance = stackSpecificGuidance({ userGoal: input.workSession.lastUserMessage, task: input.task });
  const mlGuidance = input.workSession.stackDecision?.stack === "python-ml" ? mlMethodologyGuidance() : "";
  const steeringBlock = buildSteeringBlock(
    input.workSession.steeringNote,
    metadataString(input.task, "steeringNote", ""),
    metadataSteeringMessages(input.task),
  );
  const steeringMessageIds = metadataSteeringMessageIds(input.task);

  const prompt = `You are executing one task inside a closed dev loop.

Original user goal:
${input.workSession.lastUserMessage}

${attachmentsBlock.length > 0 ? `${attachmentsBlock}\n` : ""}

Workspace:
${input.workSession.activeWorktreePath}

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
${dependencyInstallSummary.length > 0 ? `Dependency pre-flight:\n${dependencyInstallSummary}\nThe packages above are already installed. Do not reinstall them; focus on the remaining file deliverables of this task.\n` : ""}
Dependency research:
Use this dependency research as the package baseline. Do not downgrade package.json below the recommended/latest versions in this report.
${dependencyResearchSummary}

${priorResearchContext.trim().length > 0 ? `Prior research context for this implementation:\n${priorResearchContext}\n` : ""}

${playbooksBlock.length > 0 ? `Relevant approved project playbooks:\n${playbooksBlock}\n` : ""}

${skillsBlock.length > 0 ? `${skillsBlock}\n` : ""}

${nativeSubagentPromptBlock({ workSession: input.workSession, task: input.task })}

Work directly in the workspace when the task requires code changes. Keep edits scoped to the original user goal and this task.

Before editing, preserve conventions from the target files and expected changes. For static or vanilla Node apps, use the existing shared asset paths consistently across every HTML page instead of inventing new css/js directories.
When the task edits TypeScript, API-route contracts, or handoff boundaries and the verification hints name a lightweight check such as npm run typecheck or npm run lint, run the named check once before reporting completion if dependencies are installed. Do not run npm run build unless the user or verification hints explicitly request build verification. If you cannot run the lightweight check, say why and still reason against the exact changed files.

${stackGuidance.length > 0 ? `${stackGuidance}\n` : ""}
${mlGuidance.length > 0 ? `${mlGuidance}\n` : ""}

${orchestratorContext}
${userMemory.length > 0 ? `${userMemory}\n` : ""}
${projectMemory.length > 0 ? `${projectMemory}\n` : ""}
${steeringBlock.length > 0 ? `\n${steeringBlock}\n` : ""}
After working, print a concise summary, list files changed, and list verification steps.`;

  return { prompt, steeringBlock, steeringMessageIds };
}
