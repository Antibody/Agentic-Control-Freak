import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { createId, currentTimestamp, getDatabaseSnapshot, mutateDatabase } from "@/lib/server/db/file-db";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import type { JsonObject, ProjectRecord, RuntimeProfileRecord, ChatSessionRecord, WorkSessionRecord, WorkspaceSelectionMetadata } from "@/lib/shared/types";

export interface CreateProjectInput {
  name: string;
  slug: string;
  localRepoPath?: string;
  repoUrl?: string;
  workspaceSelection?: WorkspaceSelectionMetadata;
}

export interface CreatedProjectBundle {
  project: ProjectRecord;
  runtimeProfile: RuntimeProfileRecord;
  chatSession: ChatSessionRecord;
  workSession: WorkSessionRecord;
}

function normalizeProjectName(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function safeProjectSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized.length > 0 ? normalized : "telegram-chat";
}

export function timestampProjectName(prefix = "Project"): { name: string; slug: string } {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return { name: `${prefix} ${stamp}`, slug: `project-${stamp}` };
}

export async function uniqueGeneratedProjectSlug(slugHint: string): Promise<string> {
  const base = safeProjectSlug(slugHint);
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const config = getConfig();
  const db = await getDatabaseSnapshot();
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const slug = `${base}-${stamp}${suffix}`.slice(0, 90);
    const localRepoPath = path.join(config.workspaceRoot, slug);
    if (!db.projects.some((project) => project.slug === slug || project.localRepoPath === localRepoPath)) {
      return slug;
    }
  }
  return `${base}-${stamp}-${createId().slice(0, 8)}`.slice(0, 100);
}

export async function createProjectBundle(input: CreateProjectInput): Promise<CreatedProjectBundle> {
  const config = getConfig();
  const name = normalizeProjectName(input.name);
  if (name.length === 0) {
    throw new Error("Project name cannot be empty.");
  }
  const slug = safeProjectSlug(input.slug);
  const requestedLocalRepoPath = input.localRepoPath?.trim() || path.join(config.workspaceRoot, slug);
  await assertSafeWorkspace(requestedLocalRepoPath, {
    source: input.localRepoPath?.trim() ? "manual" : "generated",
    operation: "project creation",
  });

  const created = await mutateDatabase((db) => {
    const owner = db.users[0];
    if (owner === undefined) {
      throw new Error("No user exists in the embedded database.");
    }
    if (db.projects.some((project) => project.slug === slug)) {
      throw new Error(`Project slug already exists: ${slug}`);
    }
    const projectId = createId();
    const runtimeProfileId = createId();
    const chatSessionId = createId();
    const workSessionId = createId();
    const localRepoPath = requestedLocalRepoPath;
    const createdAt = currentTimestamp();
    const project: ProjectRecord = {
      id: projectId,
      ownerUserId: owner.id,
      name,
      slug,
      repoUrl: input.repoUrl ?? `local://${slug}`,
      localRepoPath,
      defaultBranch: "main",
      trusted: true,
      workspaceSelection: input.workspaceSelection ?? {
        source: input.localRepoPath?.trim() ? "manual" : "generated",
        selectedAt: createdAt,
        selectedPath: localRepoPath,
        riskLevel: "none",
        riskReasons: [],
        detectedStack: "unknown",
        isEmpty: true,
      },
      createdAt,
    };
    const runtimeProfile: RuntimeProfileRecord = {
      id: runtimeProfileId,
      projectId,
      name: "Default Runtime",
      runtimeKind: "codex",
      provider: config.agentProvider,
      model: config.codexModel,
      approvalPolicy: config.codexApprovalPolicy,
      sandboxMode: config.codexSandboxMode,
      writableRoots: [config.workspaceRoot, localRepoPath],
      extraConfig: {} as JsonObject,
      createdAt,
    };
    const chatSession: ChatSessionRecord = {
      id: chatSessionId,
      projectId,
      title: `${name} Chat`,
      status: "active",
      createdBy: owner.id,
      createdAt,
      updatedAt: createdAt,
    };
    const workSession: WorkSessionRecord = {
      id: workSessionId,
      projectId,
      chatSessionId,
      runtimeProfileId,
      currentState: "intake",
      activeBranch: "main",
      activeWorktreePath: localRepoPath,
      activePlanId: null,
      startedBy: owner.id,
      startedAt: createdAt,
      updatedAt: createdAt,
      lastUserMessage: "",
      deliveryKind: "implementation",
      planModeEnabled: true,
      executionMode: "single-owner",
      autonomyLevel: config.defaultAutonomyLevel,
      paused: false,
      awaitingStep: false,
      nextActionLabel: null,
      pythonRunParams: null,
      rRunParams: null,
      agentProvider: null,
      runtimeOverrides: null,
      runtimeUsage: null,
      claudeSessionId: null,
      codexThreadId: null,
      codexSubagents: [],
      codexCollabCalls: [],
      transcriptRef: null,
      steeringNote: "",
      budget: null,
      lastProgress: null,
      checkpointRef: null,
      historyBaseCheckpointId: null,
      historyBaseCheckpointCreatedAt: null,
      historyRestoredAt: null,
      forkedFromWorkSessionId: null,
      forkedFromCheckpointId: null,
      forkedAt: null,
    };
    db.projects.push(project);
    db.runtimeProfiles.push(runtimeProfile);
    db.chatSessions.push(chatSession);
    db.workSessions.push(workSession);
    return { project, runtimeProfile, chatSession, workSession };
  });

  await mkdir(created.project.localRepoPath, { recursive: true });
  return created;
}
