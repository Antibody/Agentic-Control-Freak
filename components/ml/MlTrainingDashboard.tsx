"use client";

import { useEffect, useMemo, useState } from "react";
import type { EventRecord, ExperimentRunRecord } from "@/lib/shared/types";
import type { ExperimentGpuStatus } from "@/components/PreviewPane";
import { MlMetricChart, parseMetricsJsonl, type ChartSample } from "@/components/ml/MlMetricChart";


interface MlTrainingDashboardProps {
  latestRun: ExperimentRunRecord | null;
  manifest: { kind: string; entrypoint: string } | null;
  gpu: ExperimentGpuStatus | null;
  running: boolean;
  events: EventRecord[];
  experimentRuns: ExperimentRunRecord[];
  workSessionId: string | null;
}

function deviceChip(gpu: ExperimentGpuStatus | null, run: ExperimentRunRecord | null): { text: string; className: string } {
  if (run?.effectiveDevice === "cuda" || run?.effectiveDevice === "mps") {
    return { text: `${run.effectiveDevice.toUpperCase()}${gpu?.deviceName ? ` · ${gpu.deviceName}` : ""}`, className: "chip experiment-gpu-ready" };
  }
  if (gpu?.accelerator === "cuda") {
    return { text: `GPU: ${gpu.deviceName ?? "CUDA"} ready`, className: "chip experiment-gpu-ready" };
  }
  if (gpu?.warning !== null && gpu?.warning !== undefined) {
    return { text: "GPU disabled · CPU", className: "chip experiment-gpu-warn" };
  }
  return { text: "CPU", className: "chip chip-muted" };
}

function experimentRunTone(status: ExperimentRunRecord["status"]): "success" | "warning" | "danger" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "aborted") return "danger";
  return "warning";
}

export function MlTrainingDashboard({
  latestRun,
  manifest,
  gpu,
  running,
  events,
  experimentRuns,
  workSessionId,
}: MlTrainingDashboardProps): React.ReactElement {
  const runId = latestRun?.id ?? null;
  const [recovered, setRecovered] = useState<ChartSample[]>([]);

  const terminal = latestRun !== null && latestRun.status !== "running" && latestRun.status !== "queued";
  const metricsArtifactId = latestRun?.metricsArtifactId ?? null;
  useEffect(() => {
    if (!terminal || metricsArtifactId === null) {
      setRecovered([]);
      return undefined;
    }
    let active = true;
    void fetch(`/api/artifacts/${metricsArtifactId}`)
      .then((response) => (response.ok ? response.text() : ""))
      .then((text) => {
        if (active && text.length > 0) {
          setRecovered(parseMetricsJsonl(text));
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [terminal, metricsArtifactId]);

  const { phase, maxStep } = useMemo(() => {
    let phaseLabel: string | null = null;
    let step = -1;
    if (runId !== null) {
      for (const event of events) {
        if (event.aggregateId !== runId) {
          continue;
        }
        if (event.eventName === "experiment.phase") {
          const value = (event.payload as { phase?: unknown }).phase;
          if (typeof value === "string") {
            phaseLabel = value;
          }
        } else if (event.eventName === "experiment.metric") {
          const value = (event.payload as { step?: unknown }).step;
          if (typeof value === "number" && Number.isFinite(value) && value > step) {
            step = value;
          }
        }
      }
    }
    return { phase: phaseLabel, maxStep: step };
  }, [events, runId]);

  const maxSteps = latestRun?.config.maxSteps ?? null;
  const progress = maxSteps !== null && maxStep >= 0 ? Math.max(0, Math.min(1, maxStep / maxSteps)) : null;

  const primary = latestRun?.primaryMetric ?? null;
  const baseline = useMemo(() => {
    if (primary === null || workSessionId === null || latestRun === null) {
      return null;
    }
    const prior = experimentRuns
      .filter(
        (run) =>
          run.workSessionId === workSessionId
          && run.id !== latestRun.id
          && run.status === "succeeded"
          && run.primaryMetric !== null
          && run.primaryMetric.name === primary.name,
      )
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
    return prior?.primaryMetric ?? null;
  }, [experimentRuns, primary, workSessionId, latestRun]);

  const device = deviceChip(gpu, latestRun);
  const statusToneClass = latestRun !== null ? `chip-${experimentRunTone(latestRun.status)}` : "chip-muted";
  const delta = primary !== null && baseline !== null ? primary.value - baseline.value : null;

  return (
    <div className="ml-dashboard">
      <div className="ml-dashboard-chips">
        {latestRun !== null ? (
          <span className={`chip ${statusToneClass} experiment-status-${latestRun.status}`}>{latestRun.regime} · {latestRun.status}</span>
        ) : (
          <span className="chip chip-muted">no run yet</span>
        )}
        <span className={device.className}>{device.text}</span>
        {running ? <span className="chip chip-muted ml-live-chip">live</span> : null}
        {manifest !== null ? <span className="muted ml-dashboard-manifest">{manifest.kind} · {manifest.entrypoint}</span> : null}
      </div>

      {/* While running, show live progress against the step cap (maxSteps is an upper bound, not a target —
          epoch-bounded scripts often finish well before it). Once the run is terminal, the step/maxSteps
          fraction is meaningless (a succeeded run that stopped early at its epoch limit must not read as
          "39% done"), so show the final step + outcome instead of a partial bar. */}
      {running && (phase !== null || maxStep >= 0) ? (
        <div className="ml-progress-row">
          {phase !== null ? <span className="muted">phase: <strong>{phase}</strong></span> : null}
          {maxStep >= 0 ? <span className="muted">step {maxStep}{maxSteps !== null ? ` / ${maxSteps} max` : ""}</span> : null}
          {progress !== null ? (
            <span className="ml-progress"><span className="ml-progress-bar" style={{ width: `${(progress * 100).toFixed(1)}%` }} /></span>
          ) : null}
        </div>
      ) : !running && latestRun !== null && maxStep >= 0 ? (
        <div className="ml-progress-row">
          <span className="muted">{latestRun.status === "succeeded" ? "completed" : latestRun.status} at step {maxStep}</span>
        </div>
      ) : null}

      <MlMetricChart
        events={events}
        runId={runId}
        recoveredSamples={recovered}
        primary={primary !== null ? { name: primary.name, split: primary.split, goal: primary.goal ?? null } : null}
      />

      <div className="ml-dashboard-metrics">
        {primary !== null ? (
          <span className="experiment-primary">{primary.name}: <strong>{primary.value.toFixed(4)}</strong> ({primary.split})</span>
        ) : null}
        {delta !== null && baseline !== null ? (
          <span className="muted">baseline {baseline.value.toFixed(4)} · Δ {delta >= 0 ? "+" : ""}{delta.toFixed(4)}</span>
        ) : null}
      </div>

      {latestRun?.deviceMismatch === true ? (
        <span className="chip experiment-device-mismatch">GPU intended · ran on {latestRun.effectiveDevice ?? "cpu"}</span>
      ) : null}
      {latestRun !== null && latestRun.summary.length > 0 ? <p className="muted experiment-summary">{latestRun.summary}</p> : null}
      {latestRun?.status === "failed" && latestRun.failureSummary !== null && latestRun.failureSummary.length > 0 ? (
        <p className="muted experiment-failure">{latestRun.failureSummary.slice(0, 400)}</p>
      ) : null}
    </div>
  );
}
