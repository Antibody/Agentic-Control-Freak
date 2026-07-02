import { NextRequest, NextResponse } from "next/server";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { getConfig } from "@/lib/server/config";
import { getRuntimeStatus } from "@/lib/server/runtime/runtime-status";
import { runtimeProviderIds } from "@/lib/server/runtime-providers/registry";
import { emptyRuntimeOverrides } from "@/lib/shared/runtime-overrides";
import type { AgentProvider, ReasoningEffort, WorkSessionRecord } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const selectableProviders: AgentProvider[] = runtimeProviderIds();

function parseProvider(value: string | null): AgentProvider | null {
  return value !== null && selectableProviders.includes(value as AgentProvider) ? (value as AgentProvider) : null;
}

function parseRuntimeString(value: string | null, maxLength: number): string | null {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, maxLength);
}

function statusWorkSession(input: {
  workSession: WorkSessionRecord | null;
  provider: AgentProvider;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}): WorkSessionRecord | null {
  const workSession = input.workSession;
  if (workSession === null) {
    return null;
  }
  const savedProvider = workSession.agentProvider ?? getConfig().agentProvider;
  const providerChangedInDrawer = savedProvider !== input.provider;
  if (!providerChangedInDrawer && input.model === null && input.reasoningEffort === null) {
    return workSession;
  }
  const overrides = {
    ...emptyRuntimeOverrides(),
    ...(providerChangedInDrawer ? {} : workSession.runtimeOverrides ?? {}),
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  };
  return {
    ...workSession,
    runtimeOverrides: overrides,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const workSessionId = request.nextUrl.searchParams.get("workSessionId");
    const snapshot = await getDatabaseSnapshot();
    const workSession = workSessionId === null
      ? null
      : snapshot.workSessions.find((session) => session.id === workSessionId) ?? null;
    const provider = parseProvider(request.nextUrl.searchParams.get("provider"))
      ?? workSession?.agentProvider
      ?? getConfig().agentProvider;
    const modelOverride = parseRuntimeString(request.nextUrl.searchParams.get("model"), 120);
    const reasoningEffortOverride = parseRuntimeString(request.nextUrl.searchParams.get("reasoningEffort"), 40);
    const transientWorkSession = statusWorkSession({
      workSession,
      provider,
      model: modelOverride,
      reasoningEffort: reasoningEffortOverride,
    });
    const status = await getRuntimeStatus({
      provider,
      workSession: transientWorkSession,
      modelOverride,
      reasoningEffortOverride,
    });
    return NextResponse.json({ ok: true, data: status });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown runtime status error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
