"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentRunRecord,
  ApprovalRecord,
  HandoffRecord,
  PlanRecord,
  PreviewServerRecord,
  StackDecision,
  TaskRecord,
  TranscriptTurnRecord,
  VerificationRunRecord,
} from "@/lib/shared/types";
import { stackCatalog } from "@/lib/shared/stack-catalog";
import type {
  TimelineAgentReplyItem,
  TimelineActivityItem,
  TimelineApprovalItem,
  TimelineHandoffItem,
  TimelineItem,
  TimelineMessageItem,
  TimelineMilestoneItem,
  TimelinePlanItem,
  TimelinePreviewItem,
  TimelineRestoreItem,
  TimelineVerificationItem,
} from "@/lib/shared/timeline";

function className(...entries: Array<string | false | null | undefined>): string {
  return entries.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).join(" ");
}

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

interface RunTranscriptPayload {
  agentRun: AgentRunRecord;
  turns: TranscriptTurnRecord[];
  progress: RunProgressEntry[];
}

interface RunTranscriptResponse {
  ok: boolean;
  data?: RunTranscriptPayload;
  error?: string;
}

interface RunProgressEntry {
  id: string;
  ts: string;
  text: string;
  kind: "message" | "command" | "file_change" | "output";
}

function providerLabel(run: AgentRunRecord): string {
  switch (run.runtimeKind) {
    case "claude":
      return "Claude Code";
    case "antigravity":
      return "AGY CLI";
    case "ollama":
      return "Ollama";
    case "codex":
      return "Codex CLI";
    default:
      return run.runtimeKind;
  }
}

function attachmentKindLabel(kind: TimelineMessageItem["attachments"][number]["kind"]): string {
  switch (kind) {
    case "pdf":
      return "PDF";
    case "document":
      return "DOC";
    case "spreadsheet":
      return "SHEET";
    case "presentation":
      return "SLIDES";
    case "image":
      return "IMAGE";
  }
}

function metadataList(task: TaskRecord, key: string): string[] {
  const value = task.metadata[key];
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        )
      )
    : [];
}

