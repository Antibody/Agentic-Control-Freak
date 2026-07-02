import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { renderProjectMemoryPromptBlock } from "@/lib/server/project-memory";
import { renderUserMemoryPromptBlock } from "@/lib/server/user-memory";
import { createActiveHistoryFilter } from "@/lib/shared/history";
import type { AgentRunRecord, Identifier, JsonValue, RuntimeKind, TaskRecord } from "@/lib/shared/types";

function safeName(input: string): string {
  return input.replace(/[^a-z0-9._-]/gi, "_").slice(0, 180);
}

function json(value: JsonValue | object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function syncOrchestratorState(workSessionId: Identifier): Promise<void> {
  const db = await getDatabaseSnapshot();
  const workSession = db.workSessions.find((candidate) => candidate.id === workSessionId);
  if (workSession === undefined || workSession.activeWorktreePath.trim().length === 0) {
    return;
  }
  const inHistory = createActiveHistoryFilter(workSession, db.checkpoints);

  const project = db.projects.find((candidate) => candidate.id === workSession.projectId) ?? null;
  const plans = db.plans
    .filter((plan) => plan.workSessionId === workSessionId && inHistory(plan.createdAt))
    .sort((a, b) => a.version - b.version);
  const activePlan = workSession.activePlanId === null
    ? plans[plans.length - 1] ?? null
    : plans.find((plan) => plan.id === workSession.activePlanId) ?? null;
  const tasks = activePlan === null
    ? []
    : db.tasks.filter((task) => task.planId === activePlan.id).sort((a, b) => a.ordinal - b.ordinal);
  const agentRuns = db.agentRuns
    .filter((run) => run.workSessionId === workSessionId && inHistory(run.startedAt))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const latestVerification = db.verificationRuns
    .filter((run) => run.workSessionId === workSessionId && inHistory(run.startedAt))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null;
  const handoffs = db.handoffs
    .filter((handoff) => handoff.workSessionId === workSessionId && inHistory(handoff.createdAt))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const approvals = db.approvals
    .filter((approval) => approval.workSessionId === workSessionId && inHistory(approval.requestedAt))
    .sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime());
  const steeringMessages = db.steeringMessages
    .filter((message) => message.workSessionId === workSessionId && inHistory(message.createdAt))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const events = db.eventLog
    .filter((event) => event.workSessionId === workSessionId && inHistory(event.createdAt))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const root = path.join(workSession.activeWorktreePath, ".orchestrator");
  const plansDir = path.join(root, "plans");
  const handoffsDir = path.join(root, "handoffs");
  const verificationDir = path.join(root, "verification");
  const artifactsDir = path.join(root, "artifacts");
  await Promise.all([
    mkdir(root, { recursive: true }),
    mkdir(plansDir, { recursive: true }),
    mkdir(handoffsDir, { recursive: true }),
    mkdir(verificationDir, { recursive: true }),
    mkdir(artifactsDir, { recursive: true }),
  ]);

  await writeFile(
    path.join(root, "session.json"),
    json({
      project,
      workSession,
      activePlan,
      tasks,
      acceptanceEvidence: tasks.map((task) => ({
        taskId: task.id,
        title: task.title,
        evidence: task.acceptanceEvidence,
      })),
      approvals,
      steeringMessages,
      latestVerification,
      updatedAt: new Date().toISOString(),
    }),
    "utf8"
  );

  await writeFile(
    path.join(root, "active-run.json"),
    json({
      latestAgentRun: agentRuns[0] ?? null,
      runningAgentRuns: agentRuns.filter((run) => run.status === "running" || run.status === "waiting_approval"),
      incompleteTasks: tasks.filter((task) => task.status !== "done" && task.status !== "skipped"),
      recentEvents: events.slice(-30),
      updatedAt: new Date().toISOString(),
    }),
    "utf8"
  );

  for (const plan of plans) {
    const baseName = safeName(`plan-v${plan.version}-${plan.title || plan.id}`);
    await writeFile(path.join(plansDir, `${baseName}.md`), plan.planMarkdown, "utf8");
    await writeFile(path.join(plansDir, `${baseName}.json`), json(plan.planJson), "utf8");
  }

  for (const handoff of handoffs) {
    const baseName = safeName(`handoff-${handoff.createdAt}-${handoff.id}`);
    await writeFile(path.join(handoffsDir, `${baseName}.md`), handoff.summaryMarkdown, "utf8");
  }

  if (latestVerification !== null) {
    const baseName = safeName(`verify-${latestVerification.startedAt}-${latestVerification.id}`);
    await writeFile(path.join(verificationDir, `${baseName}.json`), json(latestVerification), "utf8");
    await writeFile(path.join(verificationDir, `${baseName}.txt`), latestVerification.rawOutput, "utf8");
  }

  await writeFile(
    path.join(artifactsDir, "event-log.json"),
    json(events),
    "utf8"
  );
}

function truncate(input: string, maxLength: number): string {
  return input.length > maxLength ? `${input.slice(0, maxLength - 3)}...` : input;
}

function taskLine(task: TaskRecord): string {
  const failed = task.lastFailureSummary === null ? "" : ` lastFailure=${truncate(task.lastFailureSummary.replace(/\s+/g, " "), 180)}`;
  return `- [${task.status}] #${task.ordinal} ${task.title} attempts=${task.attemptCount}${failed}`;
}

