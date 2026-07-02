"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  ExperimentRunRecord,
  MlDataContract,
  MlRunConfig,
  PreviewServerRecord,
  PythonEntrypointOption,
  PythonRunParams,
  RFigureFormat,
  RRunParams,
  VerificationRunRecord,
  WorkSessionRecord,
} from "@/lib/shared/types";
import { emptyPythonRunParams, envToLines, figureFormats, parseArgvLine, parseEnvLines } from "@/lib/shared/python-run";
import { emptyRRunParams, rFigureFormats } from "@/lib/shared/r-run";
import { isFileModality, type InferenceContract, type InferenceInputSpec, type InferenceWorkerInfo } from "@/lib/shared/inference-contract";

type ScriptRunParams = PythonRunParams | RRunParams;
import type { StatusProjection } from "@/lib/shared/ui-projections";
import { logClientProcess } from "@/lib/client/logging";

function experimentRunTone(status: ExperimentRunRecord["status"]): "success" | "warning" | "danger" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "aborted") return "danger";
  return "warning";
}

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
    mozdirectory?: string;
  }
}

interface PreviewPaneProps {
  preview: PreviewServerRecord | null;
  workSession: WorkSessionRecord | null;
  verification: VerificationRunRecord | null;
  status: StatusProjection;
  busy: boolean;
  pendingFirstServe?: boolean;
  executingTaskTitle?: string | null;
  restoring?: boolean;
  onStartPreview: () => Promise<void>;
  onHardRestartPreview: () => Promise<void>;
  onRepairPreview: () => Promise<void>;
  onStopPreview: () => Promise<void>;
  onOpenPreview: () => Promise<void>;
  onRunPython: (params: ScriptRunParams) => Promise<void>;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function browserAlignedPreviewUrl(previewUrl: string): string {
  if (typeof window === "undefined") {
    return previewUrl;
  }
  try {
    const parsed = new URL(previewUrl);
    const browserHostname = window.location.hostname;
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:")
      && isLoopbackHostname(parsed.hostname)
      && isLoopbackHostname(browserHostname)
      && parsed.hostname !== browserHostname
    ) {
      parsed.hostname = browserHostname;
      return parsed.toString();
    }
  } catch {
    return previewUrl;
  }
  return previewUrl;
}

