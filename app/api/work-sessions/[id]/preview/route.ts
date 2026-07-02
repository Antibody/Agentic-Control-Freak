import { NextRequest, NextResponse } from "next/server";
import { getDatabaseSnapshot, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { completeCommandReceipt, failCommandReceipt, idempotencyKeyFromRequest, startCommandReceipt } from "@/lib/server/command-receipts";
import { getConfig } from "@/lib/server/config";
import { armPreviewIdleStopForWorkSession, detectPreviewCommand, listPythonEntrypoints, listREntrypoints, startPreviewForWorkSession, stopPreview, sweepExpiredPreviewIdleStops } from "@/lib/server/preview-manager";
import { repairPreviewFailure } from "@/lib/server/workflow-controller";
import { isPythonRunParamsEmpty, normalizePythonRunParams } from "@/lib/shared/python-run";
import { isRRunParamsEmpty, normalizeRRunParams } from "@/lib/shared/r-run";
import type { WorkSessionState } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PreviewPostRequest {
  action?: "start" | "restart" | "stop" | "repair" | "open";
  previewId?: string;
  runParams?: unknown;
}

function isIdleTerminalState(state: WorkSessionState): boolean {
  return state === "completed" || state === "blocked" || state === "failed" || state === "canceled" || state === "handoff_needed";
}

function isPreviewPostRequest(value: unknown): value is PreviewPostRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.action === undefined || candidate.action === "start" || candidate.action === "restart" || candidate.action === "stop" || candidate.action === "repair" || candidate.action === "open") &&
    (candidate.previewId === undefined || typeof candidate.previewId === "string")
  );
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    await sweepExpiredPreviewIdleStops("preview-api-get");
    const params = await context.params;
    const snapshot = await getDatabaseSnapshot();
    const workSession = snapshot.workSessions.find((candidate) => candidate.id === params.id);
    if (workSession === undefined) {
      return NextResponse.json({ ok: false, error: "Work session was not found." }, { status: 404 });
    }
    const config = getConfig();
    const command = await detectPreviewCommand(workSession.activeWorktreePath, config.previewPortStart, config.previewHost);
    const supportsPythonRunParams = command.appType === "python-script";
    const supportsRRunParams = command.appType === "r-script";
    const runParamsKind = supportsPythonRunParams ? "python" : supportsRRunParams ? "r" : null;
    const entrypoints = supportsPythonRunParams
      ? await listPythonEntrypoints(workSession.activeWorktreePath)
      : supportsRRunParams
        ? await listREntrypoints(workSession.activeWorktreePath)
        : [];
    return NextResponse.json({
      ok: true,
      data: {
        entrypoints,
        runParams: supportsPythonRunParams
          ? workSession.pythonRunParams
          : supportsRRunParams
            ? workSession.rRunParams
            : null,
        supportsPythonRunParams,
        supportsRRunParams,
        supportsRunParams: supportsPythonRunParams || supportsRRunParams,
        runParamsKind,
        appType: command.appType,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown preview metadata error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  let receiptId = "";
  try {
    await sweepExpiredPreviewIdleStops("preview-api-post");
    const params = await context.params;
    const body = (await request.json().catch(() => ({}))) as unknown;
    if (!isPreviewPostRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid preview request." }, { status: 400 });
    }
    const receipt = await startCommandReceipt({
      workSessionId: params.id,
      commandType: "preview",
      idempotencyKey: idempotencyKeyFromRequest(request.headers, body),
      requestBody: body,
    });
    if (receipt.mode === "replay") {
      return NextResponse.json(receipt.response, { status: receipt.response.ok ? 200 : 409 });
    }
    receiptId = receipt.receiptId;

    const snapshot = await getDatabaseSnapshot();
    const workSession = snapshot.workSessions.find((candidate) => candidate.id === params.id);
    if (workSession === undefined) {
      return NextResponse.json({ ok: false, error: "Work session was not found." }, { status: 404 });
    }

    if (body.action === "repair") {
      if (body.previewId === undefined) {
        return NextResponse.json({ ok: false, error: "Preview id is required for repair." }, { status: 400 });
      }
      const result = await repairPreviewFailure({ workSessionId: workSession.id, previewId: body.previewId });
      await completeCommandReceipt(receiptId, result);
      return NextResponse.json({ ok: true, data: result });
    }

    if (body.action === "stop") {
      const preview = body.previewId !== undefined
        ? snapshot.previewServers.find((candidate) => candidate.id === body.previewId)
        : snapshot.previewServers.find((candidate) => candidate.workSessionId === workSession.id && candidate.status !== "stopped");
      if (preview === undefined) {
        return NextResponse.json({ ok: false, error: "Preview server was not found." }, { status: 404 });
      }
      const stopped = await stopPreview(preview.id, "manual");
      await completeCommandReceipt(receiptId, stopped);
      return NextResponse.json({ ok: true, data: stopped });
    }

    let activeWorkSession = workSession;
    if ((body as PreviewPostRequest).runParams !== undefined) {
      const config = getConfig();
      const command = await detectPreviewCommand(workSession.activeWorktreePath, config.previewPortStart, config.previewHost);
      if (command.appType !== "python-script" && command.appType !== "r-script") {
        return NextResponse.json({ ok: false, error: "Run parameters are only available for Python or R script previews." }, { status: 400 });
      }
      const isR = command.appType === "r-script";
      const pythonValue = isR ? null : (() => {
        const normalized = normalizePythonRunParams((body as PreviewPostRequest).runParams);
        return isPythonRunParamsEmpty(normalized) ? null : normalized;
      })();
      const rValue = !isR ? null : (() => {
        const normalized = normalizeRRunParams((body as PreviewPostRequest).runParams);
        return isRRunParamsEmpty(normalized) ? null : normalized;
      })();
      activeWorkSession = await mutateDatabase((db) => {
        const record = db.workSessions.find((candidate) => candidate.id === params.id);
        if (record === undefined) {
          throw new Error("Work session was not found.");
        }
        if (isR) {
          record.rRunParams = rValue;
        } else {
          record.pythonRunParams = pythonValue;
        }
        updateWorkSessionTimestamp(record);
        return { ...record };
      });
    }

    const preview = await startPreviewForWorkSession(activeWorkSession, {
      policy: body.action === "restart" || body.runParams !== undefined ? "hard_restart" : "refresh_existing_or_start",
    });
    if (isIdleTerminalState(activeWorkSession.currentState)) {
      await armPreviewIdleStopForWorkSession(activeWorkSession.id, body.action === "open" ? "open" : "manual-preview-action");
    }
    await completeCommandReceipt(receiptId, preview);
    return NextResponse.json({ ok: true, data: preview });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown preview API error.";
    await failCommandReceipt(receiptId, error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
