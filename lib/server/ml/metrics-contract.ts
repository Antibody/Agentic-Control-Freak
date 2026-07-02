export interface MetricSample {
  type: "metric";
  t: number | null;
  step: number | null;
  split: string;
  name: string;
  value: number;
  depth: number | null;
}

export interface PhaseBeacon {
  type: "phase";
  t: number | null;
  phase: string;
}

export type MetricLine = MetricSample | PhaseBeacon;

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseMetricLine(line: string): MetricLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;

  if (record.event === "phase" && typeof record.phase === "string") {
    return { type: "phase", t: asNumberOrNull(record.t), phase: record.phase };
  }

  const value = asNumberOrNull(record.value);
  if (typeof record.name === "string" && value !== null) {
    return {
      type: "metric",
      t: asNumberOrNull(record.t),
      step: asNumberOrNull(record.step),
      split: typeof record.split === "string" ? record.split : "train",
      name: record.name,
      value,
      depth: asNumberOrNull(record.depth),
    };
  }

  return null;
}

export function parseMetricLines(chunk: string): MetricLine[] {
  const lines: MetricLine[] = [];
  for (const raw of chunk.split(/\r?\n/)) {
    const parsed = parseMetricLine(raw);
    if (parsed !== null) {
      lines.push(parsed);
    }
  }
  return lines;
}