export function PreviewPane({
  preview,
  workSession,
  verification,
  status,
  busy,
  pendingFirstServe = false,
  executingTaskTitle = null,
  restoring = false,
  onStartPreview,
  onHardRestartPreview,
  onRepairPreview,
  onStopPreview,
  onOpenPreview,
  onRunPython,
}: PreviewPaneProps): React.ReactElement {
  const researchMode = workSession?.deliveryKind === "research";
  const ready = preview?.status === "ready";
  const failed = preview?.status === "failed";
  const idleStopped = preview?.status === "stopped" && preview.stoppedReason === "idle_timeout";
  const [watchLive, setWatchLive] = useState(false);
  useEffect(() => {
    setWatchLive(false);
  }, [workSession?.id]);
  const veiled = ready && executingTaskTitle !== null && !watchLive && !researchMode;
  const [iframePreviewUrl, setIframePreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    setIframePreviewUrl(preview?.url !== undefined ? browserAlignedPreviewUrl(preview.url) : null);
  }, [preview?.url]);
  const renderedPreviewUrl = iframePreviewUrl ?? preview?.url ?? "";
  useEffect(() => {
    logClientProcess("info", "preview_pane.render_state", {
      workSessionId: workSession?.id ?? null,
      previewId: preview?.id ?? null,
      previewStatus: preview?.status ?? null,
      previewUrl: preview?.url ?? null,
      iframePreviewUrl: renderedPreviewUrl || null,
      appType: preview?.appType ?? null,
      verificationStatus: verification?.status ?? null,
    });
  }, [preview?.appType, preview?.id, preview?.status, preview?.url, renderedPreviewUrl, verification?.status, workSession?.id]);

  return (
    <aside className="pane">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-eyebrow">Live preview</span>
          <strong>{preview?.appType ?? "no preview"}</strong>
        </div>
        <div className="pane-actions">
          {failed ? (
            <button type="button" className="primary small" disabled={researchMode || busy || workSession === null} onClick={() => {
              logClientProcess("info", "preview_pane.button.repair", { workSessionId: workSession?.id ?? null, previewId: preview?.id ?? null });
              void onRepairPreview();
            }}>
              Repair preview
            </button>
          ) : null}
          <button type="button" className="ghost small" disabled={researchMode || busy || workSession === null} onClick={() => {
            logClientProcess("info", "preview_pane.button.start", { workSessionId: workSession?.id ?? null, previewId: preview?.id ?? null });
            void onStartPreview();
          }}>
            {ready || idleStopped ? "Refresh" : "Start"}
          </button>
          <button type="button" className="ghost small" disabled={researchMode || busy || workSession === null} onClick={() => {
            logClientProcess("info", "preview_pane.button.hard_restart", { workSessionId: workSession?.id ?? null, previewId: preview?.id ?? null });
            void onHardRestartPreview();
          }}>
            Hard restart
          </button>
          <button type="button" className="ghost small" disabled={researchMode || busy || workSession === null || (preview !== null && preview.status === "unavailable")} onClick={() => {
            logClientProcess("info", "preview_pane.button.open", { workSessionId: workSession?.id ?? null, previewId: preview?.id ?? null, url: preview?.url ?? null });
            void onOpenPreview();
          }}>
            Open
          </button>
          <button type="button" className="ghost small" disabled={researchMode || busy || !preview || preview.status === "stopped"} onClick={() => {
            logClientProcess("info", "preview_pane.button.stop", { workSessionId: workSession?.id ?? null, previewId: preview?.id ?? null });
            void onStopPreview();
          }}>
            Stop
          </button>
        </div>
      </header>
      <div className="pane-body">
        {researchMode ? (
          <div className="pane-placeholder">
            <p>No app preview for this session.</p>
            <p className="muted">Research results are returned in chat with full evidence stored in artifacts.</p>
          </div>
        ) : ready && preview !== null ? (
          <div className="pane-frame-shell">
            <iframe
              key={`${preview.id}:${preview.refreshRevision ?? 0}:${renderedPreviewUrl}`}
              className="pane-frame"
              title="Generated app preview"
              src={renderedPreviewUrl}
              sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"
              onLoad={() => logClientProcess("info", "preview_pane.iframe.loaded", {
                workSessionId: preview.workSessionId,
                previewId: preview.id,
                url: renderedPreviewUrl,
                canonicalUrl: preview.url,
              })}
            />
            {veiled ? (
              <div className="pane-veil">
                <p>Task running: {executingTaskTitle}</p>
                <p className="muted">The preview updates at the next checkpoint — live dev servers show work in progress, which can look broken while the agent edits.</p>
                <button type="button" className="ghost small" onClick={() => {
                  logClientProcess("info", "preview_pane.button.watch_live", { workSessionId: workSession?.id ?? null, previewId: preview.id });
                  setWatchLive(true);
                }}>
                  Watch live anyway
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <PreviewPlaceholder preview={preview} workSession={workSession} pendingFirstServe={pendingFirstServe} />
        )}
        {!researchMode ? <ScriptRunPanel workSession={workSession} busy={busy} previewStatus={preview?.status ?? null} onRunPython={onRunPython} /> : null}
        {!researchMode ? <ExperimentPanel workSession={workSession} busy={busy} /> : null}
        {!researchMode ? <InferencePanel workSession={workSession} busy={busy} /> : null}
        {preview !== null && preview.stderrTail.trim().length > 0 ? (
          <details className="pane-log">
            <summary>stderr</summary>
            <pre>{preview.stderrTail}</pre>
          </details>
        ) : null}
        {preview !== null && preview.status === "failed" && preview.stdoutTail.trim().length > 0 ? (
          <details className="pane-log">
            <summary>stdout</summary>
            <pre>{preview.stdoutTail}</pre>
          </details>
        ) : null}
        {restoring ? (
          <div className="pane-restoring" role="status" aria-live="polite">
            <span className="pane-restoring-spinner" aria-hidden />
            <p>Restoring workspace…</p>
            <p className="muted">Rolling the files back and reloading the preview.</p>
          </div>
        ) : null}
      </div>
      <footer className="pane-footer">
        <SessionMini workSession={workSession} verification={verification} preview={preview} status={status} />
      </footer>
    </aside>
  );
}

function PreviewPlaceholder({
  preview,
  workSession,
  pendingFirstServe,
}: {
  preview: PreviewServerRecord | null;
  workSession: WorkSessionRecord | null;
  pendingFirstServe: boolean;
}): React.ReactElement {
  if (workSession === null) {
    return (
      <div className="pane-placeholder">
        <p>No active session yet.</p>
        <p className="muted">Send a request to spin up a project.</p>
      </div>
    );
  }
  if (preview === null) {
    if (pendingFirstServe) {
      return (
        <div className="pane-placeholder">
          <p>App not yet servable — tasks are still building it.</p>
          <p className="muted">A background probe checks after every task; the preview appears automatically the first time the home page renders.</p>
        </div>
      );
    }
    return (
      <div className="pane-placeholder">
        <p>No preview running.</p>
        <p className="muted">Start the preview once the plan is approved.</p>
      </div>
    );
  }
  const sessionStillWorking = !["completed", "blocked", "failed", "canceled", "handoff_needed"].includes(workSession.currentState);
  if (preview.status === "failed" && sessionStillWorking) {
    return (
      <div className="pane-placeholder pane-placeholder-danger">
        <p>A broken page was detected — the loop is repairing it.</p>
        <p className="muted">The preview returns automatically once the page renders again.</p>
      </div>
    );
  }
  const label =
    preview.status === "starting"
      ? "Preview is starting…"
      : preview.status === "failed"
      ? "Preview failed to start."
      : preview.status === "stopped"
      ? "Preview is stopped."
      : "Preview is unavailable.";
  return (
    <div className={`pane-placeholder${preview.status === "failed" ? " pane-placeholder-danger" : ""}`}>
      <p>{label}</p>
      <p className="muted">
        <code>{preview.url}</code>
      </p>
    </div>
  );
}

type RunParamsKind = "python" | "r";

interface ScriptRunMetaResponse {
  ok: boolean;
  data?: {
    entrypoints: PythonEntrypointOption[];
    runParams: ScriptRunParams | null;
    supportsPythonRunParams?: boolean;
    supportsRRunParams?: boolean;
    supportsRunParams?: boolean;
    runParamsKind?: RunParamsKind | null;
    appType?: string;
  };
  error?: string;
}

function ScriptRunPanel({
  workSession,
  busy,
  previewStatus,
  onRunPython,
}: {
  workSession: WorkSessionRecord | null;
  busy: boolean;
  previewStatus: PreviewServerRecord["status"] | null;
  onRunPython: (params: ScriptRunParams) => Promise<void>;
}): React.ReactElement | null {
  const workSessionId = workSession?.id ?? null;
  const workSessionPath = workSession?.activeWorktreePath ?? null;
  const [runComplete, setRunComplete] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const previousStatusRef = useRef<{ workSessionId: string | null; status: PreviewServerRecord["status"] | null }>({ workSessionId: null, status: null });
  const [supportsRunParams, setSupportsRunParams] = useState(false);
  const [kind, setKind] = useState<RunParamsKind>("python");
  const [entrypoints, setEntrypoints] = useState<PythonEntrypointOption[]>([]);
  const [entrypoint, setEntrypoint] = useState("");
  const [argvLine, setArgvLine] = useState("");
  const [stdin, setStdin] = useState("");
  const [envText, setEnvText] = useState("");
  const [dpi, setDpi] = useState("");
  const [figureFormat, setFigureFormat] = useState("");
  const [style, setStyle] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");

  useEffect(() => {
    if (workSessionId === null) {
      setSupportsRunParams(false);
      setEntrypoints([]);
      return;
    }
    let active = true;
    logClientProcess("info", "script_panel.metadata.load.start", { workSessionId, previewStatus });
    void fetch(`/api/work-sessions/${workSessionId}/preview`, { method: "GET" })
      .then((response) => response.json() as Promise<ScriptRunMetaResponse>)
      .then((body) => {
        if (!active || !body.ok || body.data === undefined) return;
        const supports = body.data.supportsRunParams === true || body.data.supportsPythonRunParams === true;
        const resolvedKind: RunParamsKind = body.data.runParamsKind ?? (body.data.supportsRRunParams ? "r" : "python");
        logClientProcess("info", "script_panel.metadata.load.completed", {
          workSessionId,
          previewStatus,
          appType: body.data.appType ?? null,
          runParamsKind: resolvedKind,
          supportsRunParams: supports,
          entrypointCount: body.data.entrypoints.length,
          hasRunParams: body.data.runParams !== null,
        });
        setSupportsRunParams(supports);
        setKind(resolvedKind);
        setEntrypoints(body.data.entrypoints);
        if (!supports) {
          setEntrypoint("");
          setArgvLine("");
          setStdin("");
          setEnvText("");
          setDpi("");
          setFigureFormat("");
          setStyle("");
          setWidth("");
          setHeight("");
          return;
        }
        const params = body.data.runParams;
        setEntrypoint(params?.entrypoint ?? "");
        setArgvLine((params?.argv ?? []).join(" "));
        setStdin(params?.stdin ?? "");
        setEnvText(params ? envToLines(params.env) : "");
        if (resolvedKind === "r") {
          const graphics = (params as RRunParams | null)?.graphics ?? null;
          setDpi(graphics?.dpi !== null && graphics?.dpi !== undefined ? String(graphics.dpi) : "");
          setFigureFormat(graphics?.format ?? "");
          setWidth(graphics?.width !== null && graphics?.width !== undefined ? String(graphics.width) : "");
          setHeight(graphics?.height !== null && graphics?.height !== undefined ? String(graphics.height) : "");
          setStyle("");
        } else {
          const matplotlib = (params as PythonRunParams | null)?.matplotlib ?? null;
          setDpi(matplotlib?.dpi !== null && matplotlib?.dpi !== undefined ? String(matplotlib.dpi) : "");
          setFigureFormat(matplotlib?.format ?? "");
          setStyle(matplotlib?.style ?? "");
          setWidth("");
          setHeight("");
        }
      })
      .catch((error: unknown) => {
        logClientProcess("warn", "script_panel.metadata.load.failed", {
          workSessionId,
          message: error instanceof Error ? error.message : "unknown metadata error",
        });
      });
    return () => {
      active = false;
    };
  }, [previewStatus, workSessionId, workSessionPath]);

  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = { workSessionId, status: previewStatus };
    const becameReady = previewStatus === "ready" && (previous.status !== "ready" || previous.workSessionId !== workSessionId);
    if (!becameReady) {
      return undefined;
    }
    logClientProcess("info", "script_panel.run_ready_flash", { workSessionId });
    setPanelOpen(true);
    setRunComplete(true);
    const timer = window.setTimeout(() => setRunComplete(false), 2800);
    return () => window.clearTimeout(timer);
  }, [previewStatus, workSessionId]);

  const run = useCallback(() => {
    const numberOrNull = (value: string): number | null =>
      value.trim().length > 0 && Number.isFinite(Number(value)) ? Number(value) : null;
    const sharedFields = {
      entrypoint: entrypoint.trim().length > 0 ? entrypoint.trim() : null,
      argv: parseArgvLine(argvLine),
      stdin,
      env: parseEnvLines(envText),
    };
    const params: ScriptRunParams = kind === "r"
      ? {
          ...emptyRRunParams(),
          ...sharedFields,
          graphics: {
            dpi: numberOrNull(dpi),
            format: figureFormat === "" ? null : (figureFormat as RFigureFormat),
            width: numberOrNull(width),
            height: numberOrNull(height),
          },
        }
      : {
          ...emptyPythonRunParams(),
          ...sharedFields,
          matplotlib: {
            dpi: numberOrNull(dpi),
            format: figureFormat === "" ? null : (figureFormat as PythonRunParams["matplotlib"]["format"]),
            style: style.trim().length > 0 ? style.trim() : null,
          },
        };
    logClientProcess("info", "script_panel.run.submitted", {
      workSessionId,
      kind,
      entrypoint: params.entrypoint,
      argvCount: params.argv.length,
      stdinChars: params.stdin.length,
      envKeyCount: Object.keys(params.env).length,
    });
    void onRunPython(params);
  }, [argvLine, dpi, entrypoint, envText, figureFormat, height, kind, onRunPython, stdin, style, width, workSessionId]);

  if (workSession === null || !supportsRunParams || entrypoints.length === 0) {
    return null;
  }

  const isR = kind === "r";
  const formatOptions: readonly string[] = isR ? rFigureFormats : figureFormats;
  const defaultEntrypoint = entrypoints[0]?.file ?? (isR ? "main.R" : "main.py");

  return (
    <details className="python-run-panel" open={panelOpen} onToggle={(event) => setPanelOpen(event.currentTarget.open)}>
      <summary>{isR ? "R run parameters" : "Python run parameters"}</summary>
      <div className="python-run-grid">
        <label className="python-run-field">
          <span>Entrypoint</span>
          <select value={entrypoint} onChange={(event) => setEntrypoint(event.target.value)} disabled={busy}>
            <option value="">Auto-detect ({defaultEntrypoint})</option>
            {entrypoints.map((option) => (
              <option key={option.file} value={option.file}>
                {option.file}
              </option>
            ))}
          </select>
        </label>
        <label className="python-run-field">
          <span>Arguments (argv)</span>
          <input
            type="text"
            value={argvLine}
            onChange={(event) => setArgvLine(event.target.value)}
            placeholder='--samples 1000 --seed 42 --label "run a"'
            disabled={busy}
          />
        </label>
        <label className="python-run-field python-run-field-wide">
          <span>stdin</span>
          <textarea rows={2} value={stdin} onChange={(event) => setStdin(event.target.value)} placeholder="Piped to the script's standard input" disabled={busy} />
        </label>
        <label className="python-run-field python-run-field-wide">
          <span>Environment (KEY=VALUE per line)</span>
          <textarea rows={2} value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder={"SEED=42\nDATA_DIR=./data"} disabled={busy} />
        </label>
        <label className="python-run-field">
          <span>{isR ? "Plot DPI" : "Figure DPI"}</span>
          <input type="number" min={10} step={10} value={dpi} onChange={(event) => setDpi(event.target.value)} placeholder="default" disabled={busy} />
        </label>
        <label className="python-run-field">
          <span>{isR ? "Plot format" : "Figure format"}</span>
          <select value={figureFormat} onChange={(event) => setFigureFormat(event.target.value)} disabled={busy}>
            <option value="">png (default)</option>
            {formatOptions.map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </select>
        </label>
        {isR ? (
          <>
            <label className="python-run-field">
              <span>Plot width (px)</span>
              <input type="number" min={100} step={50} value={width} onChange={(event) => setWidth(event.target.value)} placeholder="1200" disabled={busy} />
            </label>
            <label className="python-run-field">
              <span>Plot height (px)</span>
              <input type="number" min={100} step={50} value={height} onChange={(event) => setHeight(event.target.value)} placeholder="800" disabled={busy} />
            </label>
          </>
        ) : (
          <label className="python-run-field python-run-field-wide">
            <span>matplotlib style</span>
            <input type="text" value={style} onChange={(event) => setStyle(event.target.value)} placeholder="e.g. ggplot, seaborn-v0_8-dark" disabled={busy} />
          </label>
        )}
      </div>
      <div className="python-run-actions">
        <button
          type="button"
          className={`primary small python-run-go${runComplete ? " python-run-go-flash" : ""}`}
          onClick={run}
          disabled={busy}
        >
          Run with parameters
        </button>
      </div>
    </details>
  );
}

