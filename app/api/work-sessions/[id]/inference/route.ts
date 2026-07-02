import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/server/config";
import { logProcess } from "@/lib/server/logging";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { stackCapabilities } from "@/lib/shared/stack-capabilities";
import { readExperimentManifest } from "@/lib/server/ml/experiment-manifest";
import { abortWorkSessionOperationsByKind } from "@/lib/server/runtime/operation-registry";
import {
  ensureInferenceWorker,
  getInferenceWorkerInfo,
  getStaticInferenceContract,
  inferenceSandboxDir,
  isInferenceAvailable,
  runInferencePrediction,
  stopInferenceWorker,
  InferenceRuntimeError,
} from "@/lib/server/ml/inference-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_UPLOAD_FILES = 16;

function mimeFromExtension(rel: string): string {
  const ext = rel.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "bmp": return "image/bmp";
    case "pdf": return "application/pdf";
    case "wav": return "audio/wav";
    case "mp3": return "audio/mpeg";
    case "ogg": return "audio/ogg";
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "json": return "application/json";
    case "csv": return "text/csv";
    case "txt": return "text/plain";
    default: return "application/octet-stream";
  }
}

function parseJsonObjectField(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {};
  }
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safeUploadName(name: string, index: number): string {
  const base = path.basename(name || "upload").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const cleaned = base.length > 0 ? base : "upload";
  return `${index}__${cleaned}`;
}

/** Replace `{ $file: rel }` output nodes with a served descriptor the client can render/download. */
function materializeOutputs(value: unknown, workSessionId: string, depth = 0): unknown {
  if (depth > 12) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => materializeOutputs(entry, workSessionId, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$file === "string") {
      const rel = obj.$file;
      const mime = typeof obj.mime === "string" ? obj.mime : mimeFromExtension(rel);
      const name = rel.split("/").pop() ?? "output";
      const url = `/api/work-sessions/${workSessionId}/inference/output?path=${encodeURIComponent(rel)}&mime=${encodeURIComponent(mime)}`;
      return { kind: "file", name, mime, url };
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(obj)) {
      out[key] = materializeOutputs(entry, workSessionId, depth + 1);
    }
    return out;
  }
  return value;
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const config = getConfig();
    const snapshot = await getDatabaseSnapshot();
    const workSession = snapshot.workSessions.find((session) => session.id === id);
    if (workSession === undefined) {
      return NextResponse.json({ ok: false, error: "Work session was not found." }, { status: 404 });
    }
    const manifest = await readExperimentManifest(workSession.activeWorktreePath);
    const enabled = config.mlPipelineEnabled
      && (manifest !== null
        || workSession.stackDecision?.stack === "python-ml"
        || stackCapabilities(workSession.stackDecision?.stack ?? "unknown").supportsExperimentRuntime === true);
    if (!enabled) {
      return NextResponse.json({ ok: true, data: { enabled: false, available: false, contract: null, worker: getInferenceWorkerInfo(id) } });
    }
    const available = await isInferenceAvailable(workSession.activeWorktreePath);
    const worker = getInferenceWorkerInfo(id);
    const staticContract = await getStaticInferenceContract(workSession.activeWorktreePath);
    return NextResponse.json({
      ok: true,
      data: {
        enabled,
        available,
        contract: worker.contract ?? staticContract,
        worker,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown inference metadata error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
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

    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    const isMultipart = contentType.includes("multipart/form-data");

    if (!isMultipart) {
      const body = (await request.json().catch(() => ({}))) as { action?: string };
      const action = body.action;
      if (action === "start") {
        const worker = await ensureInferenceWorker(id);
        return NextResponse.json({ ok: true, data: { worker } });
      }
      if (action === "stop") {
        const stopped = await stopInferenceWorker(id, "Inference worker stopped by user.");
        return NextResponse.json({ ok: true, data: { stopped } });
      }
      if (action === "abort") {
        const aborted = abortWorkSessionOperationsByKind(id, "inference", "User aborted inference.");
        return NextResponse.json({ ok: true, data: { aborted } });
      }
      return NextResponse.json({ ok: false, error: "Invalid inference request." }, { status: 400 });
    }

    const form = await request.formData();
    if (form.get("action") !== "predict") {
      return NextResponse.json({ ok: false, error: "Invalid multipart inference request." }, { status: 400 });
    }
    const requestId = randomUUID();
    const inputs = parseJsonObjectField(form.get("inputs"));
    const options = parseJsonObjectField(form.get("options"));

    const maxBytes = Math.max(1, config.mlInferenceMaxUploadMb) * 1024 * 1024;
    const inputsDir = path.join(inferenceSandboxDir(workSession.activeWorktreePath), "inputs", requestId);
    const filesByField = new Map<string, File[]>();
    let fileCount = 0;
    for (const [key, value] of form.entries()) {
      if (!key.startsWith("file:") || !(value instanceof File) || value.size === 0) {
        continue;
      }
      const field = key.slice("file:".length);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
        continue;
      }
      fileCount += 1;
      if (fileCount > MAX_UPLOAD_FILES) {
        return NextResponse.json({ ok: false, error: `Too many files. Attach at most ${MAX_UPLOAD_FILES}.` }, { status: 400 });
      }
      if (value.size > maxBytes) {
        return NextResponse.json(
          { ok: false, error: `${value.name || "upload"} exceeds the ${config.mlInferenceMaxUploadMb} MB inference upload limit.` },
          { status: 400 },
        );
      }
      const list = filesByField.get(field) ?? [];
      list.push(value);
      filesByField.set(field, list);
    }

    if (fileCount > 0) {
      await mkdir(inputsDir, { recursive: true });
    }
    let savedIndex = 0;
    for (const [field, files] of filesByField.entries()) {
      const refs: Array<{ $file: string }> = [];
      for (const file of files) {
        const fileName = safeUploadName(file.name, savedIndex);
        savedIndex += 1;
        const bytes = Buffer.from(await file.arrayBuffer());
        await writeFile(path.join(inputsDir, fileName), bytes);
        refs.push({ $file: `inputs/${requestId}/${fileName}` });
      }
      inputs[field] = refs.length === 1 ? refs[0] : refs;
    }

    if (form.get("stream") === "true") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const writeLine = (payload: unknown): void => {
            controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
          };
          try {
            const prediction = await runInferencePrediction({
              workSessionId: id,
              requestId,
              inputs,
              options,
              onToken: (text) => writeLine({ type: "token", text }),
            });
            writeLine({ type: "result", outputs: materializeOutputs(prediction.outputs, id), timingMs: prediction.timingMs });
            logProcess("info", "inference.predict.ok", { workSessionId: id, requestId, timingMs: prediction.timingMs, streamed: true });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown inference error.";
            writeLine({ type: "error", error: message });
            logProcess("warn", "inference.predict.stream_error", { workSessionId: id, requestId, message });
          } finally {
            controller.close();
          }
        },
      });
      return new NextResponse(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
      });
    }

    const prediction = await runInferencePrediction({ workSessionId: id, requestId, inputs, options });
    logProcess("info", "inference.predict.ok", { workSessionId: id, requestId, timingMs: prediction.timingMs });
    return NextResponse.json({
      ok: true,
      data: {
        outputs: materializeOutputs(prediction.outputs, id),
        timingMs: prediction.timingMs,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown inference error.";
    const status = error instanceof InferenceRuntimeError ? 400 : 500;
    logProcess("warn", "inference.api.failed", { status, message });
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
