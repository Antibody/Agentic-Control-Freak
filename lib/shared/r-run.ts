import type { RFigureFormat, RRunParams } from "@/lib/shared/types";

export { parseArgvLine, parseEnvLines, envToLines } from "@/lib/shared/python-run";

export const rFigureFormats: RFigureFormat[] = ["png", "svg", "jpeg", "pdf"];

export function emptyRRunParams(): RRunParams {
  return {
    entrypoint: null,
    argv: [],
    stdin: "",
    env: {},
    graphics: { dpi: null, format: null, width: null, height: null },
  };
}

function asFigureFormat(value: unknown): RFigureFormat | null {
  return typeof value === "string" && (rFigureFormats as string[]).includes(value) ? (value as RFigureFormat) : null;
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

export function normalizeRRunParams(input: unknown): RRunParams {
  const params = emptyRRunParams();
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

  if (typeof candidate.graphics === "object" && candidate.graphics !== null) {
    const graphics = candidate.graphics as Record<string, unknown>;
    params.graphics.dpi = asPositiveNumber(graphics.dpi);
    params.graphics.format = asFigureFormat(graphics.format);
    params.graphics.width = asPositiveNumber(graphics.width);
    params.graphics.height = asPositiveNumber(graphics.height);
  }

  return params;
}

export function isRRunParamsEmpty(params: RRunParams): boolean {
  return (
    params.entrypoint === null &&
    params.argv.length === 0 &&
    params.stdin.length === 0 &&
    Object.keys(params.env).length === 0 &&
    params.graphics.dpi === null &&
    params.graphics.format === null &&
    params.graphics.width === null &&
    params.graphics.height === null
  );
}