export interface ExperimentGpuStatus {
  accelerator: "cpu" | "cuda" | "mps";
  deviceName: string | null;
  allowGpu: boolean;
  warning: string | null;
}

export interface ExperimentManifestSummary {
  kind: string;
  entrypoint: string;
  data?: MlDataContract | null;
}

export interface ExperimentDashboardContext {
  latestRun: ExperimentRunRecord | null;
  manifest: ExperimentManifestSummary | null;
  gpu: ExperimentGpuStatus | null;
  running: boolean;
}

function ExperimentDataPathField({
  id,
  label,
  value,
  onChange,
  placeholder,
  disabled,
  onUploadFiles,
  accept,
  uploadBusy,
  listId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  onUploadFiles?: (files: File[], currentPath: string, opts: { isFolder: boolean }) => Promise<string | null>;
  accept?: string;
  uploadBusy?: boolean;
  listId?: string;
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);
  const onFilesSelected = async (event: React.ChangeEvent<HTMLInputElement>, isFolder: boolean): Promise<void> => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = ""; // allow re-selecting the same file/folder later
    if (files.length === 0 || onUploadFiles === undefined) {
      return;
    }
    const uploadedPath = await onUploadFiles(files, value, { isFolder });
    if (uploadedPath !== null) {
      onChange(uploadedPath);
    }
  };
  return (
    <div className="experiment-field experiment-field-wide">
      <label htmlFor={id}>{label}</label>
      <div className="experiment-path-field">
        <input
          ref={inputRef}
          id={id}
          list={listId ?? "experiment-data-entries"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          disabled={disabled}
        />
        {onUploadFiles !== undefined ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept={accept}
              multiple
              style={{ display: "none" }}
              onChange={(event) => void onFilesSelected(event, false)}
            />
            <input
              ref={dirInputRef}
              type="file"
              multiple
              webkitdirectory=""
              directory=""
              mozdirectory=""
              style={{ display: "none" }}
              onChange={(event) => void onFilesSelected(event, true)}
            />
            <button
              type="button"
              className="ghost small experiment-upload-button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || uploadBusy === true}
              title="Upload file(s) into this workspace's data folder (.zip is stored as-is)"
              aria-label={`Upload files for ${label.toLowerCase()}`}
            >
              {uploadBusy === true ? "…" : "Upload files"}
            </button>
            <button
              type="button"
              className="ghost small experiment-upload-button"
              onClick={() => dirInputRef.current?.click()}
              disabled={disabled || uploadBusy === true}
              title="Upload an entire folder into this workspace's data folder"
              aria-label={`Upload folder for ${label.toLowerCase()}`}
            >
              {uploadBusy === true ? "…" : "Upload folder"}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

interface ExperimentDataEntry {
  path: string;
  kind: "dir" | "file";
}

const DATASET_MODE_LABELS: Record<MlRunConfig["dataset"]["mode"], string> = {
  builtin: "Built-in",
  single_corpus: "Single corpus",
  train_test: "Train + Test",
  train_val_test: "Train + Val + Test",
  jsonl_finetune: "JSONL fine-tune",
  custom: "Custom",
};

function datasetModeLabel(mode: MlRunConfig["dataset"]["mode"]): string {
  return DATASET_MODE_LABELS[mode] ?? mode;
}

function dataPathBasename(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
}

function normalizeDataPath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.length === 0) {
    return null;
  }
  const parts = normalized.split("/").filter(Boolean);
  if (parts[0] !== "data" || parts.some((part) => part === "." || part === "..")) {
    return null;
  }
  return parts.join("/");
}

function uploadDestinationFor(file: File, currentPath: string, dataEntries: ExperimentDataEntry[]): string | null {
  const filename = file.name.trim();
  if (filename.length === 0) {
    return null;
  }
  const matchingFiles = dataEntries.filter((entry) => entry.kind === "file" && dataPathBasename(entry.path) === filename);
  const processedMatch = matchingFiles.find((entry) => entry.path.startsWith("data/processed/"));
  if (processedMatch !== undefined) {
    return processedMatch.path;
  }
  if (matchingFiles.length === 1) {
    return matchingFiles[0].path;
  }
  const normalizedCurrent = normalizeDataPath(currentPath);
  if (normalizedCurrent === null) {
    return null;
  }
  const parts = normalizedCurrent.split("/");
  const leaf = parts.at(-1) ?? "";
  if (leaf === filename) {
    return normalizedCurrent;
  }
  if (leaf.includes(".")) {
    parts.pop();
  }
  parts.push(filename);
  return parts.join("/");
}

const COMMON_DATA_ACCEPT = ".zip,.txt,.csv,.tsv,.jsonl,.json";

function widenAccept(base: string | null | undefined): string {
  const out = new Set<string>();
  const add = (value: string): void => {
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0)
      .forEach((part) => out.add(part));
  };
  if (typeof base === "string") {
    add(base);
  }
  add(COMMON_DATA_ACCEPT);
  return [...out].join(",");
}

function fileRelativePath(file: File): string {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return typeof rel === "string" ? rel : "";
}

function commonTopFolder(files: File[]): string | null {
  let top: string | null = null;
  for (const file of files) {
    const parts = fileRelativePath(file).replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts.length < 2) {
      continue; // not a folder-structured entry
    }
    if (top === null) {
      top = parts[0];
    } else if (top !== parts[0]) {
      return null;
    }
  }
  return top;
}

function planStructuredUpload(
  files: File[],
  currentPath: string,
): { destinationDir: string | null; relativePaths: Array<string | null> } {
  const folder = commonTopFolder(files);
  if (folder !== null) {
    const dir = `data/${folder.replace(/[^A-Za-z0-9._-]/g, "_")}`;
    const relativePaths = files.map((file) => {
      const parts = fileRelativePath(file).replace(/\\/g, "/").split("/").filter(Boolean);
      const stripped = parts.slice(1).join("/"); // drop the redundant top folder
      return stripped.length > 0 ? stripped : null; // null => backend uses the file's basename
    });
    return { destinationDir: dir, relativePaths };
  }
  const normalized = normalizeDataPath(currentPath);
  let destinationDir: string | null = null;
  if (normalized !== null) {
    const parts = normalized.split("/");
    const leaf = parts.at(-1) ?? "";
    destinationDir = leaf.includes(".") && parts.length > 1 ? parts.slice(0, -1).join("/") : normalized;
  }
  const relativePaths = files.map((file) => {
    const rel = fileRelativePath(file);
    return rel.length > 0 ? rel : null;
  });
  return { destinationDir, relativePaths };
}

async function postDataUpload(
  workSessionId: string,
  files: File[],
  opts: { isFolder: boolean; currentPath: string; dataEntries: ExperimentDataEntry[] },
): Promise<{ path: string } | { error: string }> {
  const form = new FormData();
  const structured = opts.isFolder || files.length > 1 || files.some((file) => fileRelativePath(file).length > 0);
  if (!structured) {
    form.append("file", files[0]);
    const destinationPath = uploadDestinationFor(files[0], opts.currentPath, opts.dataEntries);
    if (destinationPath !== null) {
      form.append("destinationPath", destinationPath);
    }
  } else {
    const { destinationDir, relativePaths } = planStructuredUpload(files, opts.currentPath);
    files.forEach((file) => form.append("file", file));
    if (relativePaths.some((rel) => rel !== null)) {
      form.append("relativePaths", JSON.stringify(relativePaths.map((rel) => rel ?? "")));
    }
    if (destinationDir !== null) {
      form.append("destinationDir", destinationDir);
    }
  }
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 60000);
  let response: Response;
  try {
    response = await fetch(`/api/work-sessions/${workSessionId}/data/upload`, { method: "POST", body: form, signal: controller.signal });
  } catch (error) {
    return {
      error: controller.signal.aborted
        ? "Upload timed out — the server may be busy (e.g. an agent/experiment run is active). Try again when the session is idle."
        : `Upload failed: ${error instanceof Error ? error.message : "network error"}.`,
    };
  } finally {
    window.clearTimeout(timeout);
  }
  const body = (await response.json().catch(() => null)) as { ok?: boolean; data?: { path?: string }; error?: string } | null;
  if (!response.ok || body?.ok === false || typeof body?.data?.path !== "string") {
    return { error: body?.error ?? `Upload failed (HTTP ${response.status}).` };
  }
  return { path: body.data.path };
}

interface ExperimentMetaResponse {
  ok: boolean;
  data?: {
    enabled: boolean;
    manifest: ExperimentManifestSummary | null;
    runConfig: MlRunConfig;
    latestRun: ExperimentRunRecord | null;
    gpu?: ExperimentGpuStatus | null;
    dataEntries?: ExperimentDataEntry[];
  };
  error?: string;
}

