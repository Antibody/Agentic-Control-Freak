
export interface ChartSample {
  name: string;
  value: number;
  split: string;
  step: number | null;
  t: number | null;
}

export interface SeriesPoint {
  x: number;
  y: number;
  /** Original training step for this sample, when reported (null if the metric was timestamp-only). */
  step: number | null;
}

export interface Series {
  key: string;
  name: string;
  split: string;
  points: SeriesPoint[];
  /** Set when stride decimation dropped points so the rendered curve omits samples (disclosed in the legend). */
  decimated?: boolean;
}

export type Goal = "min" | "max";


export const MAX_SERIES = 8;
export const MAX_POINTS = 400;

export const MAX_AXES = 4;

export const SPARSE_THRESHOLD = 12;

export const MIN_BEST_DISTINCT = 3;

export const SCALE_SPLIT_RATIO = 8;
export const COUNT_ABS_FLOOR = 50;


export function coerceSample(payload: Record<string, unknown>): ChartSample | null {
  const name = payload.name;
  const value = payload.value;
  if (typeof name !== "string" || typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const split = typeof payload.split === "string" ? payload.split : "n/a";
  const step = typeof payload.step === "number" && Number.isFinite(payload.step) ? payload.step : null;
  const t = typeof payload.t === "number" && Number.isFinite(payload.t) ? payload.t : null;
  return { name, value, split, step, t };
}

/**
 * Liveness/progress instrumentation rows, not learning metrics: the heartbeat + setup splits and the
 * `*_started` phase beacons the trainer emits so the UI knows training is alive while CUDA kernels block.
 * Excluded from the chart (they otherwise clutter the plot and crowd real metrics out of the series cap).
 */
export function isBeaconSample(sample: ChartSample): boolean {
  return (
    sample.split === "heartbeat" ||
    sample.split === "setup" ||
    /_(?:started|begun|complete|completed|done)$/i.test(sample.name)
  );
}

/** Parse a metrics.jsonl artifact body into chart samples (bare metric rows; phase beacons are skipped). */
export function parseMetricsJsonl(text: string): ChartSample[] {
  const out: ChartSample[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const sample = coerceSample(JSON.parse(trimmed) as Record<string, unknown>);
      if (sample !== null) {
        out.push(sample);
      }
    } catch {
    }
  }
  return out;
}


/**
 * Direction of improvement for a metric, inferred from its name. Used only as a fallback when the run record
 * does not carry an explicit `goal` (see resolveGoal). Token-aware so substrings (e.g. "mape" inside an
 * unrelated name) do not false-match. Loss/error-family improve downward; everything else upward.
 */
export function metricGoal(name: string): Goal {
  return /(?:^|[_\-\s])(?:loss|losses|error|errors|err|nll|perplexity|ppl|rmse|mae|mse|mape|wer|cer|distance|divergence)(?:[_\-\s]|$)/i.test(
    name,
  )
    ? "min"
    : "max";
}

/** Prefer the trainer-declared goal; fall back to name inference when the run record predates the field. */
export function resolveGoal(name: string, explicit: Goal | null | undefined): Goal {
  return explicit ?? metricGoal(name);
}


/** Index of the best (selected) sample by goal. Returns the FIRST occurrence on ties — the earliest
 *  iteration that reached the optimum. -1 for an empty series. */
