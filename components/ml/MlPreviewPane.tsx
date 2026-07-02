"use client";

import { useEffect, useMemo, useState } from "react";
import type { EventRecord, ExperimentRunRecord, VerificationRunRecord, WorkSessionRecord } from "@/lib/shared/types";
import type { StatusProjection } from "@/lib/shared/ui-projections";
import { ExperimentPanel, InferencePanel, SessionMini } from "@/components/PreviewPane";
import { MlTrainingDashboard } from "@/components/ml/MlTrainingDashboard";


type MlTab = "training" | "inference";

interface MlPreviewPaneProps {
  workSession: WorkSessionRecord | null;
  verification: VerificationRunRecord | null;
  status: StatusProjection;
  busy: boolean;
  eventLog: EventRecord[];
  experimentRuns: ExperimentRunRecord[];
}

export function MlPreviewPane({
  workSession,
  verification,
  status,
  busy,
  eventLog,
  experimentRuns,
}: MlPreviewPaneProps): React.ReactElement {
  const workSessionId = workSession?.id ?? null;
  const [manualTab, setManualTab] = useState<MlTab | null>(null);
  const [inferenceAvailable, setInferenceAvailable] = useState(false);

  useEffect(() => {
    setManualTab(null);
    setInferenceAvailable(false);
  }, [workSessionId]);

  const latestRun = useMemo(() => {
    if (workSessionId === null) {
      return null;
    }
    return experimentRuns
      .filter((run) => run.workSessionId === workSessionId)
      .slice()
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0] ?? null;
  }, [experimentRuns, workSessionId]);

  const trainingActive = latestRun?.status === "running" || latestRun?.status === "queued";
  const autoTab: MlTab = trainingActive ? "training" : inferenceAvailable ? "inference" : "training";
  const activeTab = manualTab ?? autoTab;

  return (
    <aside className="pane ml-pane">
      <header className="pane-header ml-pane-header">
        <div className="pane-title">
          <strong>{activeTab === "training" ? "Training" : "Inference"}</strong>
        </div>
        <div className="ml-tabs" role="tablist" aria-label="ML view">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "training"}
            aria-label={trainingActive ? "Training, run active" : "Training"}
            className={`ml-tab${activeTab === "training" ? " ml-tab-active" : ""}`}
            onClick={() => setManualTab("training")}
          >
            Training
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "inference"}
            className={`ml-tab${activeTab === "inference" ? " ml-tab-active" : ""}`}
            onClick={() => setManualTab("inference")}
          >
            Inference
          </button>
        </div>
      </header>
      <div className="pane-body ml-pane-body">
        <div className="ml-tab-panel" hidden={activeTab !== "training"}>
          <ExperimentPanel
            workSession={workSession}
            busy={busy}
            renderDashboard={(ctx) => (
              <MlTrainingDashboard
                latestRun={ctx.latestRun}
                manifest={ctx.manifest}
                gpu={ctx.gpu}
                running={ctx.running}
                events={eventLog}
                experimentRuns={experimentRuns}
                workSessionId={workSessionId}
              />
            )}
          />
        </div>
        <div className="ml-tab-panel" hidden={activeTab !== "inference"}>
          {!inferenceAvailable ? (
            <div className="pane-placeholder ml-inference-empty">
              <p>No trained model yet.</p>
              <p className="muted">Run a short or full experiment in the Training tab to produce a checkpoint, then test it here.</p>
            </div>
          ) : null}
          <InferencePanel workSession={workSession} busy={busy} onAvailabilityChange={setInferenceAvailable} />
        </div>
      </div>
      <footer className="pane-footer">
        <SessionMini workSession={workSession} verification={verification} preview={null} status={status} />
      </footer>
    </aside>
  );
}
