import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/server/config";
import { logProcess } from "@/lib/server/logging";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { evaluateLocalApiGuard } from "@/lib/shared/local-api-guard";
import {
  confineDestinationDir,
  DataIngestError,
  resolveWorkspacePath,
  writeUploadedFiles,
  type UploadedFileInput,
} from "@/lib/server/ml/data-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeDataFilename(name: string, fallback: string): string {
  const base = (name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

function dataDestinationPath(raw: unknown, filename: string): { path: string | null } | { error: string } {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { path: null };
  }
  const normalized = raw.trim().replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.includes("\0")) {
    return { error: "Upload destination must be a workspace-relative path under data/." };
  }
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts[0] !== "data" || parts.some((part) => part === "." || part === "..")) {
    return { error: "Upload destination must stay under the workspace data/ folder." };
  }
  const leaf = parts[parts.length - 1] ?? "";
  if (leaf !== filename) {
    if (leaf.includes(".")) {
      parts.pop();
    }
    parts.push(filename);
  }
  const rel = parts.join("/");
  if (!rel.startsWith("data/")) {
    return { error: "Upload destination must resolve to a file under data/." };
  }
  return { path: rel };
}

type ParsedUpload =
  | { mode: "single"; filename: string; bytes: Uint8Array; destinationPath: string | null }
  | { mode: "multi"; files: UploadedFileInput[]; destinationDir: string };

function parseRelativePaths(raw: unknown, count: number): Array<string | null> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return new Array(count).fill(null);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Array(count).fill(null);
    }
    return new Array(count).fill(null).map((_, index) => {
      const value = parsed[index];
      return typeof value === "string" && value.length > 0 ? value : null;
    });
  } catch {
    return new Array(count).fill(null);
  }
}

