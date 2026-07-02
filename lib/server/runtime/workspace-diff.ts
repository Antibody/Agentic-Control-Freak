import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { CodeChangeRecord } from "@/lib/shared/types";

export interface WorkspaceFileSnapshot {
  filePath: string;
  size: number;
  mtimeMs: number;
  hash: string;
}

export type WorkspaceSnapshot = Map<string, WorkspaceFileSnapshot>;

const ignoredDirectoryNames = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".orchestrator",
  ".turbo",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "out",
  "__pycache__",
]);

const ignoredFileNames = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
]);

function normalizePath(input: string): string {
  return input.replace(/\\/g, "/");
}

function shouldIgnore(relativePath: string, name: string, isDirectory: boolean): boolean {
  if (isDirectory && ignoredDirectoryNames.has(name)) {
    return true;
  }
  if (!isDirectory && (ignoredFileNames.has(name) || name.endsWith(".tsbuildinfo") || name === ".DS_Store" || name === "Thumbs.db")) {
    return true;
  }
  const normalized = normalizePath(relativePath);
  return normalized.includes("/.orchestrator/")
    || normalized.includes("/.gemini/")
    || normalized.includes("/.antigravity/")
    || normalized.includes("/.antigravitycli/")
    || normalized.includes("/.agy/")
    || normalized.includes("/node_modules/")
    || normalized.includes("/.next/");
}

async function hashFile(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath);
  return createHash("sha256").update(content).digest("hex");
}

async function collectWorkspaceFiles(root: string, current = "", depth = 0): Promise<WorkspaceFileSnapshot[]> {
  if (depth > 20) {
    return [];
  }

  let entries;
  try {
    entries = await readdir(path.join(root, current), { withFileTypes: true });
  } catch {
    return [];
  }

  const files: WorkspaceFileSnapshot[] = [];
  for (const entry of entries) {
    const relativePath = current.length === 0 ? entry.name : path.join(current, entry.name);
    if (shouldIgnore(relativePath, entry.name, entry.isDirectory())) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await collectWorkspaceFiles(root, relativePath, depth + 1));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const absolutePath = path.join(root, relativePath);
    const fileStat = await stat(absolutePath);
    files.push({
      filePath: normalizePath(relativePath),
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      hash: await hashFile(absolutePath),
    });
  }
  return files;
}

export async function snapshotWorkspace(workspacePath: string): Promise<WorkspaceSnapshot> {
  const files = await collectWorkspaceFiles(workspacePath);
  return new Map(files.map((file) => [file.filePath, file]));
}

async function excerptForFile(workspacePath: string, filePath: string): Promise<string> {
  try {
    const content = await readFile(path.join(workspacePath, filePath), "utf8");
    return content.slice(0, 1200);
  } catch {
    return "";
  }
}

export async function compareWorkspaceSnapshots(input: {
  workspacePath: string;
  before: WorkspaceSnapshot;
  after: WorkspaceSnapshot;
}): Promise<Omit<CodeChangeRecord, "id" | "agentRunId" | "createdAt">[]> {
  const changes: Omit<CodeChangeRecord, "id" | "agentRunId" | "createdAt">[] = [];
  const deleted = [...input.before.values()].filter((file) => !input.after.has(file.filePath));
  const created = [...input.after.values()].filter((file) => !input.before.has(file.filePath));

  const unmatchedCreated = new Map(created.map((file) => [file.filePath, file]));
  for (const beforeFile of deleted) {
    const renamed = [...unmatchedCreated.values()].find((afterFile) => afterFile.hash === beforeFile.hash && afterFile.size === beforeFile.size);
    if (renamed !== undefined) {
      unmatchedCreated.delete(renamed.filePath);
      changes.push({
        filePath: renamed.filePath,
        changeKind: "rename",
        diffExcerpt: `${beforeFile.filePath} -> ${renamed.filePath}`,
      });
      continue;
    }
    changes.push({
      filePath: beforeFile.filePath,
      changeKind: "delete",
      diffExcerpt: "File deleted.",
    });
  }

  for (const afterFile of unmatchedCreated.values()) {
    changes.push({
      filePath: afterFile.filePath,
      changeKind: "create",
      diffExcerpt: await excerptForFile(input.workspacePath, afterFile.filePath),
    });
  }

  for (const afterFile of input.after.values()) {
    const beforeFile = input.before.get(afterFile.filePath);
    if (beforeFile !== undefined && beforeFile.hash !== afterFile.hash) {
      changes.push({
        filePath: afterFile.filePath,
        changeKind: "update",
        diffExcerpt: await excerptForFile(input.workspacePath, afterFile.filePath),
      });
    }
  }

  return changes.sort((a, b) => a.filePath.localeCompare(b.filePath));
}