function runtimeLabel(runtimeKind: RuntimeKind, role: AgentRunRecord["role"]): string {
  if (role === "researcher") {
    return `${runtimeLabel(runtimeKind, "executor")} research`;
  }
  switch (runtimeKind) {
    case "codex":
      return "Codex CLI";
    case "claude":
      return "Claude Code";
    case "antigravity":
      return "AGY CLI";
    case "ollama":
      return "Ollama";
  }
}

function priorAgentWorkLine(input: { run: AgentRunRecord; taskTitle: string }): string {
  const summary = truncate(input.run.summary.replace(/\s+/g, " ").trim(), 500);
  return `  - [${runtimeLabel(input.run.runtimeKind, input.run.role)} | "${input.taskTitle}" | ${input.run.status}] ${summary}`;
}

function isCrossProviderHandoff(summaryMarkdown: string): boolean {
  return summaryMarkdown.startsWith("# Cross-provider Handoff Brief");
}

function promptSafeSwitchHandoff(markdown: string): string {
  const withoutHeading = markdown.replace(/^# Cross-provider Handoff Brief\s*/i, "").trim();
  return `- Prior agent work (distilled cross-provider handoff):\n${truncate(withoutHeading, 2500)}`;
}

export async function buildCodexOrchestratorContext(workSessionId: Identifier, maxLength = 5000): Promise<string> {
  const db = await getDatabaseSnapshot();
  const workSession = db.workSessions.find((candidate) => candidate.id === workSessionId);
  if (workSession === undefined) {
    return "";
  }
  const inHistory = createActiveHistoryFilter(workSession, db.checkpoints);

  const plan = workSession.activePlanId === null
    ? null
    : db.plans.find((candidate) => candidate.id === workSession.activePlanId && inHistory(candidate.createdAt)) ?? null;
  const tasks = plan === null
    ? []
    : db.tasks.filter((task) => task.planId === plan.id).sort((a, b) => a.ordinal - b.ordinal);
  const latestVerification = db.verificationRuns
    .filter((run) => run.workSessionId === workSessionId && inHistory(run.startedAt))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null;
  const currentRunIds = new Set(
    db.agentRuns
      .filter((run) => run.workSessionId === workSessionId && inHistory(run.startedAt))
      .map((run) => run.id)
  );
  const recentChanges = db.codeChanges
    .filter((change) => currentRunIds.has(change.agentRunId))
    .slice(-20);
  const pendingSteering = db.steeringMessages
    .filter((message) => message.workSessionId === workSessionId && message.status === "pending" && inHistory(message.createdAt))
    .slice(-5);
  const currentRepairTask = tasks.find((task) => task.status === "in_progress" && task.metadata.taskKind === "modify" && task.title.startsWith("Repair verification failure"));
  const config = getConfig();
  const taskTitlesById = new Map(db.tasks.map((task) => [task.id, task.title]));
  const latestCrossProviderHandoff = db.handoffs
    .filter((handoff) =>
      handoff.workSessionId === workSessionId &&
      inHistory(handoff.createdAt) &&
      isCrossProviderHandoff(handoff.summaryMarkdown)
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
  const priorAgentRuns = config.crossProviderBriefRuns <= 0
    ? []
    : db.agentRuns
      .filter((run) => run.workSessionId === workSessionId && inHistory(run.startedAt) && run.summary.trim().length > 0)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, config.crossProviderBriefRuns);
  const priorAgentWork = latestCrossProviderHandoff !== null
    ? promptSafeSwitchHandoff(latestCrossProviderHandoff.summaryMarkdown)
    : priorAgentRuns.length === 0
      ? "- Prior agent work: none"
      : `- Prior agent work (most recent first):\n${truncate(
        priorAgentRuns
          .map((run) => priorAgentWorkLine({
            run,
            taskTitle: run.taskId === null ? run.role : taskTitlesById.get(run.taskId) ?? run.taskId,
          }))
          .join("\n"),
        2500
      )}`;
  const userMemory = await renderUserMemoryPromptBlock();
  const projectMemory = await renderProjectMemoryPromptBlock(workSessionId);

  const baseBlock = [
    "Orchestrator context:",
    `- Session state: ${workSession.currentState}`,
    plan === null ? "- Active plan: none" : `- Active plan: ${plan.title}`,
    tasks.length === 0 ? "- Tasks: none" : `- Tasks:\n${tasks.map(taskLine).join("\n")}`,
    currentRepairTask === undefined ? "- Current repair attempt: none" : `- Current repair attempt: ${currentRepairTask.attemptCount}`,
    latestVerification === null
      ? "- Latest verification: none"
      : `- Latest verification: ${latestVerification.status}; ${truncate(latestVerification.summary.replace(/\s+/g, " "), 500)}`,
    pendingSteering.length === 0
      ? "- Pending steering: none"
      : `- Pending steering:\n${pendingSteering.map((message) => `  - ${truncate(message.content.replace(/\s+/g, " "), 300)}`).join("\n")}`,
    recentChanges.length === 0
      ? "- Recent changed files: none"
      : `- Recent changed files:\n${recentChanges.map((change) => `  - ${change.changeKind}: ${change.filePath}`).join("\n")}`,
  ].join("\n");

  return `${truncate(baseBlock, maxLength)}\n${userMemory.length > 0 ? `${userMemory}\n` : ""}${projectMemory.length > 0 ? `${projectMemory}\n` : ""}${priorAgentWork}`;
}