async function readUpload(request: NextRequest, maxUploadBytes: number): Promise<{ result: ParsedUpload } | { error: string }> {
  const config = getConfig();
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      logProcess("warn", "data.upload.formdata_failed", { message });
      return { error: `Could not parse the uploaded form data: ${message}` };
    }
    const fileParts = form.getAll("file").filter((part): part is File => part instanceof File);
    if (fileParts.length === 0) {
      return { error: "No file was provided in the upload." };
    }

    const relativePathsRaw = form.get("relativePaths");
    const destinationDirRaw = form.get("destinationDir");
    const hasMulti =
      fileParts.length > 1
      || (typeof relativePathsRaw === "string" && relativePathsRaw.trim().length > 0)
      || (typeof destinationDirRaw === "string" && destinationDirRaw.trim().length > 0);

    if (!hasMulti) {
      const file = fileParts[0];
      if (file.size > maxUploadBytes) {
        return { error: `The uploaded file is ${Math.round(file.size / 1048576)}MB, over the ${Math.round(maxUploadBytes / 1048576)}MB limit.` };
      }
      const requested = typeof form.get("filename") === "string" ? (form.get("filename") as string) : file.name;
      const filename = safeDataFilename(requested, "corpus.txt");
      const destination = dataDestinationPath(form.get("destinationPath"), filename);
      if ("error" in destination) {
        return { error: destination.error };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      return { result: { mode: "single", filename, bytes, destinationPath: destination.path } };
    }

    if (fileParts.length > config.mlDataUploadMaxFiles) {
      return { error: `Too many files: ${fileParts.length} (limit ${config.mlDataUploadMaxFiles}).` };
    }
    const destination = confineDestinationDir(destinationDirRaw);
    if ("error" in destination) {
      return { error: destination.error };
    }
    const relativePaths = parseRelativePaths(relativePathsRaw, fileParts.length);
    const maxTotalBytes = config.mlDataUploadMaxTotalMb * 1024 * 1024;
    let total = 0;
    const files: UploadedFileInput[] = [];
    for (let index = 0; index < fileParts.length; index += 1) {
      const file = fileParts[index];
      if (file.size > maxUploadBytes) {
        return { error: `A file is ${Math.round(file.size / 1048576)}MB, over the ${Math.round(maxUploadBytes / 1048576)}MB per-file limit.` };
      }
      total += file.size;
      if (total > maxTotalBytes) {
        return { error: `Upload exceeds the ${config.mlDataUploadMaxTotalMb}MB total limit.` };
      }
      files.push({
        name: file.name,
        relativePath: relativePaths[index],
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
    }
    return { result: { mode: "multi", files, destinationDir: destination.dir } };
  }

  const body = (await request.json().catch(() => null)) as { text?: unknown; filename?: unknown; destinationPath?: unknown } | null;
  if (body === null || typeof body.text !== "string") {
    return { error: "Provide either a multipart 'file' or a JSON body with a 'text' string." };
  }
  const bytes = new TextEncoder().encode(body.text);
  if (bytes.byteLength > maxUploadBytes) {
    return { error: `The pasted text is over the ${Math.round(maxUploadBytes / 1048576)}MB limit.` };
  }
  const requested = typeof body.filename === "string" ? body.filename : "corpus.txt";
  const filename = safeDataFilename(requested, "corpus.txt");
  const destination = dataDestinationPath(body.destinationPath, filename);
  if ("error" in destination) {
    return { error: destination.error };
  }
  return { result: { mode: "single", filename, bytes, destinationPath: destination.path } };
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const guard = evaluateLocalApiGuard({
      hostHeader: request.headers.get("host"),
      originHeader: request.headers.get("origin"),
      protocol: request.nextUrl.protocol,
    });
    if (!guard.allowed) {
      return NextResponse.json(
        { ok: false, error: `Request rejected by local-only guard: ${guard.reason ?? "request denied."}` },
        { status: 403 },
      );
    }
    const { id } = await context.params;
    const config = getConfig();
    if (!config.mlPipelineEnabled) {
      return NextResponse.json({ ok: false, error: "The ML pipeline is disabled." }, { status: 400 });
    }
    const snapshot = await getDatabaseSnapshot();
    const workSession = snapshot.workSessions.find((session) => session.id === id);
    if (workSession === undefined) {
      return NextResponse.json({ ok: false, error: "Work session was not found." }, { status: 404 });
    }

    const maxUploadBytes = config.mlDataUploadMaxMb * 1024 * 1024;
    const upload = await readUpload(request, maxUploadBytes);
    if ("error" in upload) {
      return NextResponse.json({ ok: false, error: upload.error }, { status: 400 });
    }

    const workspacePath = workSession.activeWorktreePath;

    if (upload.result.mode === "multi") {
      try {
        const summary = await writeUploadedFiles({
          files: upload.result.files,
          destinationDir: upload.result.destinationDir,
          workspacePath,
          caps: {
            maxFileBytes: maxUploadBytes,
            maxTotalBytes: config.mlDataUploadMaxTotalMb * 1024 * 1024,
            maxFiles: config.mlDataUploadMaxFiles,
          },
        });
        logProcess("info", "experiment.corpus.uploaded", {
          workSessionId: id,
          path: summary.primaryPath,
          kind: summary.kind,
          count: summary.count,
          skipped: summary.skipped.length,
          bytes: summary.totalBytes,
        });
        return NextResponse.json({
          ok: true,
          data: {
            path: summary.primaryPath,
            kind: summary.kind,
            bytes: summary.totalBytes,
            count: summary.count,
            written: summary.written,
            skipped: summary.skipped,
          },
        });
      } catch (error) {
        if (error instanceof DataIngestError) {
          return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
        }
        throw error;
      }
    }

    const relPath = upload.result.destinationPath ?? `data/${upload.result.filename}`;
    const target = resolveWorkspacePath(workspacePath, relPath);
    if (target === null) {
      return NextResponse.json({ ok: false, error: "Resolved upload path escapes the workspace." }, { status: 400 });
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, upload.result.bytes);

    logProcess("info", "experiment.corpus.uploaded", {
      workSessionId: id,
      path: relPath,
      bytes: upload.result.bytes.byteLength,
    });
    return NextResponse.json({ ok: true, data: { path: relPath, kind: "file", bytes: upload.result.bytes.byteLength } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown corpus upload error.";
    logProcess("warn", "experiment.corpus.upload_failed", { message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
