"use client";

import { useMemo, useRef, useState } from "react";
import type { EventRecord } from "@/lib/shared/types";
import {
  assignAxes,
  axisForKey,
  bestIndexByGoal,
  coerceSample,
  compareSeriesForDisplay,
  distinctValueCount,
  formatSecondaryTick,
  formatTick,
  isBeaconSample,
  MAX_POINTS,
  MAX_SERIES,
  MIN_BEST_DISTINCT,
  nearestPointForX,
  parseMetricsJsonl,
  resolveGoal,
  resolvePrimaryKey,
  snapToSampleX,
  SPARSE_THRESHOLD,
  type ChartAxis,
  type ChartSample,
  type Series,
} from "@/components/ml/metric-chart-scale";


export { parseMetricsJsonl };
export type { ChartSample };

const SERIES_COLORS = [
  "#2563eb", // blue
  "#16a34a", // green
  "#d97706", // orange
  "#9333ea", // purple
  "#dc2626", // red
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
];

export function MlMetricChart({
  events,
  runId,
  recoveredSamples = [],
  primary = null,
  height = 220,
}: {
  events: EventRecord[];
  runId: string | null;
  recoveredSamples?: ChartSample[];
  /**
   * The run's primary metric. When provided, the matching series is annotated with its best point — the
   * iteration the trainer selects — so an overfitting tail does not read as the final model. `goal` is the
   * trainer-declared optimization direction (falls back to name inference when absent).
   */
  primary?: { name: string; split: string; goal?: "min" | "max" | null } | null;
  height?: number;
}): React.ReactElement {
  const primaryName = primary?.name ?? null;
  const primarySplit = primary?.split ?? null;
  const primaryGoal = primary?.goal ?? null;

  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null);

  const { series, primaryIndex, hiddenCount } = useMemo<{
    series: Series[];
    primaryIndex: number;
    hiddenCount: number;
  }>(() => {
    const merged = new Map<string, ChartSample>();
    const add = (sample: ChartSample, order: number): void => {
      if (isBeaconSample(sample)) {
        return;
      }
      merged.set(`${sample.name}::${sample.split}::${sample.step ?? `o${order}`}`, sample);
    };
    recoveredSamples.forEach((sample, index) => add(sample, index));
    if (runId !== null) {
      let order = 0;
      for (const event of events) {
        if (event.eventName !== "experiment.metric" || event.aggregateId !== runId) {
          continue;
        }
        const sample = coerceSample(event.payload as Record<string, unknown>);
        if (sample !== null) {
          add(sample, order);
          order += 1;
        }
      }
    }

    const grouped = new Map<string, Series>();
    let insertion = 0;
    for (const sample of merged.values()) {
      const key = `${sample.name}::${sample.split}`;
      let entry = grouped.get(key);
      if (entry === undefined) {
        entry = { key, name: sample.name, split: sample.split, points: [] };
        grouped.set(key, entry);
      }
      entry.points.push({ x: sample.step ?? sample.t ?? insertion, y: sample.value, step: sample.step });
      insertion += 1;
    }

    const all = [...grouped.values()];
    const primaryKey = resolvePrimaryKey(all, primaryName, primarySplit);
    all.sort((a, b) => compareSeriesForDisplay(a, b, primaryKey));

    const kept = all.slice(0, MAX_SERIES);
    const hiddenCount = Math.max(0, all.length - kept.length);
    const keptPrimaryIdx = primaryKey !== null ? kept.findIndex((entry) => entry.key === primaryKey) : -1;

    for (let idx = 0; idx < kept.length; idx += 1) {
      const entry = kept[idx];
      entry.points.sort((p, q) => p.x - q.x);
      if (entry.points.length > MAX_POINTS) {
        const bestIdx =
          idx === keptPrimaryIdx ? bestIndexByGoal(entry.points, resolveGoal(entry.name, primaryGoal)) : -1;
        const stride = Math.ceil(entry.points.length / MAX_POINTS);
        entry.points = entry.points.filter(
          (_, i) => i % stride === 0 || i === entry.points.length - 1 || i === bestIdx,
        );
        entry.decimated = true;
      }
    }
    return { series: kept, primaryIndex: keptPrimaryIdx, hiddenCount };
  }, [events, runId, recoveredSamples, primaryName, primarySplit, primaryGoal]);

  const hasData = series.some((entry) => entry.points.length > 0);
  if (!hasData) {
    return <div className="ml-chart-empty">Waiting for metrics…</div>;
  }

  const primaryKey = primaryIndex >= 0 ? series[primaryIndex].key : null;
  const axes = assignAxes(series, primaryKey);
  const leftAxes = axes.filter((axis) => axis.side === "left").sort((a, b) => a.depth - b.depth);
  const rightAxes = axes.filter((axis) => axis.side === "right").sort((a, b) => a.depth - b.depth);

  const colorOfKey = (key: string): string => {
    const idx = series.findIndex((entry) => entry.key === key);
    return SERIES_COLORS[(idx < 0 ? 0 : idx) % SERIES_COLORS.length];
  };
  const leadOf = (axis: ChartAxis): Series | null => series.find((entry) => entry.key === axis.leadKey) ?? null;

  const width = 480;
  const AXIS_COL_W = 40; // per-axis gutter: room for a vertical caption + top/bottom tick numbers
  const padL = 12 + Math.max(1, leftAxes.length) * AXIS_COL_W;
  const padR = 12 + rightAxes.length * AXIS_COL_W;
  const padT = 10;
  const padB = 22;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  let xMin = Infinity;
  let xMax = -Infinity;
  for (const entry of series) {
    for (const point of entry.points) {
      if (point.x < xMin) xMin = point.x;
      if (point.x > xMax) xMax = point.x;
    }
  }
  if (!Number.isFinite(xMin)) {
    xMin = 0;
    xMax = 1;
  }
  if (xMin === xMax) xMax = xMin + 1;

  const axisX = (axis: ChartAxis): number =>
    axis.side === "left" ? padL - axis.depth * AXIS_COL_W : width - padR + axis.depth * AXIS_COL_W;
  const rangeOf = (axis: ChartAxis): number => axis.bounds.max - axis.bounds.min;
  const sx = (x: number): number => padL + ((x - xMin) / (xMax - xMin)) * innerW;
  const syForAxis = (axis: ChartAxis) => {
    if (axis.scale === "log") {
      const lo = Math.log10(Math.max(axis.bounds.min, 1e-9));
      const hi = Math.log10(Math.max(axis.bounds.max, 1e-9));
      const span = hi - lo || 1;
      return (y: number): number => {
        const ly = Math.log10(Math.max(y, axis.bounds.min, 1e-9));
        return padT + (1 - (ly - lo) / span) * innerH;
      };
    }
    return (y: number): number =>
      padT + (1 - (y - axis.bounds.min) / (axis.bounds.max - axis.bounds.min || 1)) * innerH;
  };
  const primaryAxis = axes[0] ?? null;
  const syForEntry = (entry: Series) => {
    const axis = axisForKey(axes, entry.key) ?? primaryAxis;
    return axis !== null ? syForAxis(axis) : (y: number): number => padT + (1 - y) * innerH;
  };
  const formatAxisTick = (axis: ChartAxis, value: number): string =>
    Math.abs(axis.bounds.max) >= 1000
      ? formatSecondaryTick(value, rangeOf(axis), axis.bounds.max)
      : formatTick(value, rangeOf(axis));

  const primaryEntry = primaryIndex >= 0 ? series[primaryIndex] : null;
  const primaryGoalResolved = primaryEntry !== null ? resolveGoal(primaryEntry.name, primaryGoal) : "max";
  const primaryBest =
    primaryEntry !== null
      ? (() => {
          const i = bestIndexByGoal(primaryEntry.points, primaryGoalResolved);
          return i >= 0 ? primaryEntry.points[i] : null;
        })()
      : null;
  const primaryEvalCount = primaryEntry !== null ? primaryEntry.points.length : 0;
  const showBestMarker =
    primaryBest !== null && primaryEntry !== null && distinctValueCount(primaryEntry.points) >= MIN_BEST_DISTINCT;
  const primaryColor = primaryIndex >= 0 ? SERIES_COLORS[primaryIndex % SERIES_COLORS.length] : SERIES_COLORS[0];
  const syPrimary =
    primaryEntry !== null
      ? syForEntry(primaryEntry)
      : primaryAxis !== null
        ? syForAxis(primaryAxis)
        : (y: number): number => padT + (1 - y) * innerH;
  const evalNote = primaryEvalCount > 0 && primaryEvalCount <= SPARSE_THRESHOLD ? ` (${primaryEvalCount} evals)` : "";

  const handleHover = (event: React.MouseEvent<SVGSVGElement>): void => {
    const svg = svgRef.current;
    if (svg === null) {
      return;
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) {
      return;
    }
    const svgX = ((event.clientX - rect.left) * width) / rect.width;
    const clampedX = Math.min(width - padR, Math.max(padL, svgX));
    const dataX = xMin + ((clampedX - padL) / (innerW || 1)) * (xMax - xMin);
    const snapped = snapToSampleX(series, dataX);
    setHoverX(snapped);
  };

  const hoverRows =
    hoverX === null
      ? []
      : series
          .map((entry, index) => {
            const point = nearestPointForX(entry.points, hoverX);
            if (point === null) {
              return null;
            }
            const axis = axisForKey(axes, entry.key) ?? primaryAxis;
            const value =
              axis !== null && Math.abs(axis.bounds.max) >= 1000
                ? formatAxisTick(axis, point.y)
                : point.y.toFixed(4);
            return { entry, index, point, value };
          })
          .filter((row): row is { entry: Series; index: number; point: { x: number; y: number; step: number | null }; value: string } => row !== null);
  const hoverStep = hoverRows.length > 0 ? hoverRows[0].point.step : null;
  const hoverLineX = hoverX !== null && hoverRows.length > 0 ? sx(hoverX) : null;

  return (
    <div className="ml-metric-chart">
      <svg
        ref={svgRef}
        className="ml-chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Training metrics"
        onMouseMove={handleHover}
        onMouseLeave={() => setHoverX(null)}
      >
        {/* Neutral horizontal gridlines (each axis prints its own value against them). */}
        {[0, 0.5, 1].map((fraction) => {
          const y = padT + fraction * innerH;
          return <line key={fraction} className="ml-chart-grid" x1={padL} y1={y} x2={width - padR} y2={y} />;
        })}
        {/* One colored, labelled Y-axis per scale group: vertical line, top/bottom tick numbers, and a
            rotated caption naming the lead metric — so each set of numbers declares which curve it scales. */}
        {axes.map((axis) => {
          const x = axisX(axis);
          const color = colorOfKey(axis.leadKey);
          const lead = leadOf(axis);
          const tickAnchor = axis.side === "left" ? "end" : "start";
          const tickX = axis.side === "left" ? x - 4 : x + 4;
          const captionX = axis.side === "left" ? x - (AXIS_COL_W - 12) : x + (AXIS_COL_W - 12);
          const rotation = axis.side === "left" ? -90 : 90;
          return (
            <g key={axis.id}>
              <line className="ml-chart-axis" x1={x} y1={padT} x2={x} y2={padT + innerH} />
              <text className="ml-chart-label" x={tickX} y={padT + 8} textAnchor={tickAnchor} style={{ fill: color }}>
                {formatAxisTick(axis, axis.bounds.max)}
              </text>
              <text
                className="ml-chart-label"
                x={tickX}
                y={padT + innerH - 2}
                textAnchor={tickAnchor}
                style={{ fill: color }}
              >
                {formatAxisTick(axis, axis.bounds.min)}
              </text>
              {lead !== null ? (
                <text
                  className="ml-chart-axis-caption"
                  transform={`translate(${captionX} ${padT + innerH / 2}) rotate(${rotation})`}
                  textAnchor="middle"
                  style={{ fill: color }}
                >
                  {lead.name}{axis.scale === "log" ? " (log)" : ""}{axis.merged ? " +" : ""}
                </text>
              ) : null}
            </g>
          );
        })}
        <line className="ml-chart-axis" x1={padL} y1={padT + innerH} x2={width - padR} y2={padT + innerH} />
        {series.map((entry, index) => {
          const sy = syForEntry(entry);
          const color = SERIES_COLORS[index % SERIES_COLORS.length];
          const sparse = entry.points.length <= SPARSE_THRESHOLD;
          return (
            <g key={entry.key}>
              {entry.points.length > 1 ? (
                <polyline
                  className="ml-chart-line"
                  fill="none"
                  stroke={color}
                  points={entry.points.map((point) => `${sx(point.x).toFixed(1)},${sy(point.y).toFixed(1)}`).join(" ")}
                />
              ) : null}
              {sparse
                ? entry.points.map((point, pointIndex) => (
                    <circle
                      key={pointIndex}
                      className="ml-chart-point"
                      cx={sx(point.x).toFixed(1)}
                      cy={sy(point.y).toFixed(1)}
                      r={2.5}
                      fill={color}
                    />
                  ))
                : null}
            </g>
          );
        })}
        {showBestMarker && primaryBest !== null
          ? (() => {
              const bx = sx(primaryBest.x);
              const by = syPrimary(primaryBest.y);
              const labelY = Math.max(padT + 9, by - 8);
              const anchor = bx > width - padR - 64 ? "end" : bx < padL + 64 ? "start" : "middle";
              const stepLabel = primaryBest.step !== null ? ` @ step ${primaryBest.step}` : "";
              return (
                <g>
                  <line
                    x1={bx}
                    y1={padT}
                    x2={bx}
                    y2={padT + innerH}
                    stroke={primaryColor}
                    strokeOpacity={0.35}
                    strokeDasharray="3 3"
                  />
                  <circle cx={bx} cy={by} r={4.5} fill={primaryColor} stroke="#ffffff" strokeWidth={1.5} />
                  <text className="ml-chart-label" style={{ fontWeight: 600, fill: primaryColor }} x={bx} y={labelY} textAnchor={anchor}>
                    best {primaryBest.y.toFixed(3)}{stepLabel}{evalNote}
                  </text>
                </g>
              );
            })()
          : null}
        {/* Transparent capture rect over the plot so pointer moves register even off the curves. */}
        <rect x={padL} y={padT} width={innerW} height={innerH} fill="transparent" pointerEvents="all" />
        {/* Hover crosshair + value tooltip (pointer-events disabled so it never eats its own moves). */}
        {hoverLineX !== null && hoverRows.length > 0
          ? (() => {
              const rowH = 13;
              const longest = hoverRows.reduce((max, row) => {
                const label = `${row.entry.name}${row.entry.split !== "n/a" ? ` (${row.entry.split})` : ""}: ${row.value}`;
                return Math.max(max, label.length);
              }, `step ${hoverStep ?? "—"}`.length);
              const boxW = Math.min(220, Math.max(96, 24 + longest * 5.1));
              const boxH = 10 + (hoverRows.length + 1) * rowH;
              const flip = hoverLineX > width - padR - boxW - 10;
              const boxX = Math.max(2, Math.min(width - boxW - 2, flip ? hoverLineX - 10 - boxW : hoverLineX + 10));
              const boxY = Math.max(padT, Math.min(padT + 2, height - padB - boxH));
              return (
                <g pointerEvents="none">
                  <line className="ml-chart-hover-line" x1={hoverLineX} y1={padT} x2={hoverLineX} y2={padT + innerH} />
                  {hoverRows.map((row) => {
                    const color = SERIES_COLORS[row.index % SERIES_COLORS.length];
                    const cy = syForEntry(row.entry)(row.point.y);
                    return (
                      <circle
                        key={`dot-${row.entry.key}`}
                        className="ml-chart-hover-dot"
                        cx={sx(row.point.x).toFixed(1)}
                        cy={cy.toFixed(1)}
                        r={3.5}
                        fill={color}
                      />
                    );
                  })}
                  <rect className="ml-chart-tooltip-bg" x={boxX} y={boxY} width={boxW} height={boxH} rx={4} />
                  <text className="ml-chart-tooltip-text" x={boxX + 8} y={boxY + 13} style={{ fontWeight: 600 }}>
                    step {hoverStep ?? "—"}
                  </text>
                  {hoverRows.map((row, rowIndex) => {
                    const color = SERIES_COLORS[row.index % SERIES_COLORS.length];
                    const rowY = boxY + 13 + (rowIndex + 1) * rowH;
                    const label = `${row.entry.name}${row.entry.split !== "n/a" ? ` (${row.entry.split})` : ""}: ${row.value}`;
                    return (
                      <g key={`row-${row.entry.key}`}>
                        <rect x={boxX + 8} y={rowY - 7} width={7} height={7} rx={1} fill={color} />
                        <text className="ml-chart-tooltip-text" x={boxX + 19} y={rowY}>
                          {label}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })()
          : null}
      </svg>
      <div className="ml-chart-legend">
        {series.map((entry, index) => {
          const isPrimary = index === primaryIndex;
          const last = entry.points[entry.points.length - 1];
          const shown = isPrimary && showBestMarker && primaryBest !== null ? primaryBest.y : last?.y;
          const sparseNote =
            entry.points.length <= SPARSE_THRESHOLD
              ? ` · ${entry.points.length} eval${entry.points.length === 1 ? "" : "s"}`
              : "";
          const seriesAxis = axisForKey(axes, entry.key);
          const axisLead = seriesAxis !== null ? leadOf(seriesAxis) : null;
          const onSecondaryAxis = seriesAxis !== null && primaryAxis !== null && seriesAxis !== primaryAxis;
          const axisNote =
            onSecondaryAxis && axisLead !== null ? ` · ${axisLead.name} axis (${seriesAxis.side})` : "";
          return (
            <span key={entry.key} className="ml-chart-legend-item">
              <span className="ml-chart-swatch" style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }} />
              {entry.name}{entry.split !== "n/a" ? ` (${entry.split})` : ""}: <strong>{shown !== undefined ? shown.toFixed(4) : "—"}</strong>
              {axisNote ? <span className="muted">{axisNote}</span> : null}
              {seriesAxis?.merged ? <span className="muted"> · merged axis</span> : null}
              {isPrimary && showBestMarker ? <span className="muted"> · best</span> : null}
              {entry.decimated ? <span className="muted"> · sampled</span> : null}
              {sparseNote ? <span className="muted">{sparseNote}</span> : null}
            </span>
          );
        })}
        {hiddenCount > 0 ? (
          <span className="ml-chart-legend-item muted">+{hiddenCount} more series hidden</span>
        ) : null}
      </div>
    </div>
  );
}
