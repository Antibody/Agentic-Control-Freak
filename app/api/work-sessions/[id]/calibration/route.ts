import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/server/config";
import { logProcess } from "@/lib/server/logging";
import {
  completeCommandReceipt,
  failCommandReceipt,
  idempotencyKeyFromRequest,
  startCommandReceipt,
} from "@/lib/server/command-receipts";
import { abortWorkSessionOperationsByKind } from "@/lib/server/runtime/operation-registry";
import {
  CalibrationRuntimeError,
  getCalibrationStatus,
  startCalibrationRun,
} from "@/lib/server/ml/calibration-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CalibrationAction = "run-calibration" | "abort-calibration";

interface CalibrationPostRequest {
  action: CalibrationAction;
  autoRestartInference?: boolean;
  allowShort?: boolean;
  smoke?: boolean;
  calibrationData?: string;
  oodValidationData?: string;
}

function isCalibrationPostRequest(value: unknown): value is CalibrationPostRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const action = (value as Record<string, unknown>).action;
  return action === "run-calibration" || action === "abort-calibration";
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const allowShort = false;
    const status = await getCalibrationStatus(id, { allowShort });
    return NextResponse.json({ ok: true, data: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown calibration metadata error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  let receiptId = "";
  try {
    const { id } = await context.params;
    const config = getConfig();
    if (!config.mlPipelineEnabled) {
      return NextResponse.json({ ok: false, error: "The ML pipeline is disabled." }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as unknown;
    if (!isCalibrationPostRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid calibration request." }, { status: 400 });
    }

    if (body.action === "abort-calibration") {
      const aborted = abortWorkSessionOperationsByKind(id, "calibration", "User aborted calibration.");
      return NextResponse.json({ ok: true, data: { aborted } });
    }

    const receipt = await startCommandReceipt({
      workSessionId: id,
      commandType: "calibration",
      idempotencyKey: idempotencyKeyFromRequest(request.headers, body),
      requestBody: body,
    });
    if (receipt.mode === "replay") {
      return NextResponse.json(receipt.response, { status: receipt.response.ok ? 200 : 409 });
    }
    receiptId = receipt.receiptId;

    const run = await startCalibrationRun({
      workSessionId: id,
      smoke: body.smoke === true,
      allowShort: body.allowShort === true,
      autoRestartInference: body.autoRestartInference !== false,
      calibrationData: typeof body.calibrationData === "string" ? body.calibrationData : undefined,
      oodValidationData: typeof body.oodValidationData === "string" ? body.oodValidationData : undefined,
    });
    await completeCommandReceipt(receiptId, run);
    return NextResponse.json({ ok: true, data: run });
  } catch (error) {
    if (receiptId.length > 0) {
      await failCommandReceipt(receiptId, error);
    }
    const message = error instanceof Error ? error.message : "Unknown calibration API error.";
    const status = error instanceof CalibrationRuntimeError ? 400 : 500;
    logProcess("warn", "calibration.api.failed", { status, message });
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
