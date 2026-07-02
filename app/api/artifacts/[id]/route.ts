import { NextRequest, NextResponse } from "next/server";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { readArtifactBytes, readArtifactFile } from "@/lib/server/artifacts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const SAFE_INLINE_BINARY_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
]);

function baseContentType(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

function isSafeInlineText(contentType: string | null): boolean {
  if (contentType === null) {
    return true;
  }
  const base = baseContentType(contentType);
  return base === "text/plain" || base === "text/markdown" || base === "application/json";
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const db = await getDatabaseSnapshot();
    const artifact = db.artifacts.find((candidate) => candidate.id === params.id);
    if (artifact === undefined) {
      return new NextResponse("Artifact not found.", { status: 404 });
    }
    const contentType = typeof artifact.metadata.contentType === "string" ? artifact.metadata.contentType : null;

    if (contentType !== null && SAFE_INLINE_BINARY_TYPES.has(baseContentType(contentType))) {
      const bytes = await readArtifactBytes(artifact);
      const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return new NextResponse(body, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (isSafeInlineText(contentType)) {
      const content = await readArtifactFile(artifact);
      return new NextResponse(content, {
        headers: {
          "Content-Type": contentType ?? "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const bytes = await readArtifactBytes(artifact);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new NextResponse(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="artifact-${artifact.id}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown artifact API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
