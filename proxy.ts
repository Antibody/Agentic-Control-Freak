import { NextRequest, NextResponse } from "next/server";
import { evaluateLocalApiGuard } from "@/lib/shared/local-api-guard";


function deny(reason: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: `Request rejected by local-only guard: ${reason}` },
    { status: 403 },
  );
}

export function proxy(request: NextRequest): NextResponse {
  const decision = evaluateLocalApiGuard({
    hostHeader: request.headers.get("host"),
    originHeader: request.headers.get("origin"),
    protocol: request.nextUrl.protocol,
  });
  if (!decision.allowed) {
    return deny(decision.reason ?? "request denied.");
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/((?!work-sessions/[^/]+/data/upload).*)"],
};
