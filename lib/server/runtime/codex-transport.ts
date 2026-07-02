import { getConfig, type CodexThreadPersistence } from "@/lib/server/config";
import type { CodexTransportMode, TaskRecord, WorkSessionRecord } from "@/lib/shared/types";

export type CodexTransportIntent = "execute" | "plan" | "research" | "review" | "thread-control" | "catalog";
export type CodexTransportKind = "app-server" | "exec";

export interface CodexTransportDecision {
  mode: CodexTransportMode;
  primary: CodexTransportKind;
  fallback: "exec" | null;
  nativeRequired: boolean;
  reason: string;
  persistentThread: boolean;
}

export interface CodexTransportInput {
  intent: CodexTransportIntent;
  workSession?: WorkSessionRecord | null;
  task?: TaskRecord | null;
  explicitNativeFeatureRequested?: boolean;
}

function persistenceForIntent(
  persistence: CodexThreadPersistence,
  intent: CodexTransportIntent,
): boolean {
  if (intent === "plan" || intent === "research" || intent === "catalog") {
    return false;
  }
  if (persistence === "per-task") {
    return false;
  }
  if (persistence === "per-session") {
    return true;
  }
  return intent === "execute" || intent === "review" || intent === "thread-control";
}

function nativeRequiredFor(input: CodexTransportInput): boolean {
  return (
    input.intent === "review" ||
    input.intent === "thread-control" ||
    input.explicitNativeFeatureRequested === true
  );
}

function inheritedMode(workSession: WorkSessionRecord | null | undefined): CodexTransportMode {
  return workSession?.runtimeOverrides?.codexTransportMode ?? getConfig().codexTransportMode;
}

export function resolveCodexTransport(input: CodexTransportInput): CodexTransportDecision {
  const config = getConfig();
  const mode = inheritedMode(input.workSession);
  const nativeRequired = nativeRequiredFor(input);
  const persistentThread = persistenceForIntent(config.codexNativeThreadPersistence, input.intent);

  if (mode === "exec-only") {
    return {
      mode,
      primary: "exec",
      fallback: null,
      nativeRequired: false,
      persistentThread: false,
      reason: nativeRequired
        ? "Codex exec-only transport was explicitly selected; native thread/subagent features will not be available."
        : "Codex exec-only transport was selected.",
    };
  }

  if (input.intent === "plan" || input.intent === "research") {
    return {
      mode,
      primary: "exec",
      fallback: null,
      nativeRequired: false,
      persistentThread: false,
      reason: "Codex planner and research jobs stay on the guarded read-only exec path.",
    };
  }

  if (input.intent === "catalog") {
    return {
      mode,
      primary: "app-server",
      fallback: null,
      nativeRequired: false,
      persistentThread,
      reason: "Codex catalog/status probes use the read-only app-server control surface.",
    };
  }

  const fallback = mode === "auto" && config.codexAppServerFallback && !nativeRequired ? "exec" : null;
  return {
    mode,
    primary: "app-server",
    fallback,
    nativeRequired,
    persistentThread,
    reason: nativeRequired
      ? "Native Codex app-server is required for this operation."
      : fallback === "exec"
        ? "Native Codex app-server is primary; codex exec is allowed only before a turn starts."
        : "Native Codex app-server is required by transport mode.",
  };
}
