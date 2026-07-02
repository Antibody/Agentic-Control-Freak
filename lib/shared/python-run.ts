import type { PythonFigureFormat, PythonRunParams } from "@/lib/shared/types";

export const figureFormats: PythonFigureFormat[] = ["png", "svg", "jpeg"];

export function emptyPythonRunParams(): PythonRunParams {
  return {
    entrypoint: null,
    argv: [],
    stdin: "",
    env: {},
    matplotlib: { dpi: null, format: null, style: null },
  };
}

export function parseArgvLine(line: string): string[] {
  const tokens: string[] = [];
  const matches = line.match(/"[^"]*"|'[^']*'|\S+/g);
  if (matches === null) {
    return tokens;
  }
  for (const raw of matches) {
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      tokens.push(raw.slice(1, -1));
    } else {
      tokens.push(raw);
    }
  }
  return tokens;
}

export function parseEnvLines(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

export function envToLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function asFigureFormat(value: unknown): PythonFigureFormat | null {
  return typeof value === "string" && (figureFormats as string[]).includes(value) ? (value as PythonFigureFormat) : null;
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function normalizePythonRunParams(input: unknown): PythonRunParams {
  const params = emptyPythonRunParams();
  if (typeof input !== "object" || input === null) {
    return params;
  }
  const candidate = input as Record<string, unknown>;

  if (typeof candidate.entrypoint === "string" && candidate.entrypoint.trim().length > 0) {
    params.entrypoint = candidate.entrypoint.trim();
  }

  if (Array.isArray(candidate.argv)) {
    params.argv = candidate.argv.filter((value): value is string => typeof value === "string").map((value) => value);
  }

  if (typeof candidate.stdin === "string") {
    params.stdin = candidate.stdin;
  }

  if (typeof candidate.env === "object" && candidate.env !== null) {
    for (const [key, value] of Object.entries(candidate.env as Record<string, unknown>)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string") {
        params.env[key] = value;
      }
    }
  }

  if (typeof candidate.matplotlib === "object" && candidate.matplotlib !== null) {
    const mpl = candidate.matplotlib as Record<string, unknown>;
    params.matplotlib.dpi = asPositiveNumber(mpl.dpi);
    params.matplotlib.format = asFigureFormat(mpl.format);
    params.matplotlib.style = typeof mpl.style === "string" && mpl.style.trim().length > 0 ? mpl.style.trim() : null;
  }

  return params;
}

export function isPythonRunParamsEmpty(params: PythonRunParams): boolean {
  return (
    params.entrypoint === null &&
    params.argv.length === 0 &&
    params.stdin.length === 0 &&
    Object.keys(params.env).length === 0 &&
    params.matplotlib.dpi === null &&
    params.matplotlib.format === null &&
    params.matplotlib.style === null
  );
}
