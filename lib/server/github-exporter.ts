import { rm } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { saveArtifact } from "@/lib/server/artifacts";
import { createGithubExportRecord, currentTimestamp, getDatabaseSnapshot, mutateDatabase } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { getGithubToken, type GithubAccountStatus } from "@/lib/server/github-auth";
import { createGithubExportManifest, readExportFileContent, type GithubExportManifest } from "@/lib/server/github-export-scanner";
import { activeProcessesForWorkSession } from "@/lib/server/runtime/process-registry";
import { materializeGitCheckpoint } from "@/lib/server/runtime/workspace-git";
import type { GithubExportRecord, GithubExportSourceMode, GithubExportWriteMode, GithubRepositoryVisibility, Identifier, JsonObject } from "@/lib/shared/types";

const githubApiBase = "https://api.github.com";

export interface GithubExportPrepareResult {
  account: GithubAccountStatus | null;
  defaultOwner: string | null;
  defaultRepoName: string;
  defaultBranch: string;
  sourceMode: GithubExportSourceMode;
  currentCheckpointId: string | null;
  manifest: Omit<GithubExportManifest, "files"> & {
    files: Array<{ path: string; byteCount: number; executable: boolean }>;
  };
}

export interface GithubExportRequest {
  owner?: string;
  repoName?: string;
  branch?: string;
  visibility?: GithubRepositoryVisibility;
  sourceMode?: GithubExportSourceMode;
  checkpointId?: string | null;
  updateExisting?: boolean;
  writeMode?: GithubExportWriteMode;
}

interface GithubRepoResponse {
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  owner: { login: string };
}

interface GithubRefResponse {
  ref: string;
  object: { sha: string; type: string; url: string };
}

interface GithubCommitResponse {
  sha: string;
  tree: { sha: string };
}

interface GithubBlobResponse {
  sha: string;
}

interface GithubTreeResponse {
  sha: string;
  tree?: Array<{ path: string; type: string }>;
}

function safeRepoName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "exported-project";
}

function safeBranchName(input: string): string {
  const value = input.trim().replace(/^refs\/heads\//, "");
  if (!/^[A-Za-z0-9._/-]+$/.test(value) || value.includes("..") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".lock")) {
    throw new Error("Branch name contains unsupported characters.");
  }
  return value;
}

function assertRepoName(input: string): string {
  const value = input.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(value)) {
    throw new Error("Repository name may only contain letters, numbers, dots, underscores, and hyphens.");
  }
  return value;
}

function assertOwner(input: string): string {
  const value = input.trim();
  if (!/^[A-Za-z0-9-]{1,100}$/.test(value)) {
    throw new Error("Repository owner may only contain letters, numbers, and hyphens.");
  }
  return value;
}

async function githubFetch<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as T & { message?: string };
  if (!response.ok) {
    throw new Error(body.message ?? `GitHub API request failed with HTTP ${response.status}: ${url}`);
  }
  return body as T;
}

async function githubFetchMaybe<T>(token: string, url: string): Promise<T | null> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
    },
  });
  if (response.status === 404) {
    return null;
  }
  const body = await response.json().catch(() => ({})) as T & { message?: string };
  if (response.status === 409 && typeof body.message === "string" && body.message.toLowerCase().includes("repository is empty")) {
    return null;
  }
  if (!response.ok) {
    throw new Error(body.message ?? `GitHub API request failed with HTTP ${response.status}: ${url}`);
  }
  return body as T;
}

