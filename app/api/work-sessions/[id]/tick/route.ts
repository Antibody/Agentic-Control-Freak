import { NextRequest, NextResponse } from "next/server";
import { completeCommandReceipt, failCommandReceipt, idempotencyKeyFromRequest, startCommandReceipt } from "@/lib/server/command-receipts";
import { advanceController } from "@/lib/server/workflow-controller";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  let receiptId = "";
  try {
    const params = await context.params;
    const body = (await request.json().catch(() => ({}))) as unknown;
    const receipt = await startCommandReceipt({
      workSessionId: params.id,
      commandType: "tick",
      idempotencyKey: idempotencyKeyFromRequest(request.headers, body),
      requestBody: body,
    });
    if (receipt.mode === "replay") {
      return NextResponse.json(receipt.response, { status: receipt.response.ok ? 200 : 409 });
    }
    receiptId = receipt.receiptId;
    const result = await advanceController(params.id);
    await completeCommandReceipt(receiptId, result);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown tick error.";
    await failCommandReceipt(receiptId, error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
