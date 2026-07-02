"use client";

import { useEffect, useState } from "react";
import type { ApiResult, ArtifactRecord, WorkSessionRecord } from "@/lib/shared/types";

interface ReportItem extends ArtifactRecord {
  reportType: string;
  summary: string | null;
}

type ReportsApiResult = ApiResult<ReportItem[]>;

function isReportsApiResult(value: unknown): value is ReportsApiResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

function reportTitle(report: ReportItem): string {
  if (typeof report.metadata.title === "string") return report.metadata.title;
  if (typeof report.metadata.request === "string") return report.metadata.request;
  return report.reportType.replace(/_/g, " ");
}

export function ReportsPane({ workSession, onShowPreview }: { workSession: WorkSessionRecord | null; onShowPreview: () => void }) {
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let canceled = false;
    async function loadReports() {
      if (workSession === null) {
        setReports([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/work-sessions/${workSession.id}/reports`, { cache: "no-store" });
        const body: unknown = await response.json();
        if (!isReportsApiResult(body) || !body.ok || body.data === undefined) {
          throw new Error(isReportsApiResult(body) ? body.error ?? "Reports API returned an error." : "Invalid reports API response.");
        }
        if (!canceled) setReports(body.data);
      } catch (loadError) {
        if (!canceled) setError(loadError instanceof Error ? loadError.message : "Unable to load reports.");
      } finally {
        if (!canceled) setLoading(false);
      }
    }
    void loadReports();
    return () => {
      canceled = true;
    };
  }, [workSession]);

  return (
    <section className="reports-pane">
      <div className="reports-pane-head">
        <div>
          <h2>Reports</h2>
          <p>Research, diagnostics, verification, and handoff artifacts for this session.</p>
        </div>
        <button type="button" className="ghost small" onClick={onShowPreview}>Preview</button>
      </div>
      {loading ? <p className="muted small">Loading reports...</p> : null}
      {error !== null ? <p className="error-text small">{error}</p> : null}
      {!loading && reports.length === 0 ? <p className="muted small">No report artifacts have been recorded yet.</p> : null}
      <div className="reports-list">
        {reports.map((report) => (
          <article key={report.id} className="report-card">
            <div className="report-card-head">
              <span>{report.reportType}</span>
              <time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time>
            </div>
            <h3>{reportTitle(report)}</h3>
            {report.summary !== null ? <p>{report.summary}</p> : null}
            <a href={`/api/artifacts/${report.id}`} target="_blank" rel="noreferrer">Open artifact</a>
          </article>
        ))}
      </div>
    </section>
  );
}
