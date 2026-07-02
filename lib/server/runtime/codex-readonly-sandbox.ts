import type { CodeChangeRecord, ExecutorSandboxMode } from "@/lib/shared/types";

export type CodexReadOnlySandboxMode = "read-only" | ExecutorSandboxMode;

export interface CodexReadOnlySandboxResolution {
  sandboxMode: CodexReadOnlySandboxMode;
  enforceNoChanges: boolean;
  reason: string | null;
}

function normalizeExecutorSandboxMode(value: string | null | undefined): ExecutorSandboxMode | null {
  if (value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return null;
}

export function resolveCodexReadOnlySandbox(): CodexReadOnlySandboxResolution {
  if (process.platform !== "win32") {
    return {
      sandboxMode: "read-only",
      enforceNoChanges: false,
      reason: null,
    };
  }

  const override = normalizeExecutorSandboxMode(process.env.CODEX_READONLY_WINDOWS_FALLBACK_SANDBOX);
  const sandboxMode = override ?? "danger-full-access";
  return {
    sandboxMode,
    enforceNoChanges: true,
    reason: `Windows Codex read-only sandbox setup can fail before file tools run, so the app launches Codex read-only work with ${sandboxMode} and enforces no workspace changes by before/after diff.`,
  };
}

export function codexReadOnlySandboxArgs(resolution: CodexReadOnlySandboxResolution): string[] {
  return ["--sandbox", resolution.sandboxMode];
}

export function codexReadOnlySandboxEnv(resolution: CodexReadOnlySandboxResolution): { CODEX_SANDBOX_MODE: CodexReadOnlySandboxMode } {
  return { CODEX_SANDBOX_MODE: resolution.sandboxMode };
}

export function summarizeReadOnlyWorkspaceChanges(
  changes: Omit<CodeChangeRecord, "id" | "agentRunId" | "createdAt">[],
): string {
  const listed = changes
    .slice(0, 12)
    .map((change) => `- ${change.changeKind}: ${change.filePath}`)
    .join("\n");
  const suffix = changes.length > 12 ? `\n- ...and ${changes.length - 12} more` : "";
  return `Codex read-only work modified the workspace while running under the Windows sandbox fallback. The app stopped instead of accepting the result.\n${listed}${suffix}`;
}
