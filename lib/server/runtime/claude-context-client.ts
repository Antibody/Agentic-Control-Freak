import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolveClaudeCodeBin } from "@/lib/server/runtime/claude-code-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";
import type { RuntimeContextDetails } from "@/lib/shared/types";

export interface ClaudeContextSnapshot {
  usedTokens: number | null;
  contextWindow: number | null;
  remainingTokens: number | null;
  model: string | null;
  details: RuntimeContextDetails;
  fetchedAt: string;
}

interface CacheEntry {
  expiresAt: number;
  snapshot: ClaudeContextSnapshot | null;
}

const cacheTtlMs = 30 * 1000;
const cache = new Map<string, CacheEntry>();

export function clearClaudeContextCache(): void {
  cache.clear();
}

function parseTokenCount(value: string): number | null {
  const trimmed = value.trim().toLowerCase().replace(/,/g, "");
  const match = trimmed.match(/^([0-9]+(?:\.[0-9]+)?)([km])?$/);
  if (match === null) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const suffix = match[2] ?? "";
  if (suffix === "m") return Math.round(number * 1_000_000);
  if (suffix === "k") return Math.round(number * 1_000);
  return Math.round(number);
}

function parsePercent(value: string | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function stripContextGlyphs(line: string): string {
  return line
    .replace(/[\u26c0\u26c1\u26f6\u23bf]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCategory(line: string): { label: string; tokens: number | null; percent: number | null } | null {
  const cleaned = stripContextGlyphs(line);
  const match = cleaned.match(/^([^:]+):\s*([0-9][0-9.,]*\s*[km]?)\s+tokens(?:\s+\(([0-9.]+)%\))?/i);
  if (match === null) return null;
  return {
    label: match[1].trim(),
    tokens: parseTokenCount(match[2]),
    percent: parsePercent(match[3]),
  };
}

function parseReference(section: string, line: string): { section: string; label: string; tokens: number | null } | null {
  const cleaned = stripContextGlyphs(line).replace(/^[\u251c\u2514\u2502\u2500\s]+/, "").trim();
  if (cleaned.length === 0 || cleaned === section) return null;
  if (/^\|?[-|\s]+\|?$/.test(cleaned) || /^\|\s*(Tool|Type|Name|Path|Source|Skill)\b/i.test(cleaned)) {
    return null;
  }
  const match = cleaned.match(/^(.*?)(?::\s*| \s*)?(?:~\s*)?([0-9][0-9.,]*\s*[km]?|<\s*20)\s+tokens$/i);
  if (match === null) {
    return { section, label: cleaned, tokens: null };
  }
  return {
    section,
    label: match[1].trim(),
    tokens: match[2].includes("<") ? 20 : parseTokenCount(match[2]),
  };
}

function parseMarkdownTableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return null;
  }
  const cells = trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
  if (cells.length === 0 || cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
    return null;
  }
  return cells;
}

function parseMarkdownTokens(value: string): number | null {
  const normalized = value.replace(/^~\s*/, "").replace(/\s+tokens$/i, "").trim();
  if (/^<\s*20$/i.test(normalized)) {
    return 20;
  }
  return parseTokenCount(normalized);
}

function parseMarkdownPercent(value: string): number | null {
  return parsePercent(value.replace(/%$/, "").trim());
}

function referenceFromMarkdownRow(section: string, cells: string[]): { section: string; label: string; tokens: number | null } | null {
  if (cells.length < 2) {
    return null;
  }
  const headers = new Set(["tool", "type", "name", "path", "source", "skill"]);
  if (headers.has(cells[0].trim().toLowerCase())) {
    return null;
  }
  const tokenCell = cells[cells.length - 1];
  const tokens = parseMarkdownTokens(tokenCell);
  const labelCells = cells.slice(0, -1).filter((cell) => cell.trim().length > 0);
  if (labelCells.length === 0) {
    return null;
  }
  const label = section === "Memory Files" && labelCells.length >= 2
    ? labelCells.slice(1).join(" - ")
    : labelCells.join(" - ");
  return { section, label, tokens };
}

export function parseClaudeContextOutput(output: string): ClaudeContextSnapshot | null {
  const lines = output.split(/\r?\n/);
  let modelLabel: string | null = null;
  let modelSlug: string | null = null;
  let usedTokens: number | null = null;
  let contextWindow: number | null = null;
  let percentUsed: number | null = null;
  let freeTokens: number | null = null;
  const categories: RuntimeContextDetails["categories"] = [];
  const references: RuntimeContextDetails["references"] = [];
  let section: string | null = null;
  let inCategoryBlock = false;

  for (const raw of lines) {
    const cleaned = stripContextGlyphs(raw);
    if (cleaned.length === 0 || cleaned === "/context" || cleaned === "Context Usage" || cleaned === "## Context Usage") {
      continue;
    }

    const modelLine = cleaned.match(/^\*\*Model:\*\*\s*(.+?)\s*$/i);
    if (modelLine !== null) {
      modelLabel = modelLine[1].trim();
      if (/^claude-/i.test(modelLabel)) {
        modelSlug = modelLabel;
      }
      continue;
    }

    const usage = cleaned.match(/(?:^\*\*Tokens:\*\*\s*)?([0-9][0-9.,]*\s*[km]?)\s*\/\s*([0-9][0-9.,]*\s*[km]?)\s*(?:tokens)?\s+\(([0-9.]+)%\)/i);
    if (usage !== null) {
      usedTokens = parseTokenCount(usage[1]);
      contextWindow = parseTokenCount(usage[2]);
      percentUsed = parsePercent(usage[3]);
      continue;
    }

    const free = cleaned.match(/^Free space:\s*([0-9][0-9.,]*\s*[km]?)/i);
    if (free !== null) {
      freeTokens = parseTokenCount(free[1]);
      continue;
    }

    const heading = cleaned.match(/^#{2,4}\s+(.+?)\s*$/);
    if (heading !== null) {
      const title = heading[1].trim();
      if (/^Estimated usage by category$/i.test(title)) {
        section = null;
        inCategoryBlock = true;
        continue;
      }
      if (/^(MCP Tools|Memory Files|Skills)\b/i.test(title)) {
        section = title.replace(/\s*[·-].*$/, "").trim();
        inCategoryBlock = false;
        continue;
      }
    }

    if (/^Estimated usage by category$/i.test(cleaned)) {
      inCategoryBlock = true;
      continue;
    }

    if (/^(MCP tools|Memory files|Skills)\b/i.test(cleaned)) {
      section = cleaned.replace(/\s*[·-].*$/, "").trim();
      inCategoryBlock = false;
      continue;
    }

    const tableCells = parseMarkdownTableCells(raw);
    if (tableCells !== null) {
      if (inCategoryBlock && tableCells.length >= 3) {
        const label = tableCells[0];
        if (/^category$/i.test(label)) {
          continue;
        }
        const tokens = parseMarkdownTokens(tableCells[1]);
        const percent = parseMarkdownPercent(tableCells[2]);
        if (/^free space$/i.test(label)) {
          freeTokens = tokens;
        } else {
          categories.push({ label, tokens, percent });
        }
        continue;
      }
      if (section !== null) {
        const reference = referenceFromMarkdownRow(section, tableCells);
        if (reference !== null) {
          references.push(reference);
        }
        continue;
      }
    }

    if (section !== null) {
      const reference = parseReference(section, raw);
      if (reference !== null) {
        references.push(reference);
      }
      continue;
    }

    if (inCategoryBlock) {
      const category = parseCategory(raw);
      if (category !== null) {
        categories.push(category);
      }
      continue;
    }

    if (modelLabel === null) {
      modelLabel = cleaned;
      continue;
    }
    if (modelSlug === null && /^claude-/i.test(cleaned)) {
      modelSlug = cleaned;
    }
  }

  if (usedTokens === null && contextWindow === null && categories.length === 0) {
    return null;
  }

  const usedFromFreeSpace = contextWindow !== null && freeTokens !== null
    ? Math.max(0, contextWindow - freeTokens)
    : null;
  const usedFromCategories = categories.reduce((sum, category) => sum + (category.tokens ?? 0), 0);
  const resolvedUsedTokens = usedTokens === null || usedTokens === 0
    ? usedFromFreeSpace ?? (usedFromCategories > 0 ? usedFromCategories : usedTokens)
    : usedTokens;
  const resolvedPercentUsed = percentUsed === null || percentUsed === 0
    ? resolvedUsedTokens !== null && contextWindow !== null && contextWindow > 0
      ? Math.round((resolvedUsedTokens / contextWindow) * 1000) / 10
      : percentUsed
    : percentUsed;

  return {
    usedTokens: resolvedUsedTokens,
    contextWindow,
    remainingTokens: freeTokens ?? (resolvedUsedTokens !== null && contextWindow !== null ? Math.max(0, contextWindow - resolvedUsedTokens) : null),
    model: modelSlug ?? modelLabel,
    details: {
      source: "claude-context",
      modelLabel,
      modelSlug,
      percentUsed: resolvedPercentUsed,
      freeTokens,
      categories,
      references,
    },
    fetchedAt: new Date().toISOString(),
  };
}

export async function readClaudeContext(input: {
  cwd: string;
  sessionId: string;
  permissionMode: string;
  tools: string[];
  disallowedTools: string[];
  bare: boolean;
  model: string | null;
  effort: string | null;
  timeoutMs?: number;
  forceRefresh?: boolean;
}): Promise<ClaudeContextSnapshot | null> {
  const cacheKey = [
    input.cwd,
    input.sessionId,
    input.model ?? "",
    input.effort ?? "",
    input.permissionMode,
    input.bare ? "bare" : "full",
    input.tools.join(","),
    input.disallowedTools.join(","),
  ].join("\n");
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (input.forceRefresh !== true && cached !== undefined && cached.expiresAt > now) {
    return cached.snapshot;
  }

  const executable = await resolveClaudeCodeBin();
  const args = [
    "-p",
    "--input-format",
    "text",
    "--output-format",
    "text",
    "--resume",
    input.sessionId,
    "--fork-session",
    "--permission-mode",
    input.permissionMode,
    "--tools",
    input.tools.join(","),
  ];
  if (input.bare) {
    args.push("--bare");
  }
  if (input.disallowedTools.length > 0) {
    args.push("--disallowedTools", input.disallowedTools.join(","));
  }
  if (input.model !== null) {
    args.push("--model", input.model);
  }
  if (input.effort !== null) {
    args.push("--effort", input.effort);
  }
  const result = await runProcess({
    command: executable.command,
    args,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? 20_000,
    stdin: "/context",
    env: createSanitizedProcessEnv({ CI: "true", NEXT_TELEMETRY_DISABLED: "1" }),
  });

  const snapshot = result.exitCode === 0 && !result.timedOut
    ? parseClaudeContextOutput(`${result.stdout}\n${result.stderr}`)
    : null;
  cache.set(cacheKey, { expiresAt: now + cacheTtlMs, snapshot });
  return snapshot;
}