async function githubRepositoryIsEmpty(token: string, owner: string, repoName: string): Promise<boolean> {
  const response = await fetch(`${githubApiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
    },
  });
  if (response.ok) {
    return false;
  }
  const body = await response.json().catch(() => ({})) as { message?: string };
  return response.status === 409 && typeof body.message === "string" && body.message.toLowerCase().includes("repository is empty");
}

async function seedEmptyRepository(input: {
  token: string;
  owner: string;
  repoName: string;
  branch: string;
}): Promise<void> {
  await githubFetch<{ commit: { sha: string } }>(input.token, `${githubApiBase}/repos/${input.owner}/${input.repoName}/contents/.github-export-seed`, {
    method: "PUT",
    body: JSON.stringify({
      message: "Initialize repository for export",
      content: Buffer.from("Temporary seed file for the first export commit.\n", "utf8").toString("base64"),
      branch: input.branch,
    }),
  });
}

async function resolveExportRoot(input: {
  workSessionId: Identifier;
  sourceMode: GithubExportSourceMode;
  checkpointId: Identifier | null;
}): Promise<{ root: string; cleanup: (() => Promise<void>) | null; checkpointId: string | null }> {
  const snapshot = await getDatabaseSnapshot();
  const workSession = snapshot.workSessions.find((candidate) => candidate.id === input.workSessionId);
  if (workSession === undefined) {
    throw new Error("Work session was not found.");
  }
  if (input.sourceMode === "current_workspace") {
    return { root: workSession.activeWorktreePath, cleanup: null, checkpointId: null };
  }
  const checkpointId = input.checkpointId ?? workSession.checkpointRef;
  if (checkpointId === null) {
    throw new Error("No checkpoint is available for this work session.");
  }
  const checkpoint = snapshot.checkpoints.find((candidate) => candidate.id === checkpointId && candidate.workSessionId === workSession.id);
  if (checkpoint === undefined) {
    throw new Error("Checkpoint was not found.");
  }
  const tempRoot = path.join(path.dirname(getConfig().dbFile), "github-export-tmp", `${workSession.id}-${checkpoint.id}-${Date.now()}`);
  await materializeGitCheckpoint({
    workSessionId: workSession.id,
    sourceWorkTree: workSession.activeWorktreePath,
    targetWorkTree: tempRoot,
    commitHash: checkpoint.commitHash,
  });
  return {
    root: tempRoot,
    checkpointId: checkpoint.id,
    cleanup: () => rm(tempRoot, { recursive: true, force: true }),
  };
}

export async function prepareGithubExport(workSessionId: Identifier, sourceMode: GithubExportSourceMode = "current_workspace", checkpointId: Identifier | null = null): Promise<GithubExportPrepareResult> {
  const snapshot = await getDatabaseSnapshot();
  const workSession = snapshot.workSessions.find((candidate) => candidate.id === workSessionId);
  if (workSession === undefined) {
    throw new Error("Work session was not found.");
  }
  const project = snapshot.projects.find((candidate) => candidate.id === workSession.projectId);
  if (project === undefined) {
    throw new Error("Project was not found.");
  }
  const token = await getGithubToken().catch(() => null);
  const resolved = await resolveExportRoot({ workSessionId, sourceMode, checkpointId });
  try {
    const manifest = await createGithubExportManifest(resolved.root);
    return {
      account: token?.account ?? null,
      defaultOwner: token?.account.login ?? null,
      defaultRepoName: safeRepoName(project.slug || project.name),
      defaultBranch: project.defaultBranch || workSession.activeBranch || "main",
      sourceMode,
      currentCheckpointId: workSession.checkpointRef,
      manifest: {
        ...manifest,
        files: manifest.files.map((file) => ({ path: file.path, byteCount: file.byteCount, executable: file.executable })),
      },
    };
  } finally {
    await resolved.cleanup?.();
  }
}

async function resolveOrCreateRepo(input: {
  token: string;
  owner: string;
  repoName: string;
  visibility: GithubRepositoryVisibility;
  updateExisting: boolean;
  accountLogin: string;
}): Promise<GithubRepoResponse> {
  const existing = await githubFetchMaybe<GithubRepoResponse>(input.token, `${githubApiBase}/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repoName)}`);
  if (existing !== null) {
    const emptyRepository = await githubRepositoryIsEmpty(input.token, input.owner, input.repoName);
    if (!input.updateExisting && !emptyRepository) {
      throw new Error("Repository already exists. Enable update existing repository to export to it.");
    }
    return existing;
  }
  if (input.owner !== input.accountLogin) {
    throw new Error("Creating repositories under organizations is not enabled yet. Create the repo first, then update it.");
  }
  return githubFetch<GithubRepoResponse>(input.token, `${githubApiBase}/user/repos`, {
    method: "POST",
    body: JSON.stringify({
      name: input.repoName,
      private: input.visibility === "private",
      auto_init: false,
    }),
  });
}

async function createCommit(input: {
  token: string;
  owner: string;
  repoName: string;
  branch: string;
  manifest: GithubExportManifest;
  message: string;
  writeMode: GithubExportWriteMode;
}): Promise<{ commitSha: string; treeSha: string }> {
  let ref = await githubFetchMaybe<GithubRefResponse>(input.token, `${githubApiBase}/repos/${input.owner}/${input.repoName}/git/ref/heads/${encodeURIComponent(input.branch)}`);
  if (ref === null && await githubRepositoryIsEmpty(input.token, input.owner, input.repoName)) {
    await seedEmptyRepository(input);
    ref = await githubFetchMaybe<GithubRefResponse>(input.token, `${githubApiBase}/repos/${input.owner}/${input.repoName}/git/ref/heads/${encodeURIComponent(input.branch)}`);
    if (ref === null) {
      throw new Error("GitHub repository was initialized, but the branch ref is still unavailable.");
    }
  }
  const parentSha = ref?.object.sha ?? null;
  let baseTree: string | undefined;
  let existingTree: GithubTreeResponse | null = null;
  if (parentSha !== null) {
    const parent = await githubFetch<GithubCommitResponse>(input.token, `${githubApiBase}/repos/${input.owner}/${input.repoName}/git/commits/${parentSha}`);
    baseTree = parent.tree.sha;
    existingTree = await githubFetch<GithubTreeResponse>(input.token, `${githubApiBase}/repos/${input.owner}/${input.repoName}/git/trees/${parent.tree.sha}?recursive=1`);
  }
  const treeEntries = [];
  const exportedPaths = new Set(input.manifest.files.map((file) => file.path));
  if (input.writeMode === "replace") {
    for (const entry of existingTree?.tree ?? []) {
      if (entry.type === "blob" && !exportedPaths.has(entry.path)) {
        treeEntries.push({
          path: entry.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
      }
    }
  }
  for (const file of input.manifest.files) {
    const blob = await githubFetch<GithubBlobResponse>(input.token, `${githubApiBase}/repos/${input.owner}/${input.repoName}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({
        content: await readExportFileContent(file),
        encoding: "base64",
      }),
    });
    treeEntries.push({
      path: file.path,
      mode: file.executable ? "100755" : "100644",
      type: "blob",
      sha: blob.sha,
    });
  }
  const tree = await githubFetch<GithubTreeResponse>(input.token, `${githubApiBase}/repos/${input.owner}/${input.repoName}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseTree,
      tree: treeEntries,
    }),
  });
  const commit = await githubFetch<GithubCommitResponse>(input.token, `${githubApiBase}/repos/${input.owner}/${input.repoName}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: input.message,
      tree: tree.sha,
      parents: parentSha === null ? [] : [parentSha],
    }),
  });
  if (ref === null) {
    await githubFetch<GithubRefResponse>(input.token, `${githubApiBase}/repos/${input.owner}/${input.repoName}/git/refs`, {
      method: "POST",
      body: JSON.stringify({
        ref: `refs/heads/${input.branch}`,
        sha: commit.sha,
      }),
    });
  } else {
    await githubFetch<GithubRefResponse>(input.token, `${githubApiBase}/repos/${input.owner}/${input.repoName}/git/refs/heads/${encodeURIComponent(input.branch)}`, {
      method: "PATCH",
      body: JSON.stringify({
        sha: commit.sha,
        force: false,
      }),
    });
  }
  return { commitSha: commit.sha, treeSha: tree.sha };
}

