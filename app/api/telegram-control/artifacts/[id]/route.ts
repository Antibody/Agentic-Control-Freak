import { stat } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { readArtifactBytes } from "@/lib/server/artifacts";
import { getConfig } from "@/lib/server/config";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { findAuthorizedPrincipal, isWorkerAuthorized } from "@/lib/server/telegram-control/security";
import { readTelegramControlState } from "@/lib/server/telegram-control/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function safeFileName(value: string): string {
  const sanitized = value.replace(/[^a-z0-9._-]/gi, "_").replace(/\.{2,}/g, "_").slice(0, 120);
  return sanitized.length > 0 ? sanitized : "preview-screenshot.png";
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (!isWorkerAuthorized(request.headers.get("authorization"))) {
    return NextResponse.json({ ok: false, error: "Unauthorized Telegram control worker." }, { status: 401 });
  }

  try {
    const params = await context.params;
    const chatId = request.nextUrl.searchParams.get("chatId") ?? "";
    if (chatId.trim().length === 0) {
      return NextResponse.json({ ok: false, error: "chatId is required." }, { status: 400 });
    }

    const [db, telegramState] = await Promise.all([getDatabaseSnapshot(), readTelegramControlState()]);
    const artifact = db.artifacts.find((candidate) => candidate.id === params.id);
    if (artifact === undefined) {
      return NextResponse.json({ ok: false, error: "Artifact not found." }, { status: 404 });
    }
    if (artifact.artifactKind !== "screenshot") {
      return NextResponse.json({ ok: false, error: "Only screenshot artifacts can be sent to Telegram." }, { status: 403 });
    }
    const contentType = typeof artifact.metadata.contentType === "string" ? artifact.metadata.contentType : "";
    if (contentType !== "image/png") {
      return NextResponse.json({ ok: false, error: "Only PNG screenshot artifacts can be sent to Telegram." }, { status: 403 });
    }

    const hasAuthorizedBinding = telegramState.chatBindings.some((binding) =>
      binding.telegramChatId === chatId &&
      binding.workSessionId === artifact.workSessionId &&
      findAuthorizedPrincipal(telegramState, binding.telegramUserId) !== null
    );
    if (!hasAuthorizedBinding) {
      return NextResponse.json({ ok: false, error: "Telegram chat is not bound to this artifact's work session." }, { status: 403 });
    }

    const maxBytes = getConfig().telegramControlMaxScreenshotBytes;
    const size = (await stat(artifact.storageUri)).size;
    if (size > maxBytes) {
      return NextResponse.json({ ok: false, error: `Screenshot is too large for Telegram delivery (${size} bytes).` }, { status: 413 });
    }

    const bytes = await readArtifactBytes(artifact);
    if (bytes.byteLength > maxBytes) {
      return NextResponse.json({ ok: false, error: `Screenshot is too large for Telegram delivery (${bytes.byteLength} bytes).` }, { status: 413 });
    }
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new NextResponse(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${safeFileName(`preview-${artifact.id.slice(0, 8)}.png`)}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Telegram artifact error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