export function ExperimentPanel({
  workSession,
  busy,
  renderDashboard,
}: {
  workSession: WorkSessionRecord | null;
  busy: boolean;
  renderDashboard?: (ctx: ExperimentDashboardContext) => React.ReactNode;
}): React.ReactElement | null {
  const workSessionId = workSession?.id ?? null;
  const fieldIdBase = useId();
  const [enabled, setEnabled] = useState(false);
  const [manifest, setManifest] = useState<ExperimentManifestSummary | null>(null);
  const [latestRun, setLatestRun] = useState<ExperimentRunRecord | null>(null);
  const [gpu, setGpu] = useState<ExperimentGpuStatus | null>(null);
  const [dataEntries, setDataEntries] = useState<ExperimentDataEntry[]>([]);
  const [datasetMode, setDatasetMode] = useState<MlRunConfig["dataset"]["mode"]>("builtin");
  const [datasetFormat, setDatasetFormat] = useState<MlRunConfig["dataset"]["format"]>("auto");
  const [datasetTrain, setDatasetTrain] = useState("");
  const [datasetVal, setDatasetVal] = useState("");
  const [datasetTest, setDatasetTest] = useState("");
  const [datasetCorpus, setDatasetCorpus] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [seed, setSeed] = useState("42");
  const [subset, setSubset] = useState("");
  const [precision, setPrecision] = useState<MlRunConfig["precision"]>("fp32");
  const [device, setDevice] = useState<MlRunConfig["device"]>("auto");
  const [greedy, setGreedy] = useState(true);
  const [maxNewTokens, setMaxNewTokens] = useState("");
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [maxSteps, setMaxSteps] = useState("");
  const [epochs, setEpochs] = useState("");
  const [batchSize, setBatchSize] = useState("");
  const [lr, setLr] = useState("");
  const [blockSize, setBlockSize] = useState("");
  const [embedDim, setEmbedDim] = useState("");
  const [hiddenDim, setHiddenDim] = useState("");
  const [numLayers, setNumLayers] = useState("");
  const [extraText, setExtraText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const applyPreset = useCallback((preset: "quick" | "balanced" | "quality"): void => {
    const values: Record<typeof preset, { hidden: string; embed: string; block: string; layers: string; steps: string; batch: string }> = {
      quick: { hidden: "96", embed: "48", block: "64", layers: "1", steps: "500", batch: "16" },
      balanced: { hidden: "192", embed: "64", block: "96", layers: "2", steps: "3000", batch: "32" },
      quality: { hidden: "256", embed: "128", block: "128", layers: "2", steps: "6000", batch: "64" },
    };
    const preset_ = values[preset];
    setHiddenDim(preset_.hidden);
    setEmbedDim(preset_.embed);
    setBlockSize(preset_.block);
    setNumLayers(preset_.layers);
    setMaxSteps(preset_.steps);
    setBatchSize(preset_.batch);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (workSessionId === null) {
      setEnabled(false);
      return;
    }
    try {
      const response = await fetch(`/api/work-sessions/${workSessionId}/experiment`, { method: "GET" });
      const body = (await response.json()) as ExperimentMetaResponse;
      if (!body.ok || body.data === undefined) {
        setEnabled(false);
        return;
      }
      setEnabled(body.data.enabled);
      setManifest(body.data.manifest);
      setLatestRun(body.data.latestRun);
      setGpu(body.data.gpu ?? null);
      setDataEntries(body.data.dataEntries ?? []);
      const ds = body.data.runConfig.dataset ?? null;
      if (ds !== null) {
        setDatasetMode(ds.mode ?? "builtin");
        setDatasetFormat(ds.format ?? "auto");
        setDatasetTrain(ds.trainPath ?? "");
        setDatasetVal(ds.valPath ?? "");
        setDatasetTest(ds.testPath ?? "");
        setDatasetCorpus(ds.corpusPath ?? "");
      }
      const contract = body.data.manifest?.data ?? null;
      const untouched = ds === null
        || ((ds.mode ?? "builtin") === "builtin" && !ds.trainPath && !ds.valPath && !ds.testPath && !ds.corpusPath);
      if (contract !== null && untouched && contract.recommendedMode !== "builtin") {
        setDatasetMode(contract.recommendedMode);
        setDatasetFormat(contract.format);
      }
      if (body.data.runConfig.seed !== undefined && body.data.runConfig.seed !== null) {
        setSeed(String(body.data.runConfig.seed));
      }
      if (body.data.runConfig.subsetLimit !== null && body.data.runConfig.subsetLimit !== undefined) {
        setSubset(String(body.data.runConfig.subsetLimit));
      }
      if (body.data.runConfig.precision !== undefined) {
        setPrecision(body.data.runConfig.precision);
      }
      if (body.data.runConfig.device !== undefined && body.data.runConfig.device !== null) {
        setDevice(body.data.runConfig.device);
      }
      if (body.data.runConfig.decode !== undefined && body.data.runConfig.decode !== null) {
        setGreedy(body.data.runConfig.decode.greedy !== false);
        if (body.data.runConfig.decode.maxNewTokens !== null && body.data.runConfig.decode.maxNewTokens !== undefined) {
          setMaxNewTokens(String(body.data.runConfig.decode.maxNewTokens));
        }
        if (body.data.runConfig.decode.temperature !== null && body.data.runConfig.decode.temperature !== undefined) {
          setTemperature(String(body.data.runConfig.decode.temperature));
        }
        if (body.data.runConfig.decode.topP !== null && body.data.runConfig.decode.topP !== undefined) {
          setTopP(String(body.data.runConfig.decode.topP));
        }
      }
      if (body.data.runConfig.maxSteps !== null && body.data.runConfig.maxSteps !== undefined) {
        setMaxSteps(String(body.data.runConfig.maxSteps));
      }
      if (body.data.runConfig.epochs !== null && body.data.runConfig.epochs !== undefined) {
        setEpochs(String(body.data.runConfig.epochs));
      }
      if (body.data.runConfig.batchSize !== null && body.data.runConfig.batchSize !== undefined) {
        setBatchSize(String(body.data.runConfig.batchSize));
      }
      if (body.data.runConfig.lr !== null && body.data.runConfig.lr !== undefined) {
        setLr(String(body.data.runConfig.lr));
      }
      if (body.data.runConfig.blockSize !== null && body.data.runConfig.blockSize !== undefined) {
        setBlockSize(String(body.data.runConfig.blockSize));
      }
      if (body.data.runConfig.embedDim !== null && body.data.runConfig.embedDim !== undefined) {
        setEmbedDim(String(body.data.runConfig.embedDim));
      }
      if (body.data.runConfig.hiddenDim !== null && body.data.runConfig.hiddenDim !== undefined) {
        setHiddenDim(String(body.data.runConfig.hiddenDim));
      }
      if (body.data.runConfig.numLayers !== null && body.data.runConfig.numLayers !== undefined) {
        setNumLayers(String(body.data.runConfig.numLayers));
      }
      if (body.data.runConfig.extra !== undefined && body.data.runConfig.extra !== null) {
        setExtraText(envToLines(body.data.runConfig.extra));
      }
    } catch (error) {
      logClientProcess("warn", "experiment_panel.load.failed", {
        workSessionId,
        message: error instanceof Error ? error.message : "unknown experiment metadata error",
      });
    }
  }, [workSessionId]);

  const refreshStatus = useCallback(async (): Promise<void> => {
    if (workSessionId === null) {
      return;
    }
    try {
      const response = await fetch(`/api/work-sessions/${workSessionId}/experiment`, { method: "GET" });
      const body = (await response.json()) as ExperimentMetaResponse;
      if (body.ok && body.data !== undefined) {
        setEnabled(body.data.enabled);
        setManifest(body.data.manifest);
        setLatestRun(body.data.latestRun);
        setGpu(body.data.gpu ?? null);
        setDataEntries(body.data.dataEntries ?? []);
      }
    } catch {
    }
  }, [workSessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = latestRun?.status === "running" || latestRun?.status === "queued";
  useEffect(() => {
    if (!running && !busy) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [running, busy, refreshStatus]);

  const submit = useCallback(
    async (action: "run-smoke" | "run-short" | "run-full" | "abort"): Promise<void> => {
      if (workSessionId === null) {
        return;
      }
      setSubmitting(true);
      setSubmitError(null);
      try {
        const numOrNull = (value: string): number | null =>
          value.trim().length > 0 && Number.isFinite(Number(value)) ? Number(value) : null;
        const runConfig =
          action === "abort"
            ? undefined
            : {
                seed: Number.isFinite(Number(seed)) ? Number(seed) : 42,
                subsetLimit: numOrNull(subset),
                precision,
                device,
                maxSteps: numOrNull(maxSteps),
                epochs: numOrNull(epochs),
                batchSize: numOrNull(batchSize),
                lr: numOrNull(lr),
                blockSize: numOrNull(blockSize),
                embedDim: numOrNull(embedDim),
                hiddenDim: numOrNull(hiddenDim),
                numLayers: numOrNull(numLayers),
                extra: parseEnvLines(extraText),
                decode: {
                  greedy,
                  maxNewTokens: numOrNull(maxNewTokens),
                  temperature: numOrNull(temperature),
                  topP: numOrNull(topP),
                },
                dataset: {
                  mode: datasetMode,
                  format: datasetFormat,
                  trainPath: datasetTrain.trim().length > 0 ? datasetTrain.trim() : null,
                  valPath: datasetVal.trim().length > 0 ? datasetVal.trim() : null,
                  testPath: datasetTest.trim().length > 0 ? datasetTest.trim() : null,
                  corpusPath: datasetCorpus.trim().length > 0 ? datasetCorpus.trim() : null,
                },
              };
        logClientProcess("info", "experiment_panel.submit", { workSessionId, action });
        const response = await fetch(`/api/work-sessions/${workSessionId}/experiment`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(runConfig === undefined ? { action } : { action, runConfig }),
        });
        const responseBody = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || responseBody?.ok === false) {
          const message = responseBody?.error ?? `Experiment request failed (HTTP ${response.status}).`;
          setSubmitError(message);
          logClientProcess("warn", "experiment_panel.submit.rejected", { workSessionId, action, status: response.status, message });
        }
        await load();
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown experiment submit error";
        setSubmitError(message);
        logClientProcess("warn", "experiment_panel.submit.failed", { workSessionId, action, message });
      } finally {
        setSubmitting(false);
      }
    },
    [
      workSessionId, seed, subset, precision, device, greedy, maxNewTokens, temperature, topP,
      maxSteps, epochs, batchSize, lr, blockSize, embedDim, hiddenDim, numLayers, extraText,
      datasetMode, datasetFormat, datasetTrain, datasetVal, datasetTest, datasetCorpus, load,
    ],
  );

  const uploadCorpus = useCallback(
    async (files: File[], currentPath: string, opts: { isFolder: boolean }): Promise<string | null> => {
      if (workSessionId === null || files.length === 0) {
        return null;
      }
      setUploadBusy(true);
      setSubmitError(null);
      try {
        const result = await postDataUpload(workSessionId, files, { ...opts, currentPath, dataEntries });
        if ("error" in result) {
          setSubmitError(result.error);
          logClientProcess("warn", "experiment_panel.upload.rejected", { workSessionId, message: result.error });
          return null;
        }
        logClientProcess("info", "experiment_panel.upload", { workSessionId, path: result.path });
        await refreshStatus();
        return result.path;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown corpus upload error";
        setSubmitError(message);
        logClientProcess("warn", "experiment_panel.upload.failed", { workSessionId, message });
        return null;
      } finally {
        setUploadBusy(false);
      }
    },
    [workSessionId, dataEntries, refreshStatus],
  );

  if (workSession === null || !enabled) {
    return null;
  }

  const disabled = busy || submitting || running;
  const primary = latestRun?.primaryMetric ?? null;

  return (
    <details className="experiment-panel" open>
      <summary>Experiment runtime</summary>
      {renderDashboard !== undefined ? renderDashboard({ latestRun, manifest, gpu, running }) : null}
      <div className="experiment-meta" hidden={renderDashboard !== undefined}>
        <span className="muted">{manifest !== null ? `${manifest.kind} · ${manifest.entrypoint}` : "ML workspace"}</span>
        {gpu !== null ? (
          gpu.accelerator === "cuda" ? (
            <span className="chip experiment-gpu-ready">GPU: {gpu.deviceName ?? "CUDA"} ready</span>
          ) : gpu.warning !== null ? (
            <span className="chip experiment-gpu-warn" title={gpu.warning}>GPU disabled (ML_ALLOW_GPU=false) · CPU only</span>
          ) : (
            <span className="chip chip-muted">CPU</span>
          )
        ) : null}
      </div>
      <div className="experiment-presets">
        <span className="muted experiment-presets-label">Neural-model presets:</span>
        <button type="button" className="ghost small" onClick={() => applyPreset("quick")} disabled={disabled} title="hidden 96 · block 64 · 1 layer · 500 steps — seconds">Quick</button>
        <button type="button" className="ghost small" onClick={() => applyPreset("balanced")} disabled={disabled} title="hidden 192 · block 96 · 2 layers · 3000 steps — minutes on GPU">Balanced</button>
        <button type="button" className="ghost small" onClick={() => applyPreset("quality")} disabled={disabled} title="hidden 256 · block 128 · 2 layers · 6000 steps">Quality</button>
      </div>
      <div className="experiment-grid">
        <div className="experiment-subhead">
          Dataset &amp; training mode
          <span className="muted experiment-subhead-note">{dataEntries.length > 0 ? `${dataEntries.length} under data/` : "place data under data/"}</span>
          <button type="button" className="ghost small experiment-refresh" onClick={() => void load()} disabled={disabled} title="Re-scan data/ for folders and files">↻</button>
        </div>
        {manifest?.data != null && manifest.data.guidance.length > 0 ? (
          <div className="experiment-field experiment-field-wide experiment-data-guidance">
            <span className="muted">
              <strong>How to train this model:</strong> {manifest.data.guidance}{" "}
              <em>Recommended: {datasetModeLabel(manifest.data.recommendedMode)} · {manifest.data.format}.</em>{" "}
              All data preparation runs inside training — you only provide the data.
            </span>
          </div>
        ) : null}
        <label className="experiment-field">
          <span>Training mode</span>
          <select value={datasetMode} onChange={(event) => setDatasetMode(event.target.value as MlRunConfig["dataset"]["mode"])} disabled={disabled}>
            <option value="builtin">Built-in (scaffold default)</option>
            <option value="single_corpus">Single corpus</option>
            <option value="train_test">Train + Test</option>
            <option value="train_val_test">Train + Val + Test</option>
            <option value="jsonl_finetune">JSONL fine-tune</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label className="experiment-field">
          <span>Data format</span>
          <select value={datasetFormat} onChange={(event) => setDatasetFormat(event.target.value as MlRunConfig["dataset"]["format"])} disabled={disabled}>
            <option value="auto">Auto</option>
            <option value="text">Text</option>
            <option value="jsonl">JSONL</option>
            <option value="csv">CSV</option>
            <option value="image_folder">Image folder</option>
            <option value="other">Other</option>
          </select>
        </label>
        {datasetMode === "single_corpus" || datasetMode === "jsonl_finetune" || datasetMode === "custom" ? (
          <ExperimentDataPathField
            id={safeFieldId(fieldIdBase, "dataset-corpus")}
            label={datasetMode === "jsonl_finetune" ? "Fine-tune JSONL (file)" : "Corpus (file or folder)"}
            value={datasetCorpus}
            onChange={setDatasetCorpus}
            placeholder="data/corpus.txt"
            disabled={disabled}
            onUploadFiles={uploadCorpus}
            accept={widenAccept(manifest?.data?.accept)}
            uploadBusy={uploadBusy}
          />
        ) : null}
        {datasetMode === "train_test" || datasetMode === "train_val_test" || datasetMode === "custom" ? (
          <ExperimentDataPathField
            id={safeFieldId(fieldIdBase, "dataset-train")}
            label="Training data (folder or file)"
            value={datasetTrain}
            onChange={setDatasetTrain}
            placeholder="data/train"
            disabled={disabled}
            onUploadFiles={uploadCorpus}
            accept={widenAccept(manifest?.data?.accept)}
            uploadBusy={uploadBusy}
          />
        ) : null}
        {datasetMode === "train_val_test" || datasetMode === "custom" ? (
          <ExperimentDataPathField
            id={safeFieldId(fieldIdBase, "dataset-val")}
            label="Validation data (folder or file)"
            value={datasetVal}
            onChange={setDatasetVal}
            placeholder="data/val"
            disabled={disabled}
            onUploadFiles={uploadCorpus}
            accept={widenAccept(manifest?.data?.accept)}
            uploadBusy={uploadBusy}
          />
        ) : null}
        {datasetMode === "train_test" || datasetMode === "train_val_test" || datasetMode === "custom" ? (
          <ExperimentDataPathField
            id={safeFieldId(fieldIdBase, "dataset-test")}
            label="Test data (folder or file)"
            value={datasetTest}
            onChange={setDatasetTest}
            placeholder="data/test"
            disabled={disabled}
            onUploadFiles={uploadCorpus}
            accept={widenAccept(manifest?.data?.accept)}
            uploadBusy={uploadBusy}
          />
        ) : null}
        {datasetMode === "builtin" ? (
          <div className="experiment-field experiment-field-wide">
            <span className="muted">Using the scaffold&apos;s built-in dataset. Pick a mode above to train on your own data placed under <code>data/</code>.</span>
          </div>
        ) : null}
        <datalist id="experiment-data-entries">
          {dataEntries.map((entry) => (
            <option key={entry.path} value={entry.path}>{`${entry.path} (${entry.kind})`}</option>
          ))}
        </datalist>
        <div className="experiment-subhead">Run</div>
        <label className="experiment-field">
          <span>Seed</span>
          <input type="number" value={seed} onChange={(event) => setSeed(event.target.value)} disabled={disabled} />
        </label>
        <label className="experiment-field">
          <span>Device</span>
          <select value={device} onChange={(event) => setDevice(event.target.value as MlRunConfig["device"])} disabled={disabled}>
            <option value="auto">auto</option>
            <option value="cpu">cpu</option>
            <option value="cuda">cuda</option>
            <option value="mps">mps</option>
          </select>
        </label>
        <label className="experiment-field">
          <span>Precision</span>
          <select value={precision} onChange={(event) => setPrecision(event.target.value as MlRunConfig["precision"])} disabled={disabled}>
            <option value="fp32">fp32</option>
            <option value="fp16">fp16</option>
            <option value="bf16">bf16</option>
            <option value="int8">int8</option>
            <option value="int4">int4</option>
          </select>
        </label>
        <label className="experiment-field">
          <span>Subset limit</span>
          <input type="number" min={0} value={subset} onChange={(event) => setSubset(event.target.value)} placeholder="full" disabled={disabled} />
        </label>
        <label className="experiment-field">
          <span>Epochs</span>
          <input type="number" min={1} value={epochs} onChange={(event) => setEpochs(event.target.value)} placeholder="script default" disabled={disabled} />
        </label>
        <label className="experiment-field">
          <span>Max steps</span>
          <input type="number" min={1} value={maxSteps} onChange={(event) => setMaxSteps(event.target.value)} placeholder="script default" disabled={disabled} />
        </label>
        <label className="experiment-field">
          <span>Batch size</span>
          <input type="number" min={1} value={batchSize} onChange={(event) => setBatchSize(event.target.value)} placeholder="script default" disabled={disabled} />
        </label>
        <label className="experiment-field">
          <span>Learning rate</span>
          <input type="number" min={0} step="any" value={lr} onChange={(event) => setLr(event.target.value)} placeholder="script default" disabled={disabled} />
        </label>

        <div className="experiment-subhead">Model architecture <span className="muted">(neural models)</span></div>
        <label className="experiment-field">
          <span>Hidden dim</span>
          <input type="number" min={1} value={hiddenDim} onChange={(event) => setHiddenDim(event.target.value)} placeholder="script default" disabled={disabled} />
        </label>
        <label className="experiment-field">
          <span>Embed dim</span>
          <input type="number" min={1} value={embedDim} onChange={(event) => setEmbedDim(event.target.value)} placeholder="script default" disabled={disabled} />
        </label>
        <label className="experiment-field">
          <span>Block size</span>
          <input type="number" min={1} value={blockSize} onChange={(event) => setBlockSize(event.target.value)} placeholder="script default" disabled={disabled} />
        </label>
        <label className="experiment-field">
          <span>Num layers</span>
          <input type="number" min={1} value={numLayers} onChange={(event) => setNumLayers(event.target.value)} placeholder="script default" disabled={disabled} />
        </label>

        <div className="experiment-subhead">Decode</div>
        <label className="experiment-field">
          <span>Temperature</span>
          <input type="number" min={0} step="any" value={temperature} onChange={(event) => setTemperature(event.target.value)} placeholder="default" disabled={disabled} />
        </label>
        <label className="experiment-field">
          <span>Top-p</span>
          <input type="number" min={0} max={1} step="any" value={topP} onChange={(event) => setTopP(event.target.value)} placeholder="default" disabled={disabled} />
        </label>
        <label className="experiment-field">
          <span>Max new tokens</span>
          <input type="number" min={0} value={maxNewTokens} onChange={(event) => setMaxNewTokens(event.target.value)} placeholder="default" disabled={disabled} />
        </label>
        <label className="experiment-field experiment-field-checkbox">
          <span>Greedy decode</span>
          <input type="checkbox" checked={greedy} onChange={(event) => setGreedy(event.target.checked)} disabled={disabled} />
        </label>
        <label className="experiment-field experiment-field-wide">
          <span>Extra parameters (key=value per line)</span>
          <textarea value={extraText} onChange={(event) => setExtraText(event.target.value)} placeholder="eval_steps=200&#10;corpus_path=data/tinyshakespeare.txt" disabled={disabled} rows={3} />
        </label>
      </div>
      <div className="experiment-actions">
        <button type="button" className="ghost small" onClick={() => void submit("run-smoke")} disabled={disabled}>Run smoke</button>
        <button type="button" className="primary small" onClick={() => void submit("run-short")} disabled={disabled}>Run short</button>
        <button type="button" className="ghost small" onClick={() => void submit("run-full")} disabled={disabled}>Run full</button>
        <button type="button" className="danger-text small" onClick={() => void submit("abort")} disabled={busy || submitting || !running}>Abort</button>
      </div>
      {submitError !== null ? (
        <p className="muted experiment-failure">{submitError}</p>
      ) : null}
      <CalibrationPanel workSession={workSession} busy={busy} />
      {latestRun !== null ? (
        <div className="experiment-status" hidden={renderDashboard !== undefined}>
          <span className={`chip chip-${experimentRunTone(latestRun.status)} experiment-status-${latestRun.status}`}>{latestRun.regime} · {latestRun.status}</span>
          {latestRun.deviceMismatch === true ? (
            <span className="chip experiment-device-mismatch">GPU intended · ran on {latestRun.effectiveDevice ?? "cpu"}</span>
          ) : null}
          {primary !== null ? (
            <span className="experiment-primary">{primary.name}: <strong>{primary.value.toFixed(4)}</strong> ({primary.split})</span>
          ) : null}
          {latestRun.summary.length > 0 ? <p className="muted experiment-summary">{latestRun.summary}</p> : null}
          {latestRun.status === "failed" && latestRun.failureSummary !== null && latestRun.failureSummary.length > 0 ? (
            <p className="muted experiment-failure">{latestRun.failureSummary.slice(0, 400)}</p>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

interface CalibrationStatusData {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  calibration: { entrypoint: string } | null;
  paths: {
    checkpoint: string;
    calibrationData: string | null;
    oodValidationData: string | null;
    outputCheckpoint: string;
    report: string;
  } | null;
  bestCheckpointExists: boolean;
  calibrationDataExists: boolean;
  oodValidationExists: boolean;
  latestTrainingRun: ExperimentRunRecord | null;
  latestCalibrationRun: ExperimentRunRecord | null;
  active: boolean;
  dataEntries: ExperimentDataEntry[];
}

interface CalibrationMetaResponse {
  ok: boolean;
  data?: CalibrationStatusData;
  error?: string;
}

function CalibrationPanel({
  workSession,
  busy,
}: {
  workSession: WorkSessionRecord | null;
  busy: boolean;
}): React.ReactElement | null {
  const fieldIdBase = useId();
  const workSessionId = workSession?.id ?? null;
  const [status, setStatus] = useState<CalibrationStatusData | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [restartInference, setRestartInference] = useState(true);
  const [calibrationFile, setCalibrationFile] = useState("");
  const [oodFile, setOodFile] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const seededRef = useRef(false);

  useEffect(() => {
    seededRef.current = false;
    setCalibrationFile("");
    setOodFile("");
  }, [workSessionId]);

  const load = useCallback(async (): Promise<void> => {
    if (workSessionId === null) {
      setStatus(null);
      return;
    }
    try {
      const response = await fetch(`/api/work-sessions/${workSessionId}/calibration`, { method: "GET" });
      const body = (await response.json()) as CalibrationMetaResponse;
      const data = body.ok && body.data !== undefined ? body.data : null;
      setStatus(data);
      if (data !== null && data.paths !== null && !seededRef.current) {
        seededRef.current = true;
        setCalibrationFile(data.paths.calibrationData ?? "");
        setOodFile(data.paths.oodValidationData ?? "");
      }
    } catch (error) {
      logClientProcess("warn", "calibration_panel.load.failed", {
        workSessionId,
        message: error instanceof Error ? error.message : "unknown calibration metadata error",
      });
    }
  }, [workSessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const calibrationRun = status?.latestCalibrationRun ?? null;
  const calibrating = status?.active === true
    || calibrationRun?.status === "running"
    || calibrationRun?.status === "queued";

  useEffect(() => {
    if (!calibrating && !busy) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void load();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [calibrating, busy, load]);

  const uploadFile = useCallback(
    async (files: File[], currentPath: string, opts: { isFolder: boolean }): Promise<string | null> => {
      if (workSessionId === null || files.length === 0) {
        return null;
      }
      setUploadBusy(true);
      setSubmitError(null);
      try {
        const result = await postDataUpload(workSessionId, files, { ...opts, currentPath, dataEntries: status?.dataEntries ?? [] });
        if ("error" in result) {
          setSubmitError(result.error);
          return null;
        }
        await load();
        return result.path;
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "unknown upload error");
        return null;
      } finally {
        setUploadBusy(false);
      }
    },
    [workSessionId, status, load],
  );

  const submit = useCallback(
    async (action: "run-calibration" | "abort-calibration"): Promise<void> => {
      if (workSessionId === null) {
        return;
      }
      setSubmitting(true);
      setSubmitError(null);
      try {
        const calibrationData = calibrationFile.trim();
        const oodValidationData = oodFile.trim();
        const response = await fetch(`/api/work-sessions/${workSessionId}/calibration`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            action === "run-calibration"
              ? {
                  action,
                  autoRestartInference: restartInference,
                  ...(calibrationData.length > 0 ? { calibrationData } : {}),
                  ...(oodValidationData.length > 0 ? { oodValidationData } : {}),
                }
              : { action },
          ),
        });
        const body = (await response.json()) as { ok: boolean; error?: string };
        if (!body.ok) {
          setSubmitError(body.error ?? "Calibration request failed.");
        }
        await load();
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : "Calibration request failed.");
      } finally {
        setSubmitting(false);
      }
    },
    [workSessionId, restartInference, calibrationFile, oodFile, load],
  );

  if (status === null || !status.enabled) {
    return null;
  }

  const primary = calibrationRun?.primaryMetric ?? null;
  const controlsDisabled = busy || submitting || calibrating === true;
  const canCalibrate = !controlsDisabled && status.bestCheckpointExists;

  return (
    <div className="calibration-panel">
      <div className="calibration-head">
        <strong>Post-training calibration</strong>
        {calibrationRun !== null ? (
          <span className={`chip chip-${experimentRunTone(calibrationRun.status)} calibration-status-${calibrationRun.status}`}>
            {calibrating ? "calibrating" : calibrationRun.status === "succeeded" ? "calibrated" : calibrationRun.status}
          </span>
        ) : (
          <span className="chip chip-muted">uncalibrated</span>
        )}
      </div>

      {calibrating ? (
        <>
          <p className="muted">Calibrating best model… freezing the checkpoint, fitting post-hoc calibration, and writing the serving checkpoint. Model weights are not changed.</p>
          <div className="experiment-actions">
            <button type="button" className="danger-text small" onClick={() => void submit("abort-calibration")} disabled={busy || submitting}>Abort calibration</button>
          </div>
        </>
      ) : (
        <>
          {status.paths !== null ? (
            <div className="calibration-paths muted">
              <div>Best checkpoint: <code>{status.paths.checkpoint}</code>{status.bestCheckpointExists ? "" : " (missing)"}</div>
              <div>Serving checkpoint: <code>{status.paths.outputCheckpoint}</code></div>
            </div>
          ) : null}

          <ExperimentDataPathField
            id={`${fieldIdBase}-calibration-file`}
            label="Calibration file"
            value={calibrationFile}
            onChange={setCalibrationFile}
            placeholder="data/processed/fluorescence_calibration.jsonl"
            disabled={controlsDisabled}
            onUploadFiles={uploadFile}
            uploadBusy={uploadBusy}
            accept={widenAccept(".jsonl,.json,.ndjson")}
            listId="calibration-data-entries"
          />
          <ExperimentDataPathField
            id={`${fieldIdBase}-ood-file`}
            label="OOD validation file (optional)"
            value={oodFile}
            onChange={setOodFile}
            placeholder="data/processed/non_fluorescent_uniprot_ood_validation.jsonl"
            disabled={controlsDisabled}
            onUploadFiles={uploadFile}
            uploadBusy={uploadBusy}
            accept={widenAccept(".jsonl,.json,.ndjson")}
            listId="calibration-data-entries"
          />
          <datalist id="calibration-data-entries">
            {status.dataEntries.map((entry) => (
              <option key={entry.path} value={entry.path} />
            ))}
          </datalist>

          {!status.available && status.reason !== null ? (
            <p className="muted">{status.reason}</p>
          ) : null}

          <label className="calibration-option">
            <input type="checkbox" checked={restartInference} onChange={(event) => setRestartInference(event.target.checked)} disabled={controlsDisabled} />
            <span>Restart inference after calibration</span>
          </label>

          <div className="experiment-actions">
            <button type="button" className="primary small" onClick={() => void submit("run-calibration")} disabled={!canCalibrate}>
              Calibrate best model
            </button>
          </div>

          {calibrationRun !== null && calibrationRun.status === "succeeded" ? (
            <div className="calibration-result">
              <p>Calibrated serving checkpoint ready. Switch to the Inference tab to test the calibrated model.</p>
              {primary !== null ? (
                <span className="experiment-primary">{primary.name}: <strong>{primary.value.toFixed(4)}</strong> ({primary.split})</span>
              ) : null}
              {calibrationRun.summary.length > 0 ? <p className="muted">{calibrationRun.summary}</p> : null}
            </div>
          ) : null}

          {calibrationRun !== null && calibrationRun.status === "failed" ? (
            <div className="calibration-result">
              <p className="muted experiment-failure">Calibration failed. The previous best checkpoint was not modified; inference remains on the previous serving checkpoint.</p>
              {calibrationRun.failureSummary !== null && calibrationRun.failureSummary.length > 0 ? (
                <p className="muted experiment-failure">{calibrationRun.failureSummary.slice(0, 400)}</p>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      {submitError !== null ? <p className="muted experiment-failure">{submitError}</p> : null}
    </div>
  );
}

interface InferenceMetaResponse {
  ok: boolean;
  data?: {
    enabled: boolean;
    available: boolean;
    contract: InferenceContract | null;
    worker: InferenceWorkerInfo;
  };
  error?: string;
}

interface MaterializedFile {
  kind: "file";
  name: string;
  mime: string;
  url: string;
}

interface LabelScore {
  label: string;
  score: number;
}

function isMaterializedFile(value: unknown): value is MaterializedFile {
  return (
    typeof value === "object" && value !== null
    && (value as { kind?: unknown }).kind === "file"
    && typeof (value as { url?: unknown }).url === "string"
  );
}

function findFileDescriptor(value: unknown, depth = 0): MaterializedFile | null {
  if (depth > 8 || value === null || typeof value !== "object") {
    return null;
  }
  if (isMaterializedFile(value)) {
    return value;
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    const found = findFileDescriptor(entry, depth + 1);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function findLabelArray(value: unknown, depth = 0): LabelScore[] | null {
  if (depth > 8 || value === null || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    const labels = value.filter(
      (entry): entry is { label: unknown; score?: unknown } =>
        typeof entry === "object" && entry !== null && typeof (entry as { label?: unknown }).label === "string",
    );
    if (labels.length > 0 && labels.length === value.length) {
      return labels.map((entry) => ({
        label: String(entry.label),
        score: typeof entry.score === "number" && Number.isFinite(entry.score) ? entry.score : 0,
      }));
    }
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    const found = findLabelArray(entry, depth + 1);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function findFirstNumber(value: unknown, depth = 0): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (depth > 8 || value === null || typeof value !== "object") {
    return null;
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    const found = findFirstNumber(entry, depth + 1);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function findFirstString(value: unknown, depth = 0): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (depth > 8 || value === null || typeof value !== "object") {
    return null;
  }
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const entry of entries) {
    const found = findFirstString(entry, depth + 1);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function formatScalar(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return Math.abs(value) >= 1000 || Math.abs(value) < 0.001 ? value.toExponential(3) : value.toFixed(4);
}

function acceptForModality(spec: InferenceInputSpec): string | undefined {
  if (spec.accept !== null) {
    return spec.accept;
  }
  switch (spec.modality) {
    case "image": return "image/*";
    case "audio": return "audio/*";
    case "video": return "video/*";
    default: return undefined;
  }
}

function safeFieldId(baseId: string, name: string): string {
  return `${baseId}-${name.replace(/[^a-z0-9_-]/gi, "-")}`;
}

function InferenceOutputView({
  contract,
  outputs,
  timingMs,
}: {
  contract: InferenceContract | null;
  outputs: unknown;
  timingMs: number | null;
}): React.ReactElement {
  const kind = contract?.output.kind ?? "json";
  const name = contract?.output.name ?? "output";
  const unit = contract?.output.unit ?? null;
  const file = findFileDescriptor(outputs);
  const jsonView = <pre className="inference-json">{JSON.stringify(outputs, null, 2)}</pre>;

  let body: React.ReactElement;
  if (kind === "scalar") {
    const value = findFirstNumber(outputs);
    body = value === null ? jsonView : (
      <div className="inference-scalar">
        <span className="muted">{name}</span>
        <strong>{formatScalar(value)}</strong>
        {unit !== null ? <em>{unit}</em> : null}
      </div>
    );
  } else if (kind === "labels" || kind === "label") {
    const labels = findLabelArray(outputs);
    if (labels === null) {
      const text = findFirstString(outputs);
      body = text !== null ? <p className="inference-label">{text}</p> : jsonView;
    } else {
      const top = labels.slice(0, 12);
      body = (
        <div className="inference-labels">
          {top.map((entry, index) => (
            <div key={`${entry.label}:${index}`} className="inference-label-row">
              <span className="inference-label-name">{entry.label}</span>
              <span className="inference-label-bar"><span style={{ width: `${Math.max(0, Math.min(1, entry.score)) * 100}%` }} /></span>
              <span className="inference-label-score">{(entry.score * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      );
    }
  } else if (kind === "text") {
    const text = findFirstString(outputs);
    body = <pre className="inference-text">{text ?? JSON.stringify(outputs, null, 2)}</pre>;
  } else if (kind === "image" || kind === "plot") {
    if (file !== null) {
      // eslint-disable-next-line @next/next/no-img-element
      body = <img className="inference-image" src={file.url} alt="Model output" />;
    } else {
      body = jsonView;
    }
  } else if (kind === "file") {
    body = file !== null
      ? <a className="inference-file-link" href={file.url} target="_blank" rel="noreferrer" download={file.name}>Download {file.name}</a>
      : jsonView;
  } else {
    body = jsonView;
  }

  return (
    <div className="inference-output">
      <div className="inference-output-head">
        <span className="chip chip-success">result</span>
        {timingMs !== null ? <span className="muted">{timingMs} ms</span> : null}
      </div>
      {body}
      {/* A file output alongside a non-file primary view (e.g. an annotated image for a detection task). */}
      {file !== null && kind !== "image" && kind !== "plot" && kind !== "file" ? (
        <a className="inference-file-link" href={file.url} target="_blank" rel="noreferrer" download={file.name}>Download {file.name}</a>
      ) : null}
    </div>
  );
}

export function InferencePanel({
  workSession,
  busy,
  onAvailabilityChange,
}: {
  workSession: WorkSessionRecord | null;
  busy: boolean;
  onAvailabilityChange?: (available: boolean) => void;
}): React.ReactElement | null {
  const workSessionId = workSession?.id ?? null;
  const fieldIdBase = useId();
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [contract, setContract] = useState<InferenceContract | null>(null);
  const [worker, setWorker] = useState<InferenceWorkerInfo | null>(null);
  const [textValues, setTextValues] = useState<Record<string, string>>({});
  const [fileValues, setFileValues] = useState<Record<string, FileList | null>>({});
  const [decodeTemp, setDecodeTemp] = useState("0.8");
  const [decodeTopP, setDecodeTopP] = useState("0.95");
  const [decodeMaxTokens, setDecodeMaxTokens] = useState("200");
  const [decodeGreedy, setDecodeGreedy] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [predicting, setPredicting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outputs: unknown; timingMs: number | null } | null>(null);
  const [streamingText, setStreamingText] = useState("");

  const load = useCallback(async (): Promise<void> => {
    if (workSessionId === null) {
      setEnabled(false);
      onAvailabilityChange?.(false);
      return;
    }
    try {
      const response = await fetch(`/api/work-sessions/${workSessionId}/inference`, { method: "GET" });
      const body = (await response.json()) as InferenceMetaResponse;
      if (!body.ok || body.data === undefined) {
        setEnabled(false);
        onAvailabilityChange?.(false);
        return;
      }
      setEnabled(body.data.enabled);
      setAvailable(body.data.available);
      onAvailabilityChange?.(body.data.available);
      setContract(body.data.contract);
      setWorker(body.data.worker);
    } catch (error) {
      logClientProcess("warn", "inference_panel.load.failed", {
        workSessionId,
        message: error instanceof Error ? error.message : "unknown inference metadata error",
      });
    }
  }, [workSessionId, onAvailabilityChange]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setTextValues({});
    setFileValues({});
    setResult(null);
    setStreamingText("");
    setError(null);
  }, [workSessionId]);

  const warming = worker?.status === "starting";
  useEffect(() => {
    if (!warming) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void load();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [warming, load]);

  useEffect(() => {
    if (workSessionId === null || !enabled || available) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void load();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [workSessionId, enabled, available, load]);

  const postAction = useCallback(
    async (action: "start" | "stop" | "abort"): Promise<void> => {
      if (workSessionId === null) {
        return;
      }
      setBusyAction(true);
      setError(null);
      try {
        const response = await fetch(`/api/work-sessions/${workSessionId}/inference`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || body?.ok === false) {
          setError(body?.error ?? `Inference ${action} failed (HTTP ${response.status}).`);
        }
        await load();
      } catch (error) {
        setError(error instanceof Error ? error.message : `unknown inference ${action} error`);
      } finally {
        setBusyAction(false);
      }
    },
    [workSessionId, load],
  );

  const runPredict = useCallback(async (): Promise<void> => {
    if (workSessionId === null || contract === null) {
      return;
    }
    setPredicting(true);
    setError(null);
    setResult(null);
    setStreamingText("");
    try {
      const form = new FormData();
      form.set("action", "predict");
      const inputsObject: Record<string, unknown> = {};
      for (const spec of contract.inputs) {
        if (isFileModality(spec.modality)) {
          const files = fileValues[spec.name];
          if (files !== null && files !== undefined) {
            for (let index = 0; index < files.length; index += 1) {
              form.append(`file:${spec.name}`, files[index]);
            }
          }
          continue;
        }
        const raw = textValues[spec.name] ?? spec.example ?? "";
        if (spec.modality === "number") {
          inputsObject[spec.name] = raw.trim().length > 0 && Number.isFinite(Number(raw)) ? Number(raw) : null;
        } else if (spec.modality === "json") {
          try {
            inputsObject[spec.name] = JSON.parse(raw);
          } catch {
            inputsObject[spec.name] = raw;
          }
        } else {
          inputsObject[spec.name] = raw;
        }
      }
      form.set("inputs", JSON.stringify(inputsObject));
      const streaming = contract.task === "generation";
      if (streaming) {
        form.set("stream", "true");
        form.set(
          "options",
          JSON.stringify({
            temperature: decodeTemp.trim().length > 0 && Number.isFinite(Number(decodeTemp)) ? Number(decodeTemp) : null,
            top_p: decodeTopP.trim().length > 0 && Number.isFinite(Number(decodeTopP)) ? Number(decodeTopP) : null,
            max_new_tokens: decodeMaxTokens.trim().length > 0 && Number.isFinite(Number(decodeMaxTokens)) ? Number(decodeMaxTokens) : null,
            greedy: decodeGreedy,
          }),
        );
      }
      const response = await fetch(`/api/work-sessions/${workSessionId}/inference`, { method: "POST", body: form });

      if (streaming && response.ok && response.body !== null) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assembled = "";
        let streamError: string | null = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex = buffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf("\n");
            if (line.length === 0) {
              continue;
            }
            let message: { type?: string; text?: string; outputs?: unknown; timingMs?: number | null; error?: string };
            try {
              message = JSON.parse(line);
            } catch {
              continue;
            }
            if (message.type === "token" && typeof message.text === "string") {
              assembled += message.text;
              setStreamingText(assembled);
            } else if (message.type === "result") {
              setResult({ outputs: message.outputs, timingMs: message.timingMs ?? null });
            } else if (message.type === "error") {
              streamError = message.error ?? "Prediction failed.";
            }
          }
        }
        if (streamError !== null) {
          setError(streamError);
        }
      } else {
        const body = (await response.json().catch(() => null)) as
          | { ok?: boolean; error?: string; data?: { outputs: unknown; timingMs: number | null } }
          | null;
        if (!response.ok || body?.ok === false || body?.data === undefined) {
          setError(body?.error ?? `Prediction failed (HTTP ${response.status}).`);
        } else {
          setResult({ outputs: body.data.outputs, timingMs: body.data.timingMs });
        }
      }
      await load();
    } catch (error) {
      setError(error instanceof Error ? error.message : "unknown prediction error");
    } finally {
      setPredicting(false);
    }
  }, [workSessionId, contract, textValues, fileValues, decodeTemp, decodeTopP, decodeMaxTokens, decodeGreedy, load]);

  const applyExample = useCallback((inputs: Record<string, unknown>): void => {
    setTextValues((current) => {
      const next = { ...current };
      for (const [key, value] of Object.entries(inputs)) {
        if (typeof value === "string") {
          next[key] = value;
        } else if (typeof value === "number") {
          next[key] = String(value);
        } else {
          next[key] = JSON.stringify(value);
        }
      }
      return next;
    });
  }, []);

  if (workSession === null || !enabled || !available) {
    return null;
  }

  const ready = worker?.status === "ready";
  const device = worker?.device ?? null;
  const disabled = busy || busyAction || predicting;

  return (
    <details className="inference-panel" open>
      <summary>Inference playground</summary>
      <div className="inference-meta">
        <span className="muted">{contract?.title ?? "Trained model"}</span>
        {worker !== null ? (
          worker.status === "ready" ? (
            <span className="chip chip-success">{device === "cuda" || device === "mps" ? `${device.toUpperCase()} ready` : "ready · CPU"}</span>
          ) : worker.status === "starting" ? (
            <span className="chip chip-muted">loading model…</span>
          ) : worker.status === "error" ? (
            <span className="chip chip-danger" title={worker.message ?? undefined}>worker error</span>
          ) : (
            <span className="chip chip-muted">cold</span>
          )
        ) : null}
      </div>

      {!ready ? (
        <div className="inference-actions">
          <button type="button" className="primary small" onClick={() => void postAction("start")} disabled={disabled || warming}>
            {warming ? "Loading model…" : "Start model"}
          </button>
          {warming ? (
            <button type="button" className="danger-text small" onClick={() => void postAction("abort")} disabled={busyAction}>Cancel</button>
          ) : null}
          {worker?.message !== null && worker?.message !== undefined ? <span className="muted inference-note">{worker.message}</span> : null}
        </div>
      ) : (
        <>
          {contract !== null ? (
            <div className="inference-grid">
              {contract.inputs.map((spec) => {
                const fieldId = safeFieldId(fieldIdBase, spec.name);
                const selectedFiles = fileValues[spec.name];
                const fileSummary =
                  selectedFiles === null || selectedFiles === undefined || selectedFiles.length === 0
                    ? "No file selected"
                    : selectedFiles.length === 1
                      ? selectedFiles[0]?.name ?? "1 file selected"
                      : `${selectedFiles.length} files selected`;
                return (
                  <div key={spec.name} className="inference-field">
                    <label className="inference-label-text" htmlFor={fieldId}>
                      {spec.label}
                      {spec.help !== null ? <em className="inference-help">{spec.help}</em> : null}
                    </label>
                    {isFileModality(spec.modality) ? (
                      <div className="inference-file-picker">
                        <input
                          id={fieldId}
                          className="inference-file-input"
                          type="file"
                          accept={acceptForModality(spec)}
                          multiple={spec.multiple}
                          onChange={(event) => setFileValues((current) => ({ ...current, [spec.name]: event.target.files }))}
                          disabled={predicting}
                        />
                        <label className="inference-file-button" htmlFor={fieldId}>Choose file</label>
                        <span className="inference-file-name" title={fileSummary}>{fileSummary}</span>
                      </div>
                    ) : spec.modality === "number" ? (
                      <input
                        id={fieldId}
                        type="number"
                        value={textValues[spec.name] ?? ""}
                        placeholder={spec.example ?? ""}
                        onChange={(event) => setTextValues((current) => ({ ...current, [spec.name]: event.target.value }))}
                        disabled={predicting}
                      />
                    ) : spec.modality === "text" ? (
                      <textarea
                        id={fieldId}
                        value={textValues[spec.name] ?? ""}
                        placeholder={spec.example ?? ""}
                        onChange={(event) => setTextValues((current) => ({ ...current, [spec.name]: event.target.value }))}
                        disabled={predicting}
                        rows={3}
                      />
                    ) : (
                      <textarea
                        id={fieldId}
                        className="inference-mono"
                        value={textValues[spec.name] ?? ""}
                        placeholder={spec.example ?? (spec.modality === "json" ? "{ }" : "value")}
                        onChange={(event) => setTextValues((current) => ({ ...current, [spec.name]: event.target.value }))}
                        disabled={predicting}
                        rows={3}
                      />
                    )}
                  </div>
                );
              })}
              {contract.task === "generation" ? (
                <div className="inference-decode">
                  <label className="inference-field">
                    <span className="inference-label-text">Temperature</span>
                    <input type="number" min={0} step="any" value={decodeTemp} placeholder="greedy" onChange={(event) => setDecodeTemp(event.target.value)} disabled={predicting} />
                  </label>
                  <label className="inference-field">
                    <span className="inference-label-text">Top-p</span>
                    <input type="number" min={0} max={1} step="any" value={decodeTopP} placeholder="off" onChange={(event) => setDecodeTopP(event.target.value)} disabled={predicting} />
                  </label>
                  <label className="inference-field">
                    <span className="inference-label-text">Max new tokens</span>
                    <input type="number" min={1} value={decodeMaxTokens} placeholder="default" onChange={(event) => setDecodeMaxTokens(event.target.value)} disabled={predicting} />
                  </label>
                  <label className="inference-field inference-field-checkbox">
                    <span className="inference-label-text">Greedy</span>
                    <input type="checkbox" checked={decodeGreedy} onChange={(event) => setDecodeGreedy(event.target.checked)} disabled={predicting} />
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}

          {contract !== null && contract.examples.length > 0 ? (
            <div className="inference-examples">
              <span className="muted">Examples:</span>
              {contract.examples.map((example, index) => (
                <button key={`${example.label}:${index}`} type="button" className="ghost small" onClick={() => applyExample(example.inputs)} disabled={predicting}>
                  {example.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="inference-actions">
            <button type="button" className="primary small" onClick={() => void runPredict()} disabled={predicting}>
              {predicting ? "Running…" : "Run inference"}
            </button>
            <button type="button" className="ghost small" onClick={() => void postAction("stop")} disabled={busyAction}>Stop model</button>
          </div>
        </>
      )}

      {error !== null ? <p className="muted inference-failure">{error}</p> : null}
      {result === null && streamingText.length > 0 ? (
        <div className="inference-output">
          <div className="inference-output-head">
            <span className="chip chip-muted">streaming…</span>
          </div>
          <pre className="inference-text">{streamingText}</pre>
        </div>
      ) : null}
      {result !== null ? <InferenceOutputView contract={contract} outputs={result.outputs} timingMs={result.timingMs} /> : null}
    </details>
  );
}

export function SessionMini({
  workSession,
  verification,
  preview,
  status,
}: {
  workSession: WorkSessionRecord | null;
  verification: VerificationRunRecord | null;
  preview: PreviewServerRecord | null;
  status: StatusProjection;
}): React.ReactElement {
  return (
    <dl className="session-mini">
      <div>
        <dt>State</dt>
        <dd>
          <span className={`session-state-chip status-${status.tone}`} title={`Run state: ${status.label}`}>
            <span className="session-state-dot" aria-hidden />
            <span>{workSession === null ? "idle" : status.label}</span>
          </span>
        </dd>
      </div>
      <div>
        <dt>Verify</dt>
        <dd>{verification?.status ?? "—"}</dd>
      </div>
      <div>
        <dt>Preview</dt>
        <dd>{preview?.status ?? "—"}</dd>
      </div>
    </dl>
  );
}