export async function runGithubExport(workSessionId: Identifier, request: GithubExportRequest): Promise<GithubExportRecord> {
  if (activeProcessesForWorkSession(workSessionId).length > 0) {
    throw new Error("Stop the running agent before exporting this workspace.");
  }
  const snapshot = await getDatabaseSnapshot();
  const workSession = snapshot.workSessions.find((candidate) => candidate.id === workSessionId);
  if (workSession === undefined) {
    throw new Error("Work session was not found.");
  }
  const project = snapshot.projects.find((candidate) => candidate.id === workSession.projectId);
  if (project === undefined) {
    throw new Error("Project was not found.");
  }
  const { token, account } = await getGithubToken();
  const owner = assertOwner(request.owner ?? account.login);
  const repoName = assertRepoName(request.repoName ?? safeRepoName(project.slug || project.name));
  const branch = safeBranchName(request.branch ?? project.defaultBranch ?? workSession.activeBranch ?? "main");
  const visibility = request.visibility ?? "private";
  const writeMode: GithubExportWriteMode = request.writeMode === "replace" ? "replace" : "additive";
  const sourceMode = request.sourceMode ?? "current_workspace";
  const updateExisting = request.updateExisting === true || snapshot.githubExports.some((record) =>
    record.status === "completed" &&
    record.projectId === project.id &&
    record.accountLogin === account.login &&
    record.repoOwner.toLowerCase() === owner.toLowerCase() &&
    record.repoName.toLowerCase() === repoName.toLowerCase()
  );
  const resolved = await resolveExportRoot({
    workSessionId,
    sourceMode,
    checkpointId: request.checkpointId ?? null,
  });
  let exportRecord: GithubExportRecord | null = null;
  try {
    const manifest = await createGithubExportManifest(resolved.root);
    if (manifest.fileCount === 0) {
      throw new Error("No exportable files were found.");
    }
    exportRecord = await mutateDatabase((db) => {
      const record = createGithubExportRecord({
        workSessionId,
        projectId: project.id,
        accountLogin: account.login,
        repoOwner: owner,
        repoName,
        repoUrl: "",
        htmlUrl: "",
        branch,
        visibility,
        writeMode,
        sourceMode,
        sourceCheckpointId: resolved.checkpointId,
        status: "running",
        commitSha: null,
        treeSha: null,
        fileCount: manifest.fileCount,
        byteCount: manifest.byteCount,
        ignoredCount: manifest.ignored.length,
        failureSummary: null,
        reportArtifactId: null,
      });
      db.githubExports.push(record);
      return { ...record };
    });
    await emitEvent({
      workSessionId,
      eventName: "github.export.started",
      aggregateType: "github_export",
      aggregateId: exportRecord.id,
      payload: { message: `Exporting ${manifest.fileCount} file(s) to GitHub.`, repoOwner: owner, repoName, branch } satisfies JsonObject,
    });
    const repo = await resolveOrCreateRepo({
      token,
      owner,
      repoName,
      visibility,
      updateExisting,
      accountLogin: account.login,
    });
    await emitEvent({
      workSessionId,
      eventName: "github.export.repo_resolved",
      aggregateType: "github_export",
      aggregateId: exportRecord.id,
      payload: { message: `Resolved GitHub repository ${repo.full_name}.`, repoUrl: repo.html_url } satisfies JsonObject,
    });
    const commit = await createCommit({
      token,
      owner: repo.owner.login,
      repoName: repo.name,
      branch,
      manifest,
      writeMode,
      message: [
        `Export ${project.name}`,
        `Exported from Agentic Control Freak.`,
        `workSession=${workSession.id}`,
        resolved.checkpointId === null ? "source=current_workspace" : `sourceCheckpoint=${resolved.checkpointId}`,
      ].join("\n\n"),
    });
    await emitEvent({
      workSessionId,
      eventName: "github.export.commit_created",
      aggregateType: "github_export",
      aggregateId: exportRecord.id,
      payload: { message: `Created GitHub commit ${commit.commitSha.slice(0, 12)}.`, commitSha: commit.commitSha } satisfies JsonObject,
    });
    const report = [
      `# GitHub Export`,
      ``,
      `Repository: ${repo.html_url}`,
      `Branch: ${branch}`,
      `Commit: ${commit.commitSha}`,
      `Source: ${sourceMode}${resolved.checkpointId === null ? "" : ` (${resolved.checkpointId})`}`,
      `Write mode: ${writeMode}${writeMode === "replace" ? " (deleted repo files not in this export)" : " (kept existing repo files not in this export)"}`,
      `Files: ${manifest.fileCount}`,
      `Bytes: ${manifest.byteCount}`,
      ``,
      `## Exported files`,
      ...manifest.files.map((file) => `- ${file.path} (${file.byteCount} bytes)`),
      ``,
      `## Ignored entries`,
      ...(manifest.ignored.length === 0 ? ["- None"] : manifest.ignored.map((entry) => `- ${entry.path}: ${entry.reason}`)),
    ].join("\n");
    const artifact = await saveArtifact({
      workSessionId,
      kind: "report",
      fileName: `github-export-${exportRecord.id}.md`,
      content: report,
      metadata: {
        artifactRole: "github_export_report",
        contentType: "text/markdown; charset=utf-8",
        repoUrl: repo.html_url,
        commitSha: commit.commitSha,
      },
    });
    const completed = await mutateDatabase((db) => {
      const record = db.githubExports.find((candidate) => candidate.id === exportRecord?.id);
      if (record === undefined) {
        throw new Error("GitHub export record was not found.");
      }
      record.status = "completed";
      record.repoUrl = repo.clone_url;
      record.htmlUrl = repo.html_url;
      record.repoOwner = repo.owner.login;
      record.repoName = repo.name;
      record.visibility = repo.private ? "private" : "public";
      record.commitSha = commit.commitSha;
      record.treeSha = commit.treeSha;
      record.reportArtifactId = artifact.id;
      record.updatedAt = currentTimestamp();
      const projectRecord = db.projects.find((candidate) => candidate.id === project.id);
      if (projectRecord !== undefined) {
        projectRecord.repoUrl = repo.html_url;
        projectRecord.defaultBranch = branch;
      }
      return { ...record };
    });
    await emitEvent({
      workSessionId,
      eventName: "github.export.completed",
      aggregateType: "github_export",
      aggregateId: exportRecord.id,
      priority: "high",
      payload: { message: `Exported workspace to ${repo.html_url}.`, repoUrl: repo.html_url, commitSha: commit.commitSha, artifactId: artifact.id } satisfies JsonObject,
    });
    return completed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub export error.";
    if (exportRecord !== null) {
      await mutateDatabase((db) => {
        const record = db.githubExports.find((candidate) => candidate.id === exportRecord?.id);
        if (record !== undefined) {
          record.status = "failed";
          record.failureSummary = message;
          record.updatedAt = currentTimestamp();
        }
      });
      await emitEvent({
        workSessionId,
        eventName: "github.export.failed",
        aggregateType: "github_export",
        aggregateId: exportRecord.id,
        priority: "high",
        payload: { message, repoOwner: owner, repoName } satisfies JsonObject,
      });
    }
    throw error;
  } finally {
    await resolved.cleanup?.();
  }
}
