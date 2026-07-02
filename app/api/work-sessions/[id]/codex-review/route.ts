import { NextRequest, NextResponse } from "next/server";
import { saveArtifact } from "@/lib/server/artifacts";
import { getDatabaseSnapshot, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { getConfig } from "@/lib/server/config";
import { withCodexAppServerControl } from "@/lib/server/runtime/codex-app-server-control";
import { compareWorkspaceSnapshots, snapshotWorkspace } from "@/lib/server/runtime/workspace-diff";
import { codexReadOnlySandboxEnv, resolveCodexReadOnlySandbox, summarizeReadOnlyWorkspaceChanges } from "@/lib/server/runtime/codex-readonly-sandbox";
import { codexSandboxPolicyForMode, ensureLiveCodexThread, updateCodexThreadSettings, waitForCodexTurnCompletion } from "@/lib/server/runtime/codex-native-thread";
import { resolveCodexTransport } from "@/lib/server/runtime/codex-transport";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import type { JsonObject } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function reviewTarget(body: Record<string, unknown>): JsonObject {
  const target = typeof body.target === "string" ? body.target : "uncommittedChanges";
  if (target === "baseBranch") {
    const branch = typeof body.branch === "string" && body.branch.trim().length > 0 ? body.branch.trim() : "main";
    return { type: "baseBranch", branch };
  }
  if (target === "commit") {
    const sha = typeof body.sha === "string" ? body.sha.trim() : "";
    if (sha.length === 0) {
      throw new Error("sha is required for commit review.");
    }
    return { type: "commit", sha, title: typeof body.title === "string" ? body.title : null };
  }
  if (target === "custom") {
    const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
    if (instructions.length === 0) {
      throw new Error("instructions are required for custom review.");
    }
    return { type: "custom", instructions };
  }
  return { type: "uncommittedChanges" };
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => {
    const record = asObject(entry);
    return typeof record.text === "string" ? record.text : "";
  }).filter((entry) => entry.trim().length > 0).join("\n");
}

function turnReviewText(turn: Record<string, unknown> | null): string[] {
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const texts: string[] = [];
  for (const rawItem of items) {
    const item = asObject(rawItem);
    const type = typeof item.type === "string" ? item.type : "";
    if (type === "agentMessage" && typeof item.text === "string" && item.text.trim().length > 0) {
      texts.push(item.text.trim());
      continue;
    }
    const content = textFromContent(item.content);
    if ((type === "assistantMessage" || type === "reviewFinding" || type === "agentMessage") && content.trim().length > 0) {
      texts.push(content.trim());
    }
  }
  return texts;
}

function extractReviewText(reviewThread: Record<string, unknown> | null, completionTurn: Record<string, unknown> | null, turnId: string | null): string {
  const completionTexts = turnReviewText(completionTurn);
  if (completionTexts.length > 0) {
    return [...new Set(completionTexts)].join("\n\n").trim();
  }
  const turns = Array.isArray(reviewThread?.turns) ? reviewThread.turns : [];
  const matchingTurn = turnId !== null
    ? turns.map((rawTurn) => asObject(rawTurn)).find((candidate) => candidate.id === turnId) ?? null
    : null;
  const fallbackTurn = matchingTurn ?? asObject(turns[turns.length - 1]);
  const texts = turnReviewText(fallbackTurn);
  return [...new Set(texts)].join("\n\n").trim();
}

function reviewArtifactContent(input: {
  threadId: string;
  reviewThreadId: string;
  turnId: string | null;
  delivery: string;
  target: JsonObject;
  completionStatus: string | null;
  reviewSandboxMode: string;
  reviewSandboxFallbackReason: string | null;
  reviewText: string;
}): string {
  return [
    "# Native Codex Review",
    "",
    `Root thread: ${input.threadId}`,
    `Review thread: ${input.reviewThreadId}`,
    `Turn: ${input.turnId ?? "unknown"}`,
    `Delivery: ${input.delivery}`,
    `Status: ${input.completionStatus ?? "unknown"}`,
    `Sandbox: ${input.reviewSandboxMode}`,
    `Sandbox fallback: ${input.reviewSandboxFallbackReason ?? "none"}`,
    "",
    "## Target",
    "",
    "```json",
    JSON.stringify(input.target, null, 2),
    "```",
    "",
    "## Findings",
    "",
    input.reviewText.length > 0 ? input.reviewText : "Native Codex review completed, but no review text was captured from the app-server thread.",
    "",
  ].join("\n");
}

function reviewPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "No review text was captured.";
  return normalized.slice(0, 400);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = asObject(await request.json().catch(() => ({})));
    const target = reviewTarget(body);
    const delivery = body.delivery === "inline" ? "inline" : "detached";
    const snapshot = await getDatabaseSnapshot();
    const workSession = snapshot.workSessions.find((candidate) => candidate.id === params.id);
    if (workSession === undefined) {
      return NextResponse.json({ ok: false, error: "Work session was not found." }, { status: 404 });
    }
    const decision = resolveCodexTransport({ intent: "review", workSession });
    if (decision.primary === "exec") {
      return NextResponse.json({ ok: false, error: decision.reason }, { status: 409 });
    }
    const config = getConfig();
    const timeoutMs = workSession.runtimeOverrides?.timeoutMs ?? config.codexTimeoutMs;
    await assertSafeWorkspace(workSession.activeWorktreePath, { operation: "Native Codex review" });
    const reviewSandbox = resolveCodexReadOnlySandbox();
    const beforeSnapshot = reviewSandbox.enforceNoChanges ? await snapshotWorkspace(workSession.activeWorktreePath) : null;

    const result = await withCodexAppServerControl(workSession.activeWorktreePath, async (client) => {
      const liveThread = await ensureLiveCodexThread(client, workSession, {
        startIfMissing: true,
        operation: "Native Codex review",
        config,
      });
      const reviewSandboxPolicy = codexSandboxPolicyForMode(reviewSandbox.sandboxMode, liveThread.runtime.networkAccess);
      const restoreSandboxPolicy = codexSandboxPolicyForMode(liveThread.runtime.sandboxMode, liveThread.runtime.networkAccess);
      const shouldOverrideSandbox = JSON.stringify(reviewSandboxPolicy) !== JSON.stringify(restoreSandboxPolicy);
      let reviewSandboxApplied = false;
      try {
        if (shouldOverrideSandbox) {
          await updateCodexThreadSettings(client, liveThread.threadId, {
            sandboxPolicy: reviewSandboxPolicy,
          }, { description: "Native Codex review sandbox update" });
          reviewSandboxApplied = true;
        }
        const review = await client.request("review/start", { threadId: liveThread.threadId, target, delivery });
        const turn = asObject(review.turn);
        const reviewThreadId = typeof review.reviewThreadId === "string" ? review.reviewThreadId : liveThread.threadId;
        const turnId = typeof turn.id === "string" ? turn.id : null;
        const completion = turnId === null
          ? null
          : await waitForCodexTurnCompletion(client, {
            threadId: reviewThreadId,
            turnId,
            timeoutMs,
            description: "Native Codex review completion",
          });
        if (completion !== null && completion.status !== null && completion.status !== "completed") {
          throw new Error(`Native Codex review ${completion.status}.${completion.errorMessage !== null ? ` ${completion.errorMessage}` : ""}`);
        }
        const reviewRead = await client.request("thread/read", { threadId: reviewThreadId, includeTurns: true }).catch(() => null);
        const reviewThread = reviewRead !== null ? asObject(reviewRead.thread) : null;
        const reviewText = extractReviewText(reviewThread, completion?.turn ?? null, turnId);
        return {
          threadId: liveThread.threadId,
          reviewThreadId,
          turnId,
          completionStatus: completion?.status ?? null,
          staleThreadId: liveThread.staleThreadId,
          startedFreshThread: liveThread.startedFresh,
          resumedThread: liveThread.resumed,
          timeoutMs,
          reviewText,
          target,
          delivery,
          reviewSandboxMode: reviewSandbox.sandboxMode,
          reviewSandboxFallbackReason: reviewSandbox.reason,
          reviewSandboxApplied,
          raw: jsonObject(review),
        };
      } finally {
        if (reviewSandboxApplied) {
          await updateCodexThreadSettings(client, liveThread.threadId, {
            sandboxPolicy: restoreSandboxPolicy,
          }, { description: "Native Codex review sandbox restore" }).catch(() => undefined);
        }
      }
    }, {
      env: {
        ...codexReadOnlySandboxEnv(reviewSandbox),
        CODEX_APPROVAL_POLICY: "never",
      },
      configOverrides: [
        `sandbox_mode="${reviewSandbox.sandboxMode}"`,
        'approval_policy="never"',
      ],
    });

    if (beforeSnapshot !== null) {
      const afterSnapshot = await snapshotWorkspace(workSession.activeWorktreePath);
      const changes = await compareWorkspaceSnapshots({
        workspacePath: workSession.activeWorktreePath,
        before: beforeSnapshot,
        after: afterSnapshot,
      });
      if (changes.length > 0) {
        throw new Error(summarizeReadOnlyWorkspaceChanges(changes));
      }
    }

    const reviewArtifact = await saveArtifact({
      workSessionId: params.id,
      kind: "report",
      fileName: `native-codex-review-${result.reviewThreadId}.md`,
      content: reviewArtifactContent({
        threadId: result.threadId,
        reviewThreadId: result.reviewThreadId,
        turnId: result.turnId,
        delivery: result.delivery,
        target,
        completionStatus: result.completionStatus,
        reviewSandboxMode: result.reviewSandboxMode,
        reviewSandboxFallbackReason: result.reviewSandboxFallbackReason,
        reviewText: result.reviewText,
      }),
      metadata: {
        artifactRole: "native_codex_review",
        threadId: result.threadId,
        reviewThreadId: result.reviewThreadId,
        turnId: result.turnId ?? "",
        delivery: result.delivery,
        completionStatus: result.completionStatus ?? "",
        reviewSandboxMode: result.reviewSandboxMode,
        reviewSandboxFallbackReason: result.reviewSandboxFallbackReason ?? "",
        reviewSandboxApplied: result.reviewSandboxApplied,
        target,
      },
    });

    await mutateDatabase((db) => {
      const session = db.workSessions.find((candidate) => candidate.id === params.id);
      if (session !== undefined) {
        if (result.staleThreadId !== null && session.codexThreadId === result.staleThreadId) {
          session.codexSubagents = [];
          session.codexCollabCalls = [];
        }
        session.codexThreadId = result.threadId;
        session.codexLastTurnId = result.turnId;
        updateWorkSessionTimestamp(session);
      }
    });
    await emitEvent({
      workSessionId: params.id,
      eventName: "task.progress",
      aggregateType: "work_session",
      aggregateId: params.id,
      priority: "high",
      payload: {
        message: `Completed native Codex review (${delivery}). ${reviewPreview(result.reviewText)}`,
        threadId: result.threadId,
        reviewThreadId: result.reviewThreadId,
        turnId: result.turnId ?? "",
        completionStatus: result.completionStatus ?? "",
        reviewArtifactId: reviewArtifact.id,
        reviewArtifactUrl: `/api/artifacts/${reviewArtifact.id}`,
        reviewPreview: reviewPreview(result.reviewText),
        reviewSandboxMode: result.reviewSandboxMode,
        reviewSandboxFallbackReason: result.reviewSandboxFallbackReason ?? "",
        reviewSandboxApplied: String(result.reviewSandboxApplied),
        staleThreadReplaced: String(result.staleThreadId !== null),
        startedFreshThread: String(result.startedFreshThread),
        resumedThread: String(result.resumedThread),
        timeoutMs: String(result.timeoutMs),
        target: JSON.stringify(target),
      },
    });
    return NextResponse.json({ ok: true, data: { ...result, reviewArtifactId: reviewArtifact.id } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Codex review error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
