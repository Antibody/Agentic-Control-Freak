import path from "node:path";
import { readFile } from "node:fs/promises";
import { saveArtifact } from "@/lib/server/artifacts";
import type { ArtifactRecord, Identifier, JsonObject } from "@/lib/shared/types";

export type MetricGoal = "max" | "min";

export interface ScorecardMetric {
  name: string;
  value: number;
  split: string;
  goal: MetricGoal;
}

export interface ScorecardObjective {
  name: string;
  value: number;
}

export interface Scorecard {
  primary: ScorecardMetric | null;
  baseline: { name: string; value: number; split: string } | null;
  secondary: ScorecardMetric[];
  beatsBaseline: boolean | null;
  margin: number | null;
  objectives: ScorecardObjective[];
  pareto: ScorecardObjective[];
  ok: boolean | null;
  errorMessage: string | null;
}

function asGoal(value: unknown): MetricGoal {
  return value === "min" ? "min" : "max";
}

function asMetric(value: unknown): ScorecardMetric | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string" && typeof record.value === "number" && Number.isFinite(record.value)) {
    return {
      name: record.name,
      value: record.value,
      split: typeof record.split === "string" ? record.split : "n/a",
      goal: asGoal(record.goal),
    };
  }
  return null;
}

function asBaseline(value: unknown): { name: string; value: number; split: string } | null {
  const metric = asMetric(value);
  return metric === null ? null : { name: metric.name, value: metric.value, split: metric.split };
}

const paretoObjectiveNames = new Set([
  "wall_s",
  "peak_ram_mb",
  "peak_vram_mb",
  "decode_tokens_per_s",
  "prefill_tokens_per_s",
  "samples_per_s",
  "compression_ratio",
  "trainable_ratio",
  "energy_kwh",
]);

export async function readSummary(workspacePath: string, summaryFile: string): Promise<JsonObject | null> {
  try {
    return JSON.parse(await readFile(path.join(workspacePath, summaryFile), "utf8")) as JsonObject;
  } catch {
    return null;
  }
}

export function buildScorecard(summary: JsonObject | null): Scorecard {
  if (summary === null) {
    return { primary: null, baseline: null, secondary: [], beatsBaseline: null, margin: null, objectives: [], pareto: [], ok: null, errorMessage: null };
  }
  const ok = typeof summary.ok === "boolean" ? summary.ok : null;
  const errorMessage = typeof summary.error === "string" ? summary.error : null;
  const primary = asMetric(summary.primary);
  const baseline = asBaseline(summary.baseline);
  const secondary: ScorecardMetric[] = [];
  if (Array.isArray(summary.secondary)) {
    for (const entry of summary.secondary) {
      const metric = asMetric(entry);
      if (metric !== null) {
        secondary.push(metric);
      }
    }
  }
  const objectives: ScorecardObjective[] = [];
  const pareto: ScorecardObjective[] = [];
  if (typeof summary.objectives === "object" && summary.objectives !== null) {
    for (const [name, value] of Object.entries(summary.objectives as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        objectives.push({ name, value });
        if (paretoObjectiveNames.has(name)) {
          pareto.push({ name, value });
        }
      }
    }
  }
  let beatsBaseline: boolean | null = null;
  let margin: number | null = null;
  if (primary !== null && baseline !== null) {
    margin = primary.value - baseline.value;
    beatsBaseline = primary.goal === "min" ? primary.value < baseline.value : primary.value > baseline.value;
  }
  return { primary, baseline, secondary, beatsBaseline, margin, objectives, pareto, ok, errorMessage };
}

function formatObjective(objective: ScorecardObjective): string {
  if (objective.name === "wall_s") {
    return `wall ${objective.value}s`;
  }
  if (objective.name === "peak_ram_mb") {
    return `ram ${objective.value}MB`;
  }
  if (objective.name === "peak_vram_mb") {
    return `vram ${objective.value}MB`;
  }
  if (objective.name === "decode_tokens_per_s") {
    return `${objective.value} tok/s`;
  }
  if (objective.name === "compression_ratio") {
    return `${objective.value}x smaller`;
  }
  return `${objective.name} ${objective.value}`;
}

export function scorecardSummaryText(scorecard: Scorecard): string {
  if (scorecard.ok === false) {
    return `Training failed: ${scorecard.errorMessage ?? "the experiment reported ok=false"}.`;
  }
  if (scorecard.primary === null) {
    return "Experiment produced no valid primary metric.";
  }
  const head = `${scorecard.primary.name}=${scorecard.primary.value.toFixed(4)} (${scorecard.primary.split})`;
  const baseline = scorecard.baseline !== null
    ? `, baseline ${scorecard.baseline.value.toFixed(4)}${scorecard.beatsBaseline === true ? " (beats baseline)" : scorecard.beatsBaseline === false ? " (does NOT beat baseline)" : ""}`
    : "";
  const pareto = scorecard.pareto.length > 0
    ? `, ${scorecard.pareto.map(formatObjective).join(", ")}`
    : (() => {
        const wall = scorecard.objectives.find((objective) => objective.name === "wall_s");
        return wall !== undefined ? `, wall ${wall.value}s` : "";
      })();
  return `${head}${baseline}${pareto}`;
}

export async function writeScorecardArtifact(
  workSessionId: Identifier,
  scorecard: Scorecard,
  summary: JsonObject | null,
  stamp: number,
): Promise<ArtifactRecord> {
  return saveArtifact({
    workSessionId,
    kind: "report",
    fileName: `ml-scorecard-${stamp}.json`,
    content: JSON.stringify({ scorecard, summary }, null, 2),
    metadata: {
      reportType: "ml_scorecard",
      summary: scorecardSummaryText(scorecard),
    },
  });
}