export function bestIndexByGoal(points: SeriesPoint[], goal: Goal): number {
  let bestIdx = -1;
  for (let i = 0; i < points.length; i += 1) {
    if (bestIdx < 0 || (goal === "min" ? points[i].y < points[bestIdx].y : points[i].y > points[bestIdx].y)) {
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** The point whose x is closest to a hovered x (ties resolve to the earlier point). Null for an empty series.
 *  Used by the chart's hover crosshair to read each series' value at the pointed-to step. */
export function nearestPointForX(points: SeriesPoint[], x: number): SeriesPoint | null {
  let best: SeriesPoint | null = null;
  let bestDist = Infinity;
  for (const point of points) {
    const dist = Math.abs(point.x - x);
    if (dist < bestDist) {
      bestDist = dist;
      best = point;
    }
  }
  return best;
}

/** The nearest actual sample x across ALL series, so the hover crosshair snaps onto real vertices rather than
 *  landing between samples. Null when no series has any point. */
export function snapToSampleX(series: Series[], x: number): number | null {
  let bestX: number | null = null;
  let bestDist = Infinity;
  for (const entry of series) {
    for (const point of entry.points) {
      const dist = Math.abs(point.x - x);
      if (dist < bestDist) {
        bestDist = dist;
        bestX = point.x;
      }
    }
  }
  return bestX;
}

/** Number of distinct y-values in a series. <2 means a flat/degenerate curve with no meaningful optimum. */
export function distinctValueCount(points: SeriesPoint[]): number {
  const set = new Set<number>();
  for (const point of points) {
    set.add(point.y);
  }
  return set.size;
}


/** A robust per-series scale: the 95th-percentile of |y|, NOT the max. Using a percentile keeps a single
 *  outlier spike (e.g. an LR-warmup blip) from inflating the perceived scale and misclassifying the series
 *  onto the secondary axis (forensics FM-007). */
export function seriesScale(points: SeriesPoint[]): number {
  const mags = points
    .map((point) => Math.abs(point.y))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (mags.length === 0) {
    return 0;
  }
  const idx = Math.min(mags.length - 1, Math.floor(0.95 * (mags.length - 1)));
  return mags[idx];
}

export function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Keys of the series that belong on the secondary (right) axis. A series qualifies ONLY if it is a genuine
 * large-valued "count" series: its robust scale is at/above an ABSOLUTE floor (COUNT_ABS_FLOOR) and also
 * dominates the median scale of the remaining series by SCALE_SPLIT_RATIO. A secondary axis is created only
 * when both groups end up non-empty (at least one count AND at least one non-count); otherwise every series
 * shares a single, unambiguously-labeled axis. This deliberately never separates bounded metrics (loss vs
 * rmse vs correlation) from each other — the misfire that made loss unreadable against an rmse-only axis.
 */
export function secondaryScaleKeys(series: Series[]): Set<string> {
  const empty = new Set<string>();
  const scales = series
    .map((entry) => ({ key: entry.key, scale: seriesScale(entry.points) }))
    .filter((entry) => entry.scale > 0);
  if (scales.length < 2) {
    return empty;
  }

  const counts = scales.filter((entry) => entry.scale >= COUNT_ABS_FLOOR);
  const rest = scales.filter((entry) => entry.scale < COUNT_ABS_FLOOR);
  if (counts.length === 0 || rest.length === 0) {
    return empty;
  }

  const medianRest = median(rest.map((entry) => entry.scale));
  const out = new Set<string>();
  for (const candidate of counts) {
    if (candidate.scale >= SCALE_SPLIT_RATIO * Math.max(medianRest, 1e-9)) {
      out.add(candidate.key);
    }
  }
  if (out.size === 0 || out.size >= scales.length) {
    return empty;
  }
  return out;
}

export type ScaleGroup = "count" | "metric";

export function groupOfKey(key: string, secondaryKeys: Set<string>): ScaleGroup {
  return secondaryKeys.has(key) ? "count" : "metric";
}


/**
 * Bounded correctness/quality metrics that live in [0,1] (or [0,100] as a percent) and improve UPWARD.
 * When co-plotted with an unbounded loss curve they get squashed into the bottom of a shared axis, so they
 * are peeled onto a dedicated fixed-range right axis. Crucially this is decided by NAME, not by the
 * scale-ratio heuristic (secondaryScaleKeys) — so it can never split loss vs rmse vs correlation apart from
 * each other, which is the bug class that guard exists to prevent. Token-aware like metricGoal so a substring
 * (e.g. "acc" inside "backtrack", "em" inside "system") does not false-match.
 */
export function isBoundedScoreMetric(name: string): boolean {
  return /(?:^|[_\-\s])(?:accuracy|acc|exact[_\-\s]?match|em|f1|precision|recall|auroc|auc|pass[_\-\s]?rate|win[_\-\s]?rate)(?:[_\-\s]|$)/i.test(
    name,
  );
}

export interface SecondaryAxis {
  keys: Set<string>;
  /** "count" = large-valued series split by scale (existing heuristic); "score" = accuracy-family by name. */
  kind: "count" | "score";
}

/**
 * Resolve which series (if any) move to the secondary (right) axis, and why. Precedence:
 *   1. A genuine large-valued "count" series (secondaryScaleKeys, unchanged) — keeps existing behavior.
 *   2. Otherwise an accuracy/score split: when BOTH a bounded-score series AND a non-score series are
 *      present, the score series move to a dedicated fixed-range axis so their curve is legible next to
 *      loss. A pure-accuracy plot (no non-score series) keeps one shared axis — nothing to dwarf it.
 * Returns null when no split applies (a single shared, unambiguously-labeled axis is the honest default).
 */
export function resolveSecondaryAxis(series: Series[]): SecondaryAxis | null {
  const countKeys = secondaryScaleKeys(series);
  if (countKeys.size > 0) {
    return { keys: countKeys, kind: "count" };
  }
  const scoreKeys = new Set<string>();
  let hasNonScore = false;
  for (const entry of series) {
    if (entry.points.length === 0) {
      continue;
    }
    if (isBoundedScoreMetric(entry.name)) {
      scoreKeys.add(entry.key);
    } else {
      hasNonScore = true;
    }
  }
  if (scoreKeys.size === 0 || !hasNonScore) {
    return null;
  }
  return { keys: scoreKeys, kind: "score" };
}

/**
 * Fixed bounds for the dedicated accuracy/score axis. Accuracy-family metrics live in [0,1]; using a fixed
 * range — not the observed min/max — places the curve honestly against the full attainable range instead of
 * zooming into noise. Extends to the next 100-multiple when a metric is reported as a percent (values > 1).
 */
export function scoreBounds(series: Series[], scoreKeys: Set<string>): { min: number; max: number } | null {
  let observedMax = -Infinity;
  for (const entry of series) {
    if (!scoreKeys.has(entry.key)) {
      continue;
    }
    for (const point of entry.points) {
      if (point.y > observedMax) observedMax = point.y;
    }
  }
  if (!Number.isFinite(observedMax)) {
    return null;
  }
  const top = observedMax > 1 ? Math.ceil(observedMax / 100) * 100 : 1;
  return { min: 0, max: top + top * 0.02 };
}

/** Data-driven linear y-range (5% padded) over an explicit set of series keys. Null when none have finite
 *  points. The shared bounding primitive for any single axis — a count axis, a magnitude cluster, etc. */
export function boundsForKeys(series: Series[], keys: Set<string>): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const entry of series) {
    if (!keys.has(entry.key)) {
      continue;
    }
    for (const point of entry.points) {
      if (point.y < min) min = point.y;
      if (point.y > max) max = point.y;
    }
  }
  if (!Number.isFinite(min)) {
    return null;
  }
  if (min === max) {
    min -= 0.5;
    max += 0.5;
  }
  const pad = (max - min) * 0.05;
  return { min: min - pad, max: max + pad };
}

/** Independent y-range for one scale group (so loss/correlation keep resolution alongside large counts).
 *  Pure: takes the series + the secondary-key set + which group to bound. Null when the group has no finite
 *  points. Back-compat wrapper over boundsForKeys. */
export function boundsFor(
  series: Series[],
  secondaryKeys: Set<string>,
  group: ScaleGroup,
): { min: number; max: number } | null {
  const keys = new Set<string>();
  for (const entry of series) {
    if (groupOfKey(entry.key, secondaryKeys) === group) {
      keys.add(entry.key);
    }
  }
  return boundsForKeys(series, keys);
}


const SPLIT_RANK: Record<string, number> = { val: 0, validation: 0, valid: 0, test: 1, train: 2 };

function splitRank(split: string): number {
  const rank = SPLIT_RANK[split.toLowerCase()];
  return rank === undefined ? 3 : rank;
}

/** Resolve the chart's primary series key from the run record's primary metric (exact name+split, else
 *  name-only — splits can default inconsistently between the metric stream and the run record). Returns the
 *  matched series key, or null when there is no primary or no match. */
export function resolvePrimaryKey(
  series: Series[],
  primaryName: string | null,
  primarySplit: string | null,
): string | null {
  if (primaryName === null) {
    return null;
  }
  if (primarySplit !== null) {
    const exact = series.find((entry) => entry.name === primaryName && entry.split === primarySplit);
    if (exact !== undefined) {
      return exact.key;
    }
  }
  const byName = series.find((entry) => entry.name === primaryName);
  return byName !== undefined ? byName.key : null;
}

/** Sort comparator for display order (and thus which series survive the MAX_SERIES cap): the primary series
 *  first (so its marker is always kept), then the headline loss curve, then split priority val > test >
 *  train, then the richest series. */
export function compareSeriesForDisplay(a: Series, b: Series, primaryKey: string | null): number {
  const aPrimary = a.key === primaryKey ? 0 : 1;
  const bPrimary = b.key === primaryKey ? 0 : 1;
  if (aPrimary !== bPrimary) {
    return aPrimary - bPrimary;
  }
  const aLoss = /loss/i.test(a.name) ? 0 : 1;
  const bLoss = /loss/i.test(b.name) ? 0 : 1;
  if (aLoss !== bLoss) {
    return aLoss - bLoss;
  }
  const aRank = splitRank(a.split);
  const bRank = splitRank(b.split);
  if (aRank !== bRank) {
    return aRank - bRank;
  }
  return b.points.length - a.points.length;
}


export interface ChartAxis {
  id: string;
  keys: Set<string>;
  /** "score" = the shared [0,1] (or [0,100]%) accuracy/quality axis; "scale" = a data-driven magnitude axis. */
  kind: "score" | "scale";
  side: "left" | "right";
  /** 0 = inner (nearest the plot), 1 = outer. At most 2 axes per side. */
  depth: 0 | 1;
  /** "log" for a wide-dynamic-range scale axis (e.g. perplexity) so an early spike doesn't flatten the tail;
   *  "linear" otherwise. bounds are always in DATA space (already padded). */
  scale: "linear" | "log";
  bounds: { min: number; max: number };
  /** The series whose name + color label this axis. */
  leadKey: string;
  /** True when two distinct-scale clusters were merged to respect MAX_AXES (disclosed in the legend). */
  merged?: boolean;
}

export const LOG_DYNAMIC_RATIO = 15;

/** Whether a scale group should render on a log10 axis: every finite value positive, and a >LOG_DYNAMIC_RATIO
 *  spread between the smallest and largest positive value. A single non-positive value forces linear (log is
 *  undefined there). */
export function shouldUseLogScale(members: Series[]): boolean {
  let minPos = Infinity;
  let maxPos = -Infinity;
  for (const entry of members) {
    for (const point of entry.points) {
      if (!Number.isFinite(point.y)) {
        continue;
      }
      if (point.y <= 0) {
        return false;
      }
      if (point.y < minPos) minPos = point.y;
      if (point.y > maxPos) maxPos = point.y;
    }
  }
  if (!Number.isFinite(minPos) || minPos <= 0) {
    return false;
  }
  return maxPos / minPos > LOG_DYNAMIC_RATIO;
}

/** Padded log-space bounds (returned in DATA space) for a log axis over the given keys. Null when there are no
 *  positive finite points. */
export function logBoundsForKeys(series: Series[], keys: Set<string>): { min: number; max: number } | null {
  let minPos = Infinity;
  let maxPos = -Infinity;
  for (const entry of series) {
    if (!keys.has(entry.key)) {
      continue;
    }
    for (const point of entry.points) {
      if (!Number.isFinite(point.y) || point.y <= 0) {
        continue;
      }
      if (point.y < minPos) minPos = point.y;
      if (point.y > maxPos) maxPos = point.y;
    }
  }
  if (!Number.isFinite(minPos) || minPos <= 0) {
    return null;
  }
  const logLo = Math.log10(minPos);
  const logHi = Math.log10(maxPos);
  const pad = (logHi - logLo) * 0.05 || 0.05;
  return { min: 10 ** (logLo - pad), max: 10 ** (logHi + pad) };
}

const SCORE_EPSILON = 1e-6;

/** A series belongs on the shared [0,1] score axis if it is an accuracy-family metric by name OR every
 *  observed value lies within [0,1]. Everything else (loss, perplexity, counts, ...) is scale-clustered onto
 *  its own axis so a large-valued metric neither dominates nor is squashed. */
export function isBounded01Series(entry: Series): boolean {
  if (isBoundedScoreMetric(entry.name)) {
    return true;
  }
  let anyFinite = false;
  for (const point of entry.points) {
    if (!Number.isFinite(point.y)) {
      continue;
    }
    anyFinite = true;
    if (point.y < -SCORE_EPSILON || point.y > 1 + SCORE_EPSILON) {
      return false;
    }
  }
  return anyFinite;
}

/** Lead series for an axis: the primary metric if present, else a loss curve, else the richest series. */
function pickLead(members: Series[], primaryKey: string | null): Series {
  if (primaryKey !== null) {
    const primary = members.find((entry) => entry.key === primaryKey);
    if (primary !== undefined) {
      return primary;
    }
  }
  const loss = members.find((entry) => /loss/i.test(entry.name));
  if (loss !== undefined) {
    return loss;
  }
  return [...members].sort((a, b) => b.points.length - a.points.length)[0];
}

/** Group non-[0,1] series by metric NAME (case-insensitive), preserving first-seen order. So `loss/train` and
 *  `loss/val` share one axis, while `perplexity` gets its own — a differently-named metric is NEVER forced
 *  onto another metric's axis just because their numeric ranges happen to be close (which would let a
 *  larger-valued metric like perplexity squash loss). Same name = same scale = comparable on one axis. */
function groupByMetricName(entries: Series[]): Series[][] {
  const groups = new Map<string, Series[]>();
  const order: string[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    let group = groups.get(name);
    if (group === undefined) {
      group = [];
      groups.set(name, group);
      order.push(name);
    }
    group.push(entry);
  }
  return order.map((name) => groups.get(name) as Series[]);
}

interface AxisCandidate {
  keys: Set<string>;
  kind: "score" | "scale";
  members: Series[];
  merged?: boolean;
}

function clusterScaleOf(candidate: AxisCandidate): number {
  return Math.max(0, ...candidate.members.map((entry) => seriesScale(entry.points)));
}

function orderCandidates(candidates: AxisCandidate[], primaryKey: string | null): void {
  const hasPrimary = (c: AxisCandidate): boolean => primaryKey !== null && c.keys.has(primaryKey);
  const hasLoss = (c: AxisCandidate): boolean => c.members.some((entry) => /loss/i.test(entry.name));
  candidates.sort((a, b) => {
    if (hasPrimary(a) !== hasPrimary(b)) return hasPrimary(a) ? -1 : 1;
    if (hasLoss(a) !== hasLoss(b)) return hasLoss(a) ? -1 : 1;
    if (a.members.length !== b.members.length) return b.members.length - a.members.length;
    return clusterScaleOf(b) - clusterScaleOf(a);
  });
}

/**
 * Assign every series to one of up to MAX_AXES independent Y-axes so no metric dominates the plot. A single
 * shared [0,1] "score" axis hosts the bounded accuracy/quality family; each remaining metric NAME (loss,
 * perplexity, tokens, lr, ...) becomes its own linear, padded "scale" axis — so a large-valued metric like
 * perplexity never shares loss's axis and squashes it. Axes are ordered by importance (the axis with the
 * primary metric first, then loss, then richest/largest), capped to MAX_AXES by merging the two closest-scale
 * scale axes (never the score axis), and balanced at most 2 per side (left-inner, right-inner, left-outer,
 * right-outer). leadKey drives each axis's color + caption. Returns [] for no data.
 */
export function assignAxes(series: Series[], primaryKey: string | null): ChartAxis[] {
  const withPoints = series.filter((entry) => entry.points.length > 0);
  if (withPoints.length === 0) {
    return [];
  }

  const bounded = withPoints.filter((entry) => isBounded01Series(entry));
  const rest = withPoints.filter((entry) => !isBounded01Series(entry));

  const candidates: AxisCandidate[] = [];
  if (bounded.length > 0) {
    candidates.push({ keys: new Set(bounded.map((entry) => entry.key)), kind: "score", members: bounded });
  }
  for (const group of groupByMetricName(rest)) {
    candidates.push({ keys: new Set(group.map((entry) => entry.key)), kind: "scale", members: group });
  }
  if (candidates.length === 0) {
    return [];
  }
  orderCandidates(candidates, primaryKey);

  while (candidates.length > MAX_AXES) {
    const scaleCandidates = candidates.filter((candidate) => candidate.kind === "scale");
    if (scaleCandidates.length < 2) {
      break;
    }
    const byScale = [...scaleCandidates].sort((a, b) => clusterScaleOf(a) - clusterScaleOf(b));
    let lowCandidate = byScale[0];
    let highCandidate = byScale[1];
    let bestRatio = Infinity;
    for (let k = 1; k < byScale.length; k += 1) {
      const lo = Math.max(clusterScaleOf(byScale[k - 1]), 1e-9);
      const ratio = clusterScaleOf(byScale[k]) / lo;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        lowCandidate = byScale[k - 1];
        highCandidate = byScale[k];
      }
    }
    const merged: AxisCandidate = {
      keys: new Set([...lowCandidate.keys, ...highCandidate.keys]),
      kind: "scale",
      members: [...lowCandidate.members, ...highCandidate.members],
      merged: true,
    };
    const next = candidates.filter((candidate) => candidate !== lowCandidate && candidate !== highCandidate);
    next.push(merged);
    candidates.length = 0;
    candidates.push(...next);
    orderCandidates(candidates, primaryKey);
  }

  return candidates.map((candidate, index) => {
    const lead = pickLead(candidate.members, primaryKey);
    const useLog = candidate.kind === "scale" && shouldUseLogScale(candidate.members);
    const bounds =
      candidate.kind === "score"
        ? scoreBounds(series, candidate.keys) ?? { min: 0, max: 1 }
        : useLog
          ? logBoundsForKeys(series, candidate.keys) ?? boundsForKeys(series, candidate.keys) ?? { min: 0, max: 1 }
          : boundsForKeys(series, candidate.keys) ?? { min: 0, max: 1 };
    return {
      id: candidate.kind === "score" ? "score" : `scale-${index}`,
      keys: candidate.keys,
      kind: candidate.kind,
      side: (index % 2 === 0 ? "left" : "right") as "left" | "right",
      depth: (index < 2 ? 0 : 1) as 0 | 1,
      scale: (useLog ? "log" : "linear") as "linear" | "log",
      bounds,
      leadKey: lead.key,
      merged: candidate.merged,
    };
  });
}

/** The axis a given series key renders against (null when not found). */
export function axisForKey(axes: ChartAxis[], key: string): ChartAxis | null {
  return axes.find((axis) => axis.keys.has(key)) ?? null;
}


/** Adaptive decimal precision for an axis tick, chosen from the visible RANGE so small-range metrics
 *  (e.g. rmse 0.060-0.080) are not all collapsed to "0.06/0.07/0.08" by a fixed 2-decimal format. */
export function formatTick(value: number, range: number): string {
  const span = Math.abs(range);
  const decimals = span >= 1 ? 2 : span >= 0.01 ? 3 : 4;
  return value.toFixed(decimals);
}

/** Label for the secondary axis. Uses "k" compaction ONLY for genuinely large count axes (group max
 *  >= 1000); otherwise falls back to adaptive decimals so a 0-1 metric that lands on the secondary axis is
 *  never rounded to "0"/"1" (forensics FM-002). */
export function formatSecondaryTick(value: number, range: number, groupMax: number): string {
  if (Math.abs(groupMax) >= 1000) {
    const abs = Math.abs(value);
    return `${(value / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  }
  return formatTick(value, range);
}
