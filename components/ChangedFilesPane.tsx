"use client";

import { useEffect, useMemo, useState } from "react";
import type { ApiResult, HandoffRecord, SessionChangedFile, SessionChangeSet, SessionFileDiff, WorkSessionRecord } from "@/lib/shared/types";
import { logClientProcess } from "@/lib/client/logging";
import { buildDiffTree, type DiffTreeNode } from "@/lib/shared/diff-utils";

interface ChangedFilesPaneProps {
  workSession: WorkSessionRecord | null;
  handoff: HandoffRecord | null;
  onShowPreview: () => void;
}

type ChangeSetResult = ApiResult<SessionChangeSet>;
type FileDiffResult = ApiResult<SessionFileDiff>;
type DiffViewMode = "unified" | "split";

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, { method: "GET" });
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  return body;
}

function isChangeSetResult(value: unknown): value is ChangeSetResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

function isFileDiffResult(value: unknown): value is FileDiffResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

function changeLabel(file: SessionChangedFile): string {
  switch (file.changeKind) {
    case "create":
      return "Created";
    case "delete":
      return "Deleted";
    case "rename":
      return "Renamed";
    case "update":
      return "Updated";
  }
}

function statsLabel(additions: number | null | undefined, deletions: number | null | undefined): string {
  const plus = additions ?? 0;
  const minus = deletions ?? 0;
  if (plus === 0 && minus === 0) return "";
  return `+${plus} -${minus}`;
}

function renderDiffLines(diffText: string, ignoreWhitespace: boolean): React.ReactElement[] {
  const lines = diffText.split(/\r?\n/);
  return lines.map((line, index) => {
    const compareLine = ignoreWhitespace ? line.replace(/\s+/g, "") : line;
    const kind = compareLine.startsWith("+") && !compareLine.startsWith("+++") ? "add"
      : compareLine.startsWith("-") && !compareLine.startsWith("---") ? "del"
        : compareLine.startsWith("@@") ? "hunk"
          : "ctx";
    return (
      <div key={`${index}:${line.slice(0, 20)}`} className={`diff-line diff-line-${kind}`}>
        <span className="diff-line-number">{index + 1}</span>
        <code>{line.length > 0 ? line : " "}</code>
      </div>
    );
  });
}

function TreeRow({
  node,
  selectedFile,
  depth,
  expanded,
  onToggle,
  onSelect,
}: {
  node: DiffTreeNode;
  selectedFile: string | null;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}): React.ReactElement {
  const isDirectory = node.kind === "directory";
  const isOpen = expanded.has(node.path);
  const rowClass = node.kind === "file" && node.path === selectedFile ? " changed-file-row-active" : "";
  return (
    <>
      <button
        type="button"
        className={`changed-file-row changed-file-tree-row${rowClass}`}
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => isDirectory ? onToggle(node.path) : onSelect(node.path)}
        role="option"
        aria-selected={node.kind === "file" && node.path === selectedFile}
      >
        <span className="changed-file-icon" aria-hidden="true">{isDirectory ? (isOpen ? "▾" : "▸") : "•"}</span>
        {node.kind === "file" && node.file !== null ? <span className={`changed-file-kind changed-file-kind-${node.file.changeKind}`}>{changeLabel(node.file)}</span> : null}
        <code title={node.path}>{node.name || node.path}</code>
        <small>{statsLabel(node.additions, node.deletions)}</small>
      </button>
      {isDirectory && isOpen ? node.children.map((child) => (
        <TreeRow
          key={child.id}
          node={child}
          selectedFile={selectedFile}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          onSelect={onSelect}
        />
      )) : null}
    </>
  );
}

