import { rm } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { createCheckpointRecord, createId, currentTimestamp, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { getGithubToken } from "@/lib/server/github-auth";
import { createProjectBundle, uniqueGeneratedProjectSlug, type CreatedProjectBundle } from "@/lib/server/projects";
import { cleanRepoUrl, cloneRepository, isGithubHost, isLikelyHttpsGitUrl, repoNameFromUrl } from "@/lib/server/runtime/git-clone";
import { createGitCheckpoint } from "@/lib/server/runtime/workspace-git";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import { inspectWorkspaceCandidate, metadataFromCandidate, type WorkspaceCandidate } from "@/lib/server/workspace-selection";
import type { CheckpointRecord, WorkspaceSelectionSource } from "@/lib/shared/types";

export type ImportProjectInput =
  | { source: "local"; name?: string; localPath: string; confirmedRisk?: boolean }
  | { source: "git"; name?: string; repoUrl: string; branch?: string | null; confirmedRisk?: boolean; signal?: AbortSignal };

export interface ImportProjectResult {
  created: CreatedProjectBundle | null;
  requiresConfirmation: boolean;
  candidate: WorkspaceCandidate | null;
}

export async function importProject(input: ImportProjectInput): Promise<ImportProjectResult> {
  if (input.source === "git") {
    return importGitProject(input);
  }
  return importLocalProject(input);
}

async function importLocalProject(input: Extract<ImportProjectInput, { source: "local" }>): Promise<ImportProjectResult> {
  const candidate = await inspectWorkspaceCandidate(input.localPath);
  if (!candidate.exists || !candidate.isDirectory) {
    throw new Error("Select an existing folder to import.");
  }
  await assertSafeWorkspace(candidate.path, { source: "manual", operation: "project import" });
  if (!candidate.isWritable) {
    throw new Error("The selected folder is not writable by the control-plane process.");
  }
  if (candidate.requiresConfirmation && input.confirmedRisk !== true) {
    return { created: null, requiresConfirmation: true, candidate };
  }

  const name = (input.name?.trim() ?? "") || path.basename(candidate.path) || "Imported project";
  const slug = await uniqueGeneratedProjectSlug(name);
  await emitEvent({
    workSessionId: null,
    eventName: "project.import.started",
    aggregateType: "project",
    aggregateId: null,
    payload: { importKind: "local", origin: candidate.path, slug },
  });
  const created = await createImportedBundle({
    name,
    slug,
    localRepoPath: candidate.path,
    repoUrl: `local://${slug}`,
    candidate,
    source: "manual",
    importKind: "local",
    origin: candidate.path,
  });
  return { created, requiresConfirmation: false, candidate };
}

async function importGitProject(input: Extract<ImportProjectInput, { source: "git" }>): Promise<ImportProjectResult> {
  const url = input.repoUrl.trim();
  if (!isLikelyHttpsGitUrl(url)) {
    throw new Error("Enter a valid https:// repository URL.");
  }
  const config = getConfig();
  const nameHint = (input.name?.trim() ?? "") || repoNameFromUrl(url);
  const slug = await uniqueGeneratedProjectSlug(nameHint);
  const targetPath = path.join(config.workspaceRoot, slug);

  let token: string | null = null;
  if (isGithubHost(url)) {
    token = await getGithubToken().then((value) => value.token).catch(() => null);
  }

  await emitEvent({
    workSessionId: null,
    eventName: "project.import.started",
    aggregateType: "project",
    aggregateId: null,
    payload: { importKind: "git", origin: cleanRepoUrl(url), slug, branch: input.branch?.trim() ?? null },
  });

  const clone = await cloneRepository({ url, targetPath, branch: input.branch ?? null, token, signal: input.signal });
  if (!clone.ok) {
    await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
    await emitEvent({
      workSessionId: null,
      eventName: "project.import.failed",
      aggregateType: "project",
      aggregateId: null,
      payload: { importKind: "git", origin: cleanRepoUrl(url), reason: clone.message },
    });
    const needsAuthHint = token === null && isGithubHost(url);
    const hint = needsAuthHint ? " If this is a private repository, connect GitHub first (Export to GitHub → Connect), then retry." : "";
    throw new Error(`${clone.message}${hint}`);
  }

  await assertSafeWorkspace(targetPath, { source: "generated", operation: "project import" });
  const candidate = await inspectWorkspaceCandidate(targetPath);
  const name = (input.name?.trim() ?? "") || nameHint;
  const created = await createImportedBundle({
    name,
    slug,
    localRepoPath: targetPath,
    repoUrl: cleanRepoUrl(url),
    candidate,
    source: "generated",
    importKind: "git",
    origin: cleanRepoUrl(url),
  });
  return { created, requiresConfirmation: false, candidate };
}

async function createImportedBundle(input: {
  name: string;
  slug: string;
  localRepoPath: string;
  repoUrl: string;
  candidate: WorkspaceCandidate;
  source: WorkspaceSelectionSource;
  importKind: "local" | "git";
  origin: string;
}): Promise<CreatedProjectBundle> {
  const bundle = await createProjectBundle({
    name: input.name,
    slug: input.slug,
    localRepoPath: input.localRepoPath,
    repoUrl: input.repoUrl,
    workspaceSelection: metadataFromCandidate(input.candidate, input.source),
  });

  await createImportBaselineCheckpoint(bundle, input.importKind);

  await emitEvent({
    workSessionId: bundle.workSession.id,
    eventName: "project.import.completed",
    aggregateType: "work_session",
    aggregateId: bundle.workSession.id,
    payload: {
      importKind: input.importKind,
      origin: input.origin,
      localRepoPath: input.localRepoPath,
      detectedStack: input.candidate.detectedStack,
      isEmpty: input.candidate.isEmpty,
      riskLevel: input.candidate.riskLevel,
    },
  });
  return bundle;
}

async function createImportBaselineCheckpoint(bundle: CreatedProjectBundle, importKind: "local" | "git"): Promise<CheckpointRecord | null> {
  const config = getConfig();
  if (!config.checkpointsEnabled) {
    return null;
  }
  const checkpointId = createId();
  const createdAt = currentTimestamp();
  let gitCheckpoint;
  try {
    gitCheckpoint = await createGitCheckpoint({
      workSessionId: bundle.workSession.id,
      workTree: bundle.workSession.activeWorktreePath,
      checkpointId,
      message: ["orchestrator import baseline", `checkpoint=${checkpointId}`, `importKind=${importKind}`].join("\n\n"),
    });
  } catch (error) {
    await emitEvent({
      workSessionId: bundle.workSession.id,
      eventName: "task.progress",
      aggregateType: "work_session",
      aggregateId: bundle.workSession.id,
      priority: "low",
      payload: {
        message: "Imported the project but could not capture a baseline checkpoint.",
        reason: error instanceof Error ? error.message : "unknown checkpoint error",
      },
    });
    return null;
  }

  return mutateDatabase((db) => {
    const workSession = db.workSessions.find((candidate) => candidate.id === bundle.workSession.id);
    if (workSession === undefined) {
      return null;
    }
    const checkpoint = createCheckpointRecord({
      id: checkpointId,
      workSessionId: bundle.workSession.id,
      taskId: null,
      agentRunId: null,
      trigger: "baseline",
      status: "active",
      refName: gitCheckpoint.refName,
      commitHash: gitCheckpoint.commitHash,
      previousCheckpointId: null,
      restoredFromCheckpointId: null,
      summary: importKind === "git" ? "Imported repository baseline." : "Imported folder baseline.",
      filesChanged: gitCheckpoint.filesChanged,
      createdAt,
    });
    db.checkpoints.push(checkpoint);
    workSession.checkpointRef = checkpoint.id;
    updateWorkSessionTimestamp(workSession);
    return { ...checkpoint };
  });
}