function metadataText(task: TaskRecord, key: string): string | null {
  const value = task.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pendingTimeoutTasks(items: TimelineItem[]): TaskRecord[] {
  const tasks: TaskRecord[] = [];
  for (const item of items) {
    if (item.kind !== "plan") continue;
    for (const task of item.tasks) {
      if (metadataText(task, "timeoutContinuationStatus") === "pending") {
        tasks.push(task);
      }
    }
  }
  return tasks;
}

type TaskGlyphKind = "done" | "in_progress" | "blocked" | "skipped" | "pending";

function taskGlyphKind(status: TaskRecord["status"]): { kind: TaskGlyphKind; tone: string; aria: string } {
  switch (status) {
    case "done":
      return { kind: "done", tone: "success", aria: "Done" };
    case "in_progress":
      return { kind: "in_progress", tone: "warning", aria: "In progress" };
    case "blocked":
      return { kind: "blocked", tone: "danger", aria: "Blocked" };
    case "skipped":
      return { kind: "skipped", tone: "muted", aria: "Skipped" };
    default:
      return { kind: "pending", tone: "muted", aria: "Pending" };
  }
}

function TaskGlyph({ kind }: { kind: TaskGlyphKind }): React.ReactElement | null {
  switch (kind) {
    case "done":
      return (
        <svg viewBox="0 0 14 14" className="marker-icon" aria-hidden>
          <path
            d="M2.5 7.4 L6 10.5 L11.5 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "blocked":
      return (
        <svg viewBox="0 0 14 14" className="marker-icon" aria-hidden>
          <path d="M7 3 L7 8.2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <circle cx="7" cy="10.6" r="1.05" fill="currentColor" />
        </svg>
      );
    case "in_progress":
      return <span className="marker-dot" aria-hidden />;
    case "skipped":
      return (
        <svg viewBox="0 0 14 14" className="marker-icon" aria-hidden>
          <path d="M3.5 7 L10.5 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return null;
  }
}

function languageLabel(language: string): string {
  const normalized = language.trim().toLowerCase();
  if (normalized.length === 0) return "text";
  return normalized.replace(/[^a-z0-9+#.-]/g, "").slice(0, 24) || "text";
}

function inlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) {
      nodes.push(text.slice(last, start));
    }
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = link?.[2] ?? "";
      const safeHref = /^(https?:\/\/|\/api\/artifacts\/|#)/.test(href) ? href : "#";
      nodes.push(
        <a key={key} href={safeHref} target={safeHref.startsWith("http") || safeHref.startsWith("/api/") ? "_blank" : undefined} rel="noreferrer">
          {link?.[1] ?? token}
        </a>
      );
    }
    last = start + token.length;
    index += 1;
  }
  if (last < text.length) {
    nodes.push(text.slice(last));
  }
  return nodes;
}

function renderMarkdownList(lines: string[], ordered: boolean, key: string): React.ReactElement {
  const items = lines.map((line, index) => {
    const text = ordered ? line.replace(/^\s*\d+\.\s+/, "") : line.replace(/^\s*[-*]\s+/, "");
    return <li key={`${key}-${index}`}>{inlineMarkdown(text, `${key}-${index}`)}</li>;
  });
  return ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
}

function renderMarkdown(content: string): React.ReactNode[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const blocks: React.ReactNode[] = [];
  const lines = normalized.split("\n");
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\S*)\s*$/);
    if (fence !== null) {
      const language = languageLabel(fence[1] ?? "");
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <figure key={`code-${key}`} className="markdown-code">
          <figcaption>{language}</figcaption>
          <pre><code>{codeLines.join("\n")}</code></pre>
        </figure>
      );
      key += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading !== null) {
      const level = heading[1].length;
      const children = inlineMarkdown(heading[2], `h-${key}`);
      if (level === 1) blocks.push(<h2 key={`h-${key}`}>{children}</h2>);
      else if (level === 2) blocks.push(<h3 key={`h-${key}`}>{children}</h3>);
      else blocks.push(<h4 key={`h-${key}`}>{children}</h4>);
      key += 1;
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const listLines: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? "")) {
        listLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push(renderMarkdownList(listLines, false, `ul-${key}`));
      key += 1;
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const listLines: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? "")) {
        listLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push(renderMarkdownList(listLines, true, `ol-${key}`));
      key += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      !/^```/.test(lines[index] ?? "") &&
      !/^(#{1,3})\s+/.test(lines[index] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[index] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[index] ?? "")
    ) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(<p key={`p-${key}`}>{inlineMarkdown(paragraph.join(" "), `p-${key}`)}</p>);
    key += 1;
  }

  return blocks;
}

interface TimelineCallbacks {
  workspacePath: string | null;
  busy: boolean;
  forkingHandoffId: string | null;
  forkingPlanId: string | null;
  pendingPlanApproval: ApprovalRecord | null;
  canUndoLast: boolean;
  canOpenCheckpointHistory: boolean;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onForkCurrent: () => Promise<void>;
  onForkHandoff: (handoffId: string) => Promise<void>;
  onForkPlan: (planId: string) => Promise<void>;
  onUndoLast: () => Promise<void>;
  onOpenCheckpointHistory: () => void;
  stackDecision: StackDecision | null;
  onSetPlanStack: (planId: string, stack: string) => Promise<void>;
  onOpenPlanDetail: (plan: PlanRecord) => void;
  onEditPlan: (plan: PlanRecord) => void;
  onRerunTask: (taskId: string, note: string | null) => Promise<void>;
  onContinueTask: (taskId: string) => Promise<void>;
  onSkipTask: (taskId: string) => Promise<void>;
  onOpenVerificationDetail: (run: VerificationRunRecord) => void;
  onOpenHandoffDetail: (handoff: HandoffRecord) => void;
  onOpenHandoffChanges: (handoff: HandoffRecord) => void;
  onOpenRunLogs: () => void;
  onStartPreview: () => Promise<void>;
  onHardRestartPreview: () => Promise<void>;
  onRepairPreview: () => Promise<void>;
  onStopPreview: () => Promise<void>;
  onOpenPreview: () => Promise<void>;
}

interface TimelineStreamProps extends TimelineCallbacks {
  items: TimelineItem[];
  activity: TimelineActivityItem | null;
  emptyHint: string;
}

export function TimelineStream({
  items,
  activity,
  emptyHint,
  workspacePath,
  busy,
  forkingHandoffId,
  forkingPlanId,
  pendingPlanApproval,
  canUndoLast,
  canOpenCheckpointHistory,
  stackDecision,
  onSetPlanStack,
  onResolveApproval,
  onForkCurrent,
  onForkHandoff,
  onForkPlan,
  onUndoLast,
  onOpenCheckpointHistory,
  onOpenPlanDetail,
  onEditPlan,
  onRerunTask,
  onContinueTask,
  onSkipTask,
  onOpenVerificationDetail,
  onOpenHandoffDetail,
  onOpenHandoffChanges,
  onOpenRunLogs,
  onStartPreview,
  onHardRestartPreview,
  onRepairPreview,
  onStopPreview,
  onOpenPreview,
}: TimelineStreamProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const previousItemCountRef = useRef(items.length);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return undefined;
    const handler = (): void => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const isAtBottom = distanceFromBottom < 80;
      setAtBottom(isAtBottom);
      if (isAtBottom) {
        setNewCount(0);
      }
    };
    container.addEventListener("scroll", handler, { passive: true });
    handler();
    return () => container.removeEventListener("scroll", handler);
  }, []);

  useEffect(() => {
    const delta = items.length - previousItemCountRef.current;
    previousItemCountRef.current = items.length;
    if (delta <= 0) return;
    if (atBottom) {
      sentinelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    } else {
      setNewCount((current) => current + delta);
    }
  }, [items.length, atBottom]);

  const scrollToBottom = (): void => {
    sentinelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    setNewCount(0);
  };

  const isEmpty = items.length === 0 && activity === null;
  const timeoutTasks = useMemo(() => pendingTimeoutTasks(items), [items]);
  const latestTimeoutTask = timeoutTasks[timeoutTasks.length - 1] ?? null;

  const rendered = useMemo(() => items.map((item) => renderItem(item, {
    workspacePath,
    busy,
    forkingHandoffId,
    forkingPlanId,
    pendingPlanApproval,
    canUndoLast,
    canOpenCheckpointHistory,
    stackDecision,
    onSetPlanStack,
    onResolveApproval,
    onForkCurrent,
    onForkHandoff,
    onForkPlan,
    onUndoLast,
    onOpenCheckpointHistory,
    onOpenPlanDetail,
    onEditPlan,
    onRerunTask,
    onContinueTask,
    onSkipTask,
    onOpenVerificationDetail,
    onOpenHandoffDetail,
    onOpenHandoffChanges,
    onOpenRunLogs,
    onStartPreview,
    onHardRestartPreview,
    onRepairPreview,
    onStopPreview,
    onOpenPreview,
  })), [
    items,
    workspacePath,
    busy,
    forkingHandoffId,
    forkingPlanId,
    pendingPlanApproval,
    canUndoLast,
    canOpenCheckpointHistory,
    stackDecision,
    onSetPlanStack,
    onResolveApproval,
    onForkCurrent,
    onForkHandoff,
    onForkPlan,
    onUndoLast,
    onOpenCheckpointHistory,
    onOpenPlanDetail,
    onEditPlan,
    onRerunTask,
    onContinueTask,
    onSkipTask,
    onOpenVerificationDetail,
    onOpenHandoffDetail,
    onOpenHandoffChanges,
    onOpenRunLogs,
    onStartPreview,
    onHardRestartPreview,
    onRepairPreview,
    onStopPreview,
    onOpenPreview,
  ]);

  return (
    <div className="stream-shell">
      <div ref={containerRef} className="stream">
        {isEmpty ? (
          <div className="stream-empty">
            <h3>Tell the loop what to build.</h3>
            <p>{emptyHint}</p>
          </div>
        ) : null}
        {rendered}
        {activity !== null ? <ActivityIndicator item={activity} /> : null}
        {latestTimeoutTask !== null ? (
          <TimeoutContinuePrompt
            task={latestTimeoutTask}
            busy={busy}
            onContinueTask={onContinueTask}
          />
        ) : null}
        <div ref={sentinelRef} className="stream-sentinel" aria-hidden />
      </div>
      {newCount > 0 ? (
        <button type="button" className="stream-jump" onClick={scrollToBottom}>
          ↓ {newCount} new {newCount === 1 ? "update" : "updates"}
        </button>
      ) : null}
    </div>
  );
}

function renderItem(item: TimelineItem, callbacks: TimelineCallbacks): React.ReactNode {
  switch (item.kind) {
    case "message":
      return <MessageBubble key={item.id} item={item} />;
    case "agent_reply":
      return <AgentReplyCard key={item.id} item={item} />;
    case "milestone":
      return <MilestoneDivider key={item.id} item={item} />;
    case "restore":
      return <RestoreDivider key={item.id} item={item} callbacks={callbacks} />;
    case "plan":
      return (
        <PlanCard
          key={item.id}
          item={item}
          busy={callbacks.busy}
          pendingPlanApproval={callbacks.pendingPlanApproval}
          forkingPlanId={callbacks.forkingPlanId}
          stackDecision={callbacks.stackDecision}
          onSetPlanStack={callbacks.onSetPlanStack}
          onResolveApproval={callbacks.onResolveApproval}
          onForkPlan={callbacks.onForkPlan}
          onOpenDetail={callbacks.onOpenPlanDetail}
          onEditPlan={callbacks.onEditPlan}
          onRerunTask={callbacks.onRerunTask}
          onContinueTask={callbacks.onContinueTask}
          onSkipTask={callbacks.onSkipTask}
        />
      );
    case "approval":
      return (
        <ApprovalCard
          key={item.id}
          item={item}
          busy={callbacks.busy}
          onResolveApproval={callbacks.onResolveApproval}
        />
      );
    case "verification":
      return (
        <VerificationCard
          key={item.id}
          item={item}
          onOpenDetail={callbacks.onOpenVerificationDetail}
        />
      );
    case "preview":
      return (
        <PreviewCard
          key={item.id}
          item={item}
          busy={callbacks.busy}
          onStartPreview={callbacks.onStartPreview}
          onHardRestartPreview={callbacks.onHardRestartPreview}
          onRepairPreview={callbacks.onRepairPreview}
          onStopPreview={callbacks.onStopPreview}
          onOpenPreview={callbacks.onOpenPreview}
        />
      );
    case "handoff":
      return (
        <HandoffCard
          key={item.id}
          item={item}
          workspacePath={callbacks.workspacePath}
          busy={callbacks.busy}
          forkingHandoffId={callbacks.forkingHandoffId}
          canUndoLast={callbacks.canUndoLast}
          canOpenCheckpointHistory={callbacks.canOpenCheckpointHistory}
          onOpenDetail={callbacks.onOpenHandoffDetail}
          onOpenChanges={callbacks.onOpenHandoffChanges}
          onForkHandoff={callbacks.onForkHandoff}
          onUndoLast={callbacks.onUndoLast}
          onOpenCheckpointHistory={callbacks.onOpenCheckpointHistory}
          onOpenRunLogs={callbacks.onOpenRunLogs}
        />
      );
    case "activity":
      return null;
  }
}

function AgentReplyCard({ item }: { item: TimelineAgentReplyItem }): React.ReactElement {
  const { run } = item;
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<RunTranscriptPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = providerLabel(run);
  const turns = payload?.turns ?? [];
  const progress = payload?.progress ?? [];
  const visibleTurns = turns.slice(-1);
  const hasReasoning = turns.some((turn) => typeof turn.reasoning === "string" && turn.reasoning.trim().length > 0);
  const hasProgress = progress.length > 0;
  const latestFinal = turns[turns.length - 1]?.finalText ?? run.summary;

  const loadTranscript = async (): Promise<void> => {
    if (payload !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/work-sessions/${encodeURIComponent(run.workSessionId)}/runs/${encodeURIComponent(run.id)}/transcript`, { method: "GET" });
      const body = (await response.json()) as RunTranscriptResponse;
      if (!response.ok || !body.ok || body.data === undefined) {
        throw new Error(body.error ?? "Unable to load transcript.");
      }
      setPayload(body.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load transcript.");
    } finally {
      setLoading(false);
    }
  };

  const toggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadTranscript();
  };

  return (
    <article className={className("agent-reply-card", run.status === "failed" && "agent-reply-card-failed")}>
      <div className="agent-reply-note">
        <span>{label} {run.status === "failed" ? "failed" : "replied"}</span>
        <span aria-hidden>-</span>
        <span>{formatTime(run.endedAt ?? run.startedAt)}</span>
        <button type="button" className="ghost small" onClick={toggle}>
          {expanded ? "Hide progress" : "Show progress"}
        </button>
      </div>
      {expanded ? (
        <div className="agent-reply-details">
          {loading ? <p className="muted">Loading transcript...</p> : null}
          {error !== null ? <p className="agent-reply-error">{error}</p> : null}
          {!loading && error === null ? (
            <>
              {hasReasoning ? (
                <section className="agent-reply-section">
                  <h4>Thinking</h4>
                  <div className="agent-reply-thinking">
                    {visibleTurns.map((turn, index) => (
                      <pre key={`${turn.ts}:reasoning:${index}`}>{turn.reasoning?.trim() || "No thinking was captured for this turn."}</pre>
                    ))}
                  </div>
                </section>
              ) : null}
              <section className="agent-reply-section">
                <h4>Progress</h4>
                {hasProgress ? (
                  <div className="agent-reply-progress">
                    {progress.map((entry) => (
                      <div key={entry.id} className={className("agent-reply-progress-row", `agent-reply-progress-${entry.kind}`)}>
                        <span className="agent-reply-progress-time">{formatTime(entry.ts)}</span>
                        <span className="agent-reply-progress-text">{entry.text}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">No progress deltas were captured for this run.</p>
                )}
              </section>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="agent-reply-final-card">
        <div className="agent-reply-final-head">
          <span>Reply</span>
        </div>
        <div className="agent-reply-final">
          {renderMarkdown(latestFinal)}
        </div>
      </div>
    </article>
  );
}

function MessageBubble({ item }: { item: TimelineMessageItem }): React.ReactElement {
  const isUser = item.role === "user";
  const isSteering = item.messageKind === "steering";
  const renderAsMarkdown = item.role === "assistant" || item.messageKind === "research_report";
  return (
    <div className={className("bubble", `bubble-${item.role}`, isSteering && "bubble-steering", renderAsMarkdown && "bubble-markdown")}>
      <div className="bubble-body">{renderAsMarkdown ? renderMarkdown(item.content) : item.content}</div>
      {item.attachments.length > 0 ? (
        <div className="bubble-attachments" aria-label="Attached files">
          {item.attachments.map((attachment) => (
            <a
              key={attachment.id}
              className="bubble-attachment"
              href={`/api/artifacts/${attachment.artifactId}`}
              target="_blank"
              rel="noreferrer"
              title={attachment.absolutePath}
            >
              {attachment.kind === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/artifacts/${attachment.artifactId}`} alt={attachment.originalName} />
              ) : (
                <span className="bubble-file-icon" aria-hidden>{attachmentKindLabel(attachment.kind)}</span>
              )}
              <span>
                <strong>{attachment.originalName}</strong>
                <small>{formatBytes(attachment.byteSize)}</small>
              </span>
            </a>
          ))}
        </div>
      ) : null}
      <div className="bubble-meta">
        <span>{isSteering ? "Steering" : isUser ? "You" : item.role}</span>
        <span>·</span>
        <span>{formatTime(item.createdAt)}</span>
      </div>
    </div>
  );
}

function MilestoneDivider({ item }: { item: TimelineMilestoneItem }): React.ReactElement {
  return (
    <div className={className("milestone", `milestone-${item.tone}`)}>
      <span className="milestone-line" aria-hidden />
      <span className="milestone-label">
        {item.label}
        {item.detail !== undefined ? <span className="milestone-detail"> · {item.detail}</span> : null}
      </span>
      <span className="milestone-line" aria-hidden />
    </div>
  );
}

function RestoreDivider({
  item,
  callbacks,
}: {
  item: TimelineRestoreItem;
  callbacks: TimelineCallbacks;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const undoneCount = item.undoneItems.length;
  const restoredFrom = item.restoredFrom?.summary?.trim();
  return (
    <div className="restore-divider">
      <div className="restore-divider-head">
        <span className="restore-divider-line" aria-hidden />
        <span className="restore-divider-label">
          <span className="restore-divider-icon" aria-hidden>
            ⤺
          </span>
          Restored to here
          {restoredFrom !== undefined && restoredFrom.length > 0 ? (
            <span className="restore-divider-detail"> · {restoredFrom}</span>
          ) : null}
        </span>
        <span className="restore-divider-line" aria-hidden />
      </div>
      {undoneCount > 0 ? (
        <div className="restore-divider-controls">
          <button
            type="button"
            className="restore-divider-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Hide" : "Show"} {undoneCount} undone {undoneCount === 1 ? "step" : "steps"}
          </button>
          <span className="restore-divider-hint">These steps were rolled back and don&apos;t affect the current workspace.</span>
        </div>
      ) : null}
      {expanded && undoneCount > 0 ? (
        <div className="restore-undone-group" aria-label="Undone steps">
          {item.undoneItems.map((child) => renderItem(child, callbacks))}
        </div>
      ) : null}
    </div>
  );
}

function TimeoutContinuePrompt({
  task,
  busy,
  onContinueTask,
}: {
  task: TaskRecord;
  busy: boolean;
  onContinueTask: (taskId: string) => Promise<void>;
}): React.ReactElement {
  const changedFiles = metadataText(task, "timeoutContinuationCodeChangeCount");
  const summary = metadataText(task, "timeoutContinuationSummary");
  const detail = changedFiles !== null
    ? `Partial progress captured from ${changedFiles} changed file(s).`
    : "Partial progress was captured before the timeout.";
  return (
    <div className="timeout-chat-prompt" role="status" aria-live="polite">
      <div className="timeout-chat-copy">
        <strong>Timeout warning</strong>
        <span>{detail}</span>
        {summary !== null ? <span className="timeout-chat-summary">{summary}</span> : null}
      </div>
      <div className="timeout-chat-actions">
        <span className="timeout-warning-pill">Timeout warning</span>
        <button
          type="button"
          className="primary"
          disabled={busy}
          title="Continue this task from partial progress after the timeout"
          onClick={() => void onContinueTask(task.id)}
        >
          Continue?
        </button>
      </div>
    </div>
  );
}

interface PlanCardProps {
  item: TimelinePlanItem;
  busy: boolean;
  pendingPlanApproval: ApprovalRecord | null;
  forkingPlanId: string | null;
  stackDecision: StackDecision | null;
  onSetPlanStack: (planId: string, stack: string) => Promise<void>;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
  onForkPlan: (planId: string) => Promise<void>;
  onOpenDetail: (plan: PlanRecord) => void;
  onEditPlan: (plan: PlanRecord) => void;
  onRerunTask: (taskId: string, note: string | null) => Promise<void>;
  onContinueTask: (taskId: string) => Promise<void>;
  onSkipTask: (taskId: string) => Promise<void>;
}

const stackSourceLabels: Record<StackDecision["source"], string> = {
  user: "your choice",
  planner: "planner",
  heuristic: "auto-detected",
  workspace: "from workspace",
};

const stackCatalogGroups = Array.from(new Set(stackCatalog.map((entry) => entry.group)));

function PlanStackControl({ plan, tasks, busy, stackDecision, onSetPlanStack }: {
  plan: PlanRecord;
  tasks: TaskRecord[];
  busy: boolean;
  stackDecision: StackDecision | null;
  onSetPlanStack: (planId: string, stack: string) => Promise<void>;
}): React.ReactElement {
  const currentStack = stackDecision?.stack ?? plan.planJson.targetStack ?? null;
  const started = tasks.some((task) => task.status !== "todo");
  const editable = !started && (plan.status === "draft" || plan.status === "approved");
  const title = !editable
    ? started
      ? "Execution has started; fork the session to rebuild on a different stack."
      : `The plan is ${plan.status}; the stack can no longer be changed.`
    : stackDecision !== null
      ? `${stackSourceLabels[stackDecision.source]}: ${stackDecision.rationale}`
      : "Choose the technology stack for this plan.";
  return (
    <div className="plan-stack-row">
      <label className="plan-stack-label" htmlFor={`plan-stack-${plan.id}`}>Stack</label>
      <select
        id={`plan-stack-${plan.id}`}
        className="plan-stack-select"
        value={currentStack ?? ""}
        disabled={busy || !editable}
        title={title}
        onChange={(event) => {
          if (event.target.value.length > 0) void onSetPlanStack(plan.id, event.target.value);
        }}
      >
        {currentStack === null ? <option value="">(not decided)</option> : null}
        {stackCatalogGroups.map((group) => (
          <optgroup key={group} label={group}>
            {stackCatalog.filter((entry) => entry.group === group && (entry.featureFlag === undefined || entry.stack === currentStack)).map((entry) => (
              <option key={entry.stack} value={entry.stack}>{entry.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
      {stackDecision !== null ? (
        <span className="chip chip-muted" title={stackDecision.rationale}>{stackSourceLabels[stackDecision.source]}</span>
      ) : null}
      {stackDecision !== null && stackDecision.confidence === "low" ? (
        <span className="chip chip-warning" title="The stack was inferred with low confidence — please confirm or correct it.">check stack</span>
      ) : null}
    </div>
  );
}

function PlanCard({ item, busy, pendingPlanApproval, forkingPlanId, stackDecision, onSetPlanStack, onResolveApproval, onForkPlan, onOpenDetail, onEditPlan, onRerunTask, onContinueTask, onSkipTask }: PlanCardProps): React.ReactElement {
  const { plan, tasks } = item;
  const pending = pendingPlanApproval !== null && pendingPlanApproval.status === "pending";
  const isResolved = plan.status === "approved" || plan.status === "superseded" || plan.status === "canceled" || plan.status === "completed";
  const hasApprovedPlanForkSurface = (plan.status === "approved" || plan.status === "completed") && plan.approvedAt !== null;
  const canForkApprovedPlan = hasApprovedPlanForkSurface && plan.approvalCheckpointId !== null;
  const forking = forkingPlanId === plan.id;
  const [expanded, setExpanded] = useState<boolean>(!isResolved || pending);

  useEffect(() => {
    if (pending) setExpanded(true);
  }, [pending]);

  const doneCount = tasks.filter((task) => task.status === "done").length;
  const totalCount = tasks.length;
  const progressLabel = totalCount === 0 ? "No tasks yet" : `${doneCount}/${totalCount} tasks done`;

  const statusTone =
    plan.status === "approved" || plan.status === "completed"
      ? "success"
      : plan.status === "canceled"
      ? "danger"
      : "warning";

  return (
    <article className={className("card", "card-plan", pending && "card-attn", `card-tone-${statusTone}`)}>
      <header className="card-header">
        <div className="card-title-row">
          <span className="card-kind">Plan v{plan.version}</span>
          <span className={className("chip", `chip-${statusTone}`)}>{plan.status}</span>
        </div>
        <button type="button" className="card-collapse" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
          {expanded ? "Hide" : "Show"}
        </button>
      </header>
      <h3 className="card-heading">{plan.title}</h3>
      <PlanStackControl plan={plan} tasks={tasks} busy={busy} stackDecision={stackDecision} onSetPlanStack={onSetPlanStack} />
      {expanded ? (
        <ol className="task-checklist">
          {tasks.length === 0 ? <li className="task-empty">No tasks yet.</li> : null}
          {tasks.map((task) => {
            const sym = taskGlyphKind(task.status);
            const targets = metadataList(task, "targetFiles");
            const kind = metadataText(task, "taskKind");
            const timeoutContinuationPending = metadataText(task, "timeoutContinuationStatus") === "pending";
            const timeoutSummary = metadataText(task, "timeoutContinuationSummary");
            return (
              <li key={task.id} className={className("task-row", `task-${task.status}`)}>
                <span className={className("task-glyph", `glyph-${sym.tone}`)} aria-label={sym.aria}>
                  <TaskGlyph kind={sym.kind} />
                </span>
                <div className="task-body">
                  <div className="task-title">
                    <span>{task.title}</span>
                    {kind !== null ? <span className="chip chip-muted">{kind}</span> : null}
                  </div>
                  {targets.length > 0 ? (
                    <div className="task-targets">
                      {targets.slice(0, 3).map((target) => (
                        <code key={target}>{target}</code>
                      ))}
                      {targets.length > 3 ? <span className="task-targets-more">+{targets.length - 3}</span> : null}
                    </div>
                  ) : null}
                  {timeoutContinuationPending && timeoutSummary !== null ? (
                    <p className="task-timeout-note">{timeoutSummary}</p>
                  ) : null}
                </div>
                <span className="task-actions">
                  {timeoutContinuationPending ? (
                    <>
                      <span className="task-timeout-pill">Timeout warning</span>
                      <button
                        type="button"
                        className="task-action task-action-primary"
                        disabled={busy}
                        title="Continue this task from partial progress after the timeout"
                        onClick={() => void onContinueTask(task.id)}
                      >
                        Continue?
                      </button>
                    </>
                  ) : null}
                  {task.status === "done" || task.status === "blocked" || task.status === "skipped" ? (
                    <button
                      type="button"
                      className="task-action"
                      disabled={busy}
                      title="Re-run this task (optionally with extra guidance)"
                      onClick={() => {
                        const note = window.prompt("Optional guidance for this re-run (leave blank for none):", "");
                        if (note === null) return;
                        void onRerunTask(task.id, note.trim().length > 0 ? note.trim() : null);
                      }}
                    >
                      Re-run
                    </button>
                  ) : null}
                  {task.status === "todo" || task.status === "blocked" || task.status === "in_progress" ? (
                    <button
                      type="button"
                      className="task-action"
                      disabled={busy}
                      title="Skip this task"
                      onClick={() => void onSkipTask(task.id)}
                    >
                      Skip
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="card-collapsed-summary">{progressLabel}</p>
      )}
      <footer className="card-footer">
        <span className="card-progress">{progressLabel}</span>
        <div className="card-actions">
          <button type="button" className="ghost" onClick={() => onOpenDetail(plan)}>
            View full plan
          </button>
          {hasApprovedPlanForkSurface ? (
            <>
              <button type="button" className="ghost card-icon-action" disabled={busy || !canForkApprovedPlan} onClick={() => void onForkPlan(plan.id)} title={!canForkApprovedPlan ? "This approved plan does not have a fork checkpoint." : forking ? "Creating fork..." : "Fork from approved plan"} aria-label={forking ? "Creating fork from approved plan" : "Fork from approved plan"}>
                {forking ? <span className="action-spinner" aria-hidden /> : <ForkIcon />}
              </button>
              {forking ? <span className="card-action-status" role="status">Creating fork...</span> : null}
            </>
          ) : null}
          {pending && pendingPlanApproval !== null ? (
            <>
              <button type="button" className="ghost" disabled={busy} onClick={() => onEditPlan(plan)}>
                Edit plan
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void onResolveApproval(pendingPlanApproval.id, "approved")}
              >
                Approve plan
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void onResolveApproval(pendingPlanApproval.id, "rejected")}
              >
                Reject
              </button>
            </>
          ) : null}
        </div>
      </footer>
    </article>
  );
}

interface ApprovalCardProps {
  item: TimelineApprovalItem;
  busy: boolean;
  onResolveApproval: (approvalId: string, status: "approved" | "rejected") => Promise<void>;
}

function ApprovalCard({ item, busy, onResolveApproval }: ApprovalCardProps): React.ReactElement {
  const { approval } = item;
  const pending = approval.status === "pending";
  const tone = approval.status === "approved" ? "success" : approval.status === "rejected" ? "danger" : "warning";
  const [expanded, setExpanded] = useState<boolean>(pending);

  useEffect(() => {
    if (pending) setExpanded(true);
  }, [pending]);

  if (!pending && !expanded) {
    return (
      <div className={className("milestone", `milestone-${tone}`)}>
        <span className="milestone-line" aria-hidden />
        <span className="milestone-label">
          Approval {approval.status} · {approval.approvalKind}
          {approval.resolvedAt !== null ? <span className="milestone-detail"> · {formatTime(approval.resolvedAt)}</span> : null}
        </span>
        <button type="button" className="milestone-expand" onClick={() => setExpanded(true)}>
          Show
        </button>
      </div>
    );
  }
  const payload = approval.payload;
  const rawParams = typeof payload.params === "object" && payload.params !== null && !Array.isArray(payload.params)
    ? payload.params as Record<string, unknown>
    : null;
  const command = rawParams === null
    ? ""
    : Array.isArray(rawParams.command)
      ? rawParams.command.map((part) => String(part)).join(" ")
      : typeof rawParams.command === "string"
        ? rawParams.command
        : "";
  const cwd = rawParams !== null && typeof rawParams.cwd === "string" ? rawParams.cwd : "";
  const itemId = typeof payload.itemId === "string" ? payload.itemId : rawParams !== null && typeof rawParams.itemId === "string" ? rawParams.itemId : "";
  const method = typeof payload.method === "string" ? payload.method : "";
  const sourceThreadId = typeof payload.sourceThreadId === "string" && payload.sourceThreadId.length > 0
    ? payload.sourceThreadId
    : typeof payload.threadId === "string" ? payload.threadId : approval.codexThreadId ?? "";
  const isSubagentApproval = payload.isSubagentApproval === true;

  return (
    <article className={className("card", "card-approval", pending && "card-attn", `card-tone-${tone}`)}>
      <header className="card-header">
        <div className="card-title-row">
          <span className="card-kind">Approval</span>
          <span className={className("chip", `chip-${tone}`)}>{approval.status}</span>
          <span className="chip chip-muted">{approval.approvalKind}</span>
        </div>
        {!pending ? (
          <button type="button" className="card-collapse" onClick={() => setExpanded(false)}>
            Hide
          </button>
        ) : null}
      </header>
      <h3 className="card-heading">{approval.reason || "Approval required"}</h3>
      <p className="card-subhead">Requested at {formatTime(approval.requestedAt)}</p>
      {method.length > 0 || command.length > 0 || cwd.length > 0 || itemId.length > 0 || sourceThreadId.length > 0 ? (
        <div className="card-note">
          {method.length > 0 ? <p>Method: <code>{method}</code></p> : null}
          {sourceThreadId.length > 0 ? <p>Origin: <code>{isSubagentApproval ? `subagent ${sourceThreadId.slice(0, 8)}` : sourceThreadId.slice(0, 8)}</code></p> : null}
          {command.length > 0 ? <p>Command: <code>{command}</code></p> : null}
          {cwd.length > 0 ? <p>CWD: <code>{cwd}</code></p> : null}
          {itemId.length > 0 ? <p>Item: <code>{itemId}</code></p> : null}
        </div>
      ) : null}
      <footer className="card-footer">
        <span className="card-progress">
          {approval.resolvedAt !== null ? `Resolved ${formatTime(approval.resolvedAt)}` : "Awaiting decision"}
        </span>
        {pending ? (
          <div className="card-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void onResolveApproval(approval.id, "approved")}
            >
              Approve
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void onResolveApproval(approval.id, "rejected")}
            >
              Reject
            </button>
          </div>
        ) : null}
      </footer>
    </article>
  );
}

interface VerificationCardProps {
  item: TimelineVerificationItem;
  onOpenDetail: (run: VerificationRunRecord) => void;
}

function VerificationCard({ item, onOpenDetail }: VerificationCardProps): React.ReactElement {
  const { run } = item;
  const tone = run.status === "passed" ? "success" : run.status === "failed" ? "danger" : "warning";

  return (
    <article className={className("card", "card-verification", `card-tone-${tone}`)}>
      <header className="card-header">
        <div className="card-title-row">
          <span className="card-kind">Verification</span>
          <span className={className("chip", `chip-${tone}`)}>{run.status}</span>
        </div>
      </header>
      <h3 className="card-heading">{run.summary || "Verification run"}</h3>
      <p className="card-subhead">
        {run.commands.length} {run.commands.length === 1 ? "command" : "commands"} · started {formatTime(run.startedAt)}
      </p>
      {run.commands.length > 0 ? (
        <ul className="cmd-list">
          {run.commands.slice(0, 4).map((cmd) => (
            <li key={cmd}><code>{cmd}</code></li>
          ))}
          {run.commands.length > 4 ? <li className="task-empty">+{run.commands.length - 4} more</li> : null}
        </ul>
      ) : null}
      <footer className="card-footer">
        <span className="card-progress">{run.endedAt !== null ? `Finished ${formatTime(run.endedAt)}` : "Running"}</span>
        <div className="card-actions">
          <button type="button" className="ghost" onClick={() => onOpenDetail(run)}>
            View output
          </button>
        </div>
      </footer>
    </article>
  );
}

interface PreviewCardProps {
  item: TimelinePreviewItem;
  busy: boolean;
  onStartPreview: () => Promise<void>;
  onHardRestartPreview: () => Promise<void>;
  onRepairPreview: () => Promise<void>;
  onStopPreview: () => Promise<void>;
  onOpenPreview: () => Promise<void>;
}

function PreviewCard({ item, busy, onStartPreview, onHardRestartPreview, onRepairPreview, onStopPreview, onOpenPreview }: PreviewCardProps): React.ReactElement {
  const { preview } = item;
  const idleStopped = preview.status === "stopped" && preview.stoppedReason === "idle_timeout";
  const tone =
    preview.status === "ready"
      ? "success"
      : preview.status === "failed"
      ? "danger"
      : preview.status === "stopped" || preview.status === "unavailable"
      ? "neutral"
      : "warning";

  return (
    <article className={className("card", "card-preview", `card-tone-${tone}`)}>
      <header className="card-header">
        <div className="card-title-row">
          <span className="card-kind">Preview</span>
          <span className={className("chip", `chip-${tone}`)}>{preview.status}</span>
        </div>
      </header>
      <h3 className="card-heading">{preview.appType}</h3>
      <p className="card-subhead"><code>{preview.url}</code></p>
      <footer className="card-footer">
        <span className="card-progress">Started {formatTime(preview.startedAt)}</span>
        <div className="card-actions">
          {preview.status === "failed" ? (
            <button type="button" className="primary" disabled={busy} onClick={() => void onRepairPreview()}>
              Repair preview
            </button>
          ) : null}
          <button type="button" className="ghost" disabled={busy} onClick={() => void onStartPreview()}>
            {preview.status === "ready" || idleStopped ? "Refresh" : "Start"}
          </button>
          <button type="button" className="ghost" disabled={busy} onClick={() => void onHardRestartPreview()}>
            Hard restart
          </button>
          <button type="button" className="ghost" disabled={busy || preview.status === "unavailable"} onClick={() => void onOpenPreview()}>
            Open
          </button>
          <button type="button" className="ghost" disabled={busy || preview.status === "stopped"} onClick={() => void onStopPreview()}>
            Stop
          </button>
        </div>
      </footer>
    </article>
  );
}

interface HandoffCardProps {
  item: TimelineHandoffItem;
  workspacePath: string | null;
  busy: boolean;
  forkingHandoffId: string | null;
  canUndoLast: boolean;
  canOpenCheckpointHistory: boolean;
  onOpenDetail: (handoff: HandoffRecord) => void;
  onOpenChanges: (handoff: HandoffRecord) => void;
  onForkHandoff: (handoffId: string) => Promise<void>;
  onUndoLast: () => Promise<void>;
  onOpenCheckpointHistory: () => void;
  onOpenRunLogs: () => void;
}

function HandoffCard({ item, workspacePath, busy, forkingHandoffId, canUndoLast, canOpenCheckpointHistory, onOpenDetail, onOpenChanges, onForkHandoff, onUndoLast, onOpenCheckpointHistory, onOpenRunLogs }: HandoffCardProps): React.ReactElement {
  const { handoff } = item;
  const summary = handoff.summaryMarkdown.split("\n").slice(0, 3).join("\n");
  const forking = handoff.id === forkingHandoffId;
  return (
    <article className="card card-handoff card-tone-success">
      <header className="card-header">
        <div className="card-title-row">
          <span className="card-kind">Handoff</span>
          <span className="chip chip-success">delivered</span>
        </div>
      </header>
      <h3 className="card-heading">Final summary</h3>
      <pre className="card-pre">{summary}</pre>
      {workspacePath !== null && workspacePath.trim().length > 0 ? (
        <div className="card-subblock">
          <span>Workspace</span>
          <code className="card-inline-code">{workspacePath}</code>
        </div>
      ) : null}
      {handoff.nextSteps.length > 0 ? (
        <div className="card-subblock">
          <span>Next steps</span>
          <ul>
            {handoff.nextSteps.slice(0, 3).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <footer className="card-footer">
        <span className="card-progress">Created {formatTime(handoff.createdAt)}</span>
        <div className="card-actions">
          <button type="button" className="ghost card-icon-action" disabled={busy} onClick={() => void onForkHandoff(handoff.id)} title={forking ? "Creating fork..." : "Fork chat from this handoff"} aria-label={forking ? "Creating fork from this handoff" : "Fork chat from this handoff"}>
            {forking ? <span className="action-spinner" aria-hidden /> : <ForkIcon />}
          </button>
          {forking ? <span className="card-action-status" role="status">Creating fork...</span> : null}
          {canUndoLast ? (
            <button type="button" className="danger-text card-icon-action" disabled={busy} onClick={() => void onUndoLast()} title="Restore the previous orchestrator checkpoint" aria-label="Undo last checkpoint">
              <UndoIcon />
            </button>
          ) : null}
          {canOpenCheckpointHistory ? (
            <button type="button" className="ghost card-icon-action" disabled={busy} onClick={onOpenCheckpointHistory} title="View checkpoints and restore to an earlier point" aria-label="Open checkpoint history">
              <HistoryIcon />
            </button>
          ) : null}
          <button type="button" className="ghost" onClick={() => onOpenDetail(handoff)}>
            View full handoff
          </button>
          <button type="button" className="ghost" onClick={() => onOpenChanges(handoff)}>
            Changed files
          </button>
          <button type="button" className="ghost" onClick={onOpenRunLogs}>
            View run logs
          </button>
        </div>
      </footer>
    </article>
  );
}

function ForkIcon(): React.ReactElement {
  return (
    <svg className="card-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 5v4.5A5.5 5.5 0 0 0 11.5 15H18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 5v14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="m15 12 3 3-3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UndoIcon(): React.ReactElement {
  return (
    <svg className="card-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M9 4 4 9l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function HistoryIcon(): React.ReactElement {
  return (
    <svg className="card-action-icon" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 8v5l3 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 8h4V4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4.8 8.2A8 8 0 1 1 4 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ActivityIndicator({ item }: { item: TimelineActivityItem }): React.ReactElement {
  return (
    <div className="activity" role="status" aria-live="polite">
      <span className="activity-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <div className="activity-body">
        <strong>{item.label}</strong>
        {item.detail !== undefined ? <span className="activity-detail">{item.detail}</span> : null}
      </div>
    </div>
  );
}

export type { PreviewServerRecord };