export function ChangedFilesPane({ workSession, handoff, onShowPreview }: ChangedFilesPaneProps): React.ReactElement {
  const [changeSet, setChangeSet] = useState<SessionChangeSet | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<SessionFileDiff | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set([""]));
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>("unified");
  const [wrapDiff, setWrapDiff] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);

  const workSessionId = workSession?.id ?? null;
  const handoffId = handoff?.id ?? null;

  useEffect(() => {
    setChangeSet(null);
    setDiff(null);
    setSelectedFile(null);
    setError(null);
    if (workSessionId === null || handoffId === null) {
      return;
    }
    let active = true;
    setLoadingList(true);
    logClientProcess("info", "changed_files.load.start", { workSessionId, handoffId });
    void readJson(`/api/work-sessions/${encodeURIComponent(workSessionId)}/changes?handoffId=${encodeURIComponent(handoffId)}`)
      .then((body) => {
        if (!active) return;
        if (!isChangeSetResult(body) || !body.ok || body.data === undefined) {
          throw new Error("Invalid changed files API response.");
        }
        setChangeSet(body.data);
        setSelectedFile(body.data.files[0]?.filePath ?? null);
        setExpandedPaths(new Set(["", ...body.data.files.map((file) => file.filePath.split("/").slice(0, -1).join("/")).filter((entry) => entry.length > 0)]));
        logClientProcess("info", "changed_files.load.completed", {
          workSessionId,
          handoffId,
          source: body.data.source,
          fileCount: body.data.files.length,
        });
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        const message = loadError instanceof Error ? loadError.message : "Changed files could not be loaded.";
        setError(message);
        logClientProcess("error", "changed_files.load.failed", { workSessionId, handoffId, message });
      })
      .finally(() => {
        if (active) setLoadingList(false);
      });
    return () => {
      active = false;
    };
  }, [handoffId, workSessionId]);

  useEffect(() => {
    setDiff(null);
    if (workSessionId === null || handoffId === null || selectedFile === null) {
      return;
    }
    let active = true;
    setLoadingDiff(true);
    setError(null);
    logClientProcess("info", "changed_files.diff.start", { workSessionId, handoffId, filePath: selectedFile });
    const query = new URLSearchParams({ handoffId, filePath: selectedFile });
    void readJson(`/api/work-sessions/${encodeURIComponent(workSessionId)}/changes/diff?${query.toString()}`)
      .then((body) => {
        if (!active) return;
        if (!isFileDiffResult(body) || !body.ok || body.data === undefined) {
          throw new Error("Invalid diff API response.");
        }
        setDiff(body.data);
        logClientProcess("info", "changed_files.diff.completed", {
          workSessionId,
          handoffId,
          filePath: selectedFile,
          source: body.data.source,
          chars: body.data.diff.length,
        });
      })
      .catch((diffError: unknown) => {
        if (!active) return;
        const message = diffError instanceof Error ? diffError.message : "Diff could not be loaded.";
        setError(message);
        logClientProcess("error", "changed_files.diff.failed", { workSessionId, handoffId, filePath: selectedFile, message });
      })
      .finally(() => {
        if (active) setLoadingDiff(false);
      });
    return () => {
      active = false;
    };
  }, [handoffId, selectedFile, workSessionId]);

  const selectedChange = useMemo(
    () => changeSet?.files.find((file) => file.filePath === selectedFile) ?? null,
    [changeSet?.files, selectedFile],
  );
  const fileTree = useMemo(() => buildDiffTree(changeSet?.files ?? []), [changeSet?.files]);
  const totalAdditions = changeSet?.files.reduce((sum, file) => sum + (file.additions ?? 0), 0) ?? 0;
  const totalDeletions = changeSet?.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) ?? 0;

  return (
    <aside className="pane changed-files-pane">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-eyebrow">Final summary</span>
          <strong>Changed files</strong>
        </div>
        <div className="pane-actions">
          <button type="button" className="ghost small" onClick={onShowPreview}>
            Preview
          </button>
        </div>
      </header>
      <div className="pane-body changed-files-body">
        {handoff === null || workSession === null ? (
          <div className="pane-placeholder">
            <p>No final summary selected.</p>
            <p className="muted">Open changed files from a Final summary card.</p>
          </div>
        ) : loadingList ? (
          <div className="pane-placeholder">
            <p>Loading changed files...</p>
          </div>
        ) : error !== null && changeSet === null ? (
          <div className="pane-placeholder">
            <p>Changed files unavailable.</p>
          </div>
        ) : changeSet !== null && changeSet.files.length === 0 ? (
          <div className="pane-placeholder">
            <p>No changed files captured.</p>
            <p className="muted">This handoff did not include checkpoint-backed file changes.</p>
          </div>
        ) : (
          <>
            <div className="changed-files-meta">
              <span>{changeSet?.files.length ?? 0} file{changeSet?.files.length === 1 ? "" : "s"}</span>
              <span className="changed-files-stat">+{totalAdditions} -{totalDeletions}</span>
              <span>{changeSet?.source === "checkpoint" ? "checkpoint diff" : "recorded changes"}</span>
            </div>
            <div className="changed-files-layout">
              <div className="changed-files-list" role="listbox" aria-label="Changed files">
                {fileTree.children.map((node) => (
                  <TreeRow
                    key={node.id}
                    node={node}
                    selectedFile={selectedFile}
                    depth={0}
                    expanded={expandedPaths}
                    onToggle={(path) => setExpandedPaths((current) => {
                      const next = new Set(current);
                      if (next.has(path)) next.delete(path);
                      else next.add(path);
                      return next;
                    })}
                    onSelect={setSelectedFile}
                  />
                ))}
              </div>
              <div className="changed-files-diff">
                {selectedChange !== null ? (
                  <div className="changed-files-diff-title">
                    <div className="changed-files-diff-heading">
                      <span className={`changed-file-kind changed-file-kind-${selectedChange.changeKind}`}>{changeLabel(selectedChange)}</span>
                      <code>{selectedChange.filePath}</code>
                      <small>{statsLabel(diff?.additions ?? selectedChange.additions, diff?.deletions ?? selectedChange.deletions)}</small>
                    </div>
                    <div className="changed-files-diff-actions">
                      <button type="button" className={diffViewMode === "unified" ? "segmented active" : "segmented"} onClick={() => setDiffViewMode("unified")}>Unified</button>
                      <button type="button" className={diffViewMode === "split" ? "segmented active" : "segmented"} onClick={() => setDiffViewMode("split")}>Split</button>
                      <button type="button" className={wrapDiff ? "segmented active" : "segmented"} onClick={() => setWrapDiff((value) => !value)}>Wrap</button>
                      <button type="button" className={ignoreWhitespace ? "segmented active" : "segmented"} onClick={() => setIgnoreWhitespace((value) => !value)}>Ignore ws</button>
                    </div>
                  </div>
                ) : null}
                {loadingDiff ? (
                  <div className="pane-placeholder">
                    <p>Loading diff...</p>
                  </div>
                ) : diff !== null ? (
                  diff.binary === true ? (
                    <div className="pane-placeholder">
                      <p>Binary diff.</p>
                      <p className="muted">No textual diff is available for this file.</p>
                    </div>
                  ) : diff.diff.trim().length > 0 ? (
                    <div className={`changed-files-diff-render changed-files-diff-render-${diffViewMode}${wrapDiff ? " changed-files-diff-wrap" : ""}`}>
                      {renderDiffLines(diff.diff, ignoreWhitespace)}
                    </div>
                  ) : (
                    <div className="pane-placeholder">
                      <p>No textual diff was produced for this file.</p>
                    </div>
                  )
                ) : null}
              </div>
            </div>
          </>
        )}
        {error !== null ? (
          <div className="changed-files-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
      <footer className="pane-footer">
        <dl className="session-mini">
          <div>
            <dt>State</dt>
            <dd>{workSession?.currentState ?? "idle"}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{changeSet?.source ?? "-"}</dd>
          </div>
          <div>
            <dt>Base</dt>
            <dd>{changeSet?.baseCheckpointId?.slice(0, 8) ?? "-"}</dd>
          </div>
          <div>
            <dt>Target</dt>
            <dd>{changeSet?.targetCheckpointId?.slice(0, 8) ?? "-"}</dd>
          </div>
        </dl>
      </footer>
    </aside>
  );
}
