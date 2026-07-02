import { NextRequest, NextResponse } from "next/server";
import { runGithubExport } from "@/lib/server/github-exporter";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { completeCommandReceipt, failCommandReceipt, idempotencyKeyFromRequest, startCommandReceipt } from "@/lib/server/command-receipts";
import type { GithubExportSourceMode, GithubExportWriteMode, GithubRepositoryVisibility } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface ExportRequest {
  owner?: string;
  repoName?: string;
  branch?: string;
  visibility?: GithubRepositoryVisibility;
  sourceMode?: GithubExportSourceMode;
  checkpointId?: string | null;
  updateExisting?: boolean;
  writeMode?: GithubExportWriteMode;
}

function isExportRequest(value: unknown): value is ExportRequest {
  return typeof value === "object" && value !== null;
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const db = await getDatabaseSnapshot();
    const exports = db.githubExports
      .filter((record) => record.workSessionId === params.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return NextResponse.json({ ok: true, data: { exports } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub export history error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  let receiptId = "";
  try {
    const params = await context.params;
    const body = (await request.json().catch(() => null)) as unknown;
    if (!isExportRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid GitHub export request." }, { status: 400 });
    }
    const receipt = await startCommandReceipt({
      workSessionId: params.id,
      commandType: "github-export",
      idempotencyKey: idempotencyKeyFromRequest(request.headers, body),
      requestBody: body,
    });
    if (receipt.mode === "replay") {
      return NextResponse.json(receipt.response, { status: receipt.response.ok ? 200 : 409 });
    }
    receiptId = receipt.receiptId;
    const result = await runGithubExport(params.id, body);
    await completeCommandReceipt(receiptId, result);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown GitHub export error.";
    await failCommandReceipt(receiptId, error);
    const status = message.includes("not found") ? 404 : message.includes("running agent") ? 409 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
