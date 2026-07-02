import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";


const MAX_ABS_PATH_CHARS = 250;

export interface DataIngestCaps {
  /** Per-file size ceiling in bytes. */
  maxFileBytes: number;
  /** Aggregate size ceiling across one multi/folder upload, in bytes. */
  maxTotalBytes: number;
  /** Maximum number of files in one upload. */
  maxFiles: number;
}

export interface IngestWrittenEntry {
  path: string;
  bytes: number;
}

export interface IngestSkippedEntry {
  path: string;
  reason: string;
}

export interface IngestSummary {
  kind: "file" | "folder";
  /** The path the UI field should adopt: the destination folder (folder/multi) or the single file. */
  primaryPath: string;
  written: IngestWrittenEntry[];
  skipped: IngestSkippedEntry[];
  totalBytes: number;
  count: number;
}

export interface UploadedFileInput {
  /** The file's own name (basename) — used when no relativePath is supplied. */
  name: string;
  /** The browser webkitRelativePath, when a folder/structured upload preserves directories. */
  relativePath: string | null;
  bytes: Uint8Array;
}

export class DataIngestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataIngestError";
  }
}

export function resolveWorkspacePath(workspacePath: string, rel: string): string | null {
  const base = path.resolve(workspacePath);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return null;
  }
  return target;
}

export function sanitizeSegment(seg: string): string {
  const cleaned = (seg ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") {
    return "";
  }
  return cleaned;
}

export function confineDestinationDir(raw: unknown): { dir: string } | { error: string } {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim().length === 0)) {
    return { dir: "data" };
  }
  if (typeof raw !== "string") {
    return { error: "Upload destination directory must be a string." };
  }
  const normalized = raw.trim().replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.includes("\0")) {
    return { error: "Upload destination must be a workspace-relative path under data/." };
  }
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts[0] !== "data" || parts.some((part) => part === "." || part === "..")) {
    return { error: "Upload destination must stay under the workspace data/ folder." };
  }
  const safe = ["data", ...parts.slice(1).map(sanitizeSegment).filter((segment) => segment.length > 0)];
  return { dir: safe.join("/") };
}

export function sanitizeRelativeDataPath(
  rawRel: string,
  destinationDir: string,
): { rel: string } | { skip: string } {
  const normalized = (rawRel ?? "").replace(/\\/g, "/");
  if (normalized.includes("\0")) {
    return { skip: "null-byte" };
  }
  const rawParts = normalized.split("/").filter((part) => part.length > 0);
  if (rawParts.length === 0) {
    return { skip: "empty" };
  }
  if (rawParts.some((part) => part === "__MACOSX")) {
    return { skip: "metadata" };
  }
  const segments: string[] = [];
  for (const part of rawParts) {
    if (part === "." || part === "..") {
      return { skip: "path-escape" };
    }
    if (part.startsWith(".")) {
      return { skip: "dotfile" };
    }
    const safe = sanitizeSegment(part);
    if (safe.length === 0) {
      return { skip: "path-escape" };
    }
    segments.push(safe);
  }
  const rel = [destinationDir, ...segments].join("/");
  if (!(rel === "data" || rel.startsWith("data/"))) {
    return { skip: "path-escape" };
  }
  return { rel };
}

export async function writeUploadedFiles(input: {
  files: UploadedFileInput[];
  destinationDir: string;
  workspacePath: string;
  caps: DataIngestCaps;
}): Promise<IngestSummary> {
  const { files, destinationDir, workspacePath, caps } = input;
  if (files.length === 0) {
    throw new DataIngestError("No files were provided in the upload.");
  }
  if (files.length > caps.maxFiles) {
    throw new DataIngestError(`Too many files: ${files.length} (limit ${caps.maxFiles}).`);
  }

  const written: IngestWrittenEntry[] = [];
  const skipped: IngestSkippedEntry[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const raw = file.relativePath !== null && file.relativePath.length > 0 ? file.relativePath : file.name;
    const mapped = sanitizeRelativeDataPath(raw, destinationDir);
    if ("skip" in mapped) {
      skipped.push({ path: raw, reason: mapped.skip });
      continue;
    }
    const bytes = file.bytes.byteLength;
    if (bytes > caps.maxFileBytes) {
      throw new DataIngestError(
        `File ${mapped.rel} is ${Math.round(bytes / 1048576)}MB, over the ${Math.round(caps.maxFileBytes / 1048576)}MB per-file limit.`,
      );
    }
    if (totalBytes + bytes > caps.maxTotalBytes) {
      throw new DataIngestError(`Upload exceeds the ${Math.round(caps.maxTotalBytes / 1048576)}MB total limit.`);
    }
    const target = resolveWorkspacePath(workspacePath, mapped.rel);
    if (target === null) {
      skipped.push({ path: mapped.rel, reason: "path-escape" });
      continue;
    }
    if (target.length > MAX_ABS_PATH_CHARS) {
      skipped.push({ path: mapped.rel, reason: "path-too-long" });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
    totalBytes += bytes;
    written.push({ path: mapped.rel, bytes });
  }

  if (written.length === 0) {
    const reasons = [...new Set(skipped.map((entry) => entry.reason))].join(", ");
    throw new DataIngestError(
      `No files were written; all ${skipped.length} were rejected${reasons.length > 0 ? ` (${reasons})` : ""}.`,
    );
  }

  const kind: "file" | "folder" = destinationDir !== "data" || written.length > 1 ? "folder" : "file";
  const primaryPath = kind === "folder" ? destinationDir : written[0].path;
  return { kind, primaryPath, written, skipped, totalBytes, count: written.length };
}
