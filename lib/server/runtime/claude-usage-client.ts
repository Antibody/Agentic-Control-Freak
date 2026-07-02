import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";


const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

export interface ClaudeUsageWindow {
  label: string;
  utilization: number;
  resetsAt: string | null;
  windowMinutes: number | null;
}

export interface ClaudeUsageBucket {
  label: string;
  windows: ClaudeUsageWindow[];
}

export interface ClaudeUsageSnapshot {
  subscription: ClaudeUsageBucket;
  perModel: ClaudeUsageBucket[];
  extraUsage: { enabled: boolean; monthlyLimit: number | null; usedCredits: number | null; currency: string | null } | null;
  fetchedAt: string;
}

function credentialsPath(): string {
  return path.join(os.homedir(), ".claude", ".credentials.json");
}

async function readAccessToken(): Promise<string | null> {
  try {
    const raw = await readFile(credentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    const oauth = parsed.claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== "string" || token.trim().length === 0) {
      return null;
    }
    if (typeof oauth?.expiresAt === "number" && oauth.expiresAt > 0 && oauth.expiresAt < Date.now()) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

function parseWindow(label: string, value: unknown, windowMinutes: number | null): ClaudeUsageWindow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const utilization = candidate.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return null;
  }
  const resetsAtRaw = candidate.resets_at;
  return {
    label,
    utilization: Math.max(0, Math.min(100, utilization)),
    resetsAt: typeof resetsAtRaw === "string" ? resetsAtRaw : null,
    windowMinutes,
  };
}

function prettyModelLabel(key: string): string {
  const name = key.replace(/^seven_day_/, "").replace(/_/g, " ");
  const titled = name.charAt(0).toUpperCase() + name.slice(1);
  return `${titled} (7d)`;
}

function parseSnapshot(root: Record<string, unknown>): ClaudeUsageSnapshot {
  const windows: ClaudeUsageWindow[] = [];
  const fiveHour = parseWindow("5h", root.five_hour, 300);
  const sevenDay = parseWindow("weekly", root.seven_day, 7 * 24 * 60);
  if (fiveHour !== null) windows.push(fiveHour);
  if (sevenDay !== null) windows.push(sevenDay);

  const perModel: ClaudeUsageBucket[] = [];
  for (const [key, value] of Object.entries(root)) {
    if (key === "seven_day" || !key.startsWith("seven_day_")) continue;
    const window = parseWindow("weekly", value, 7 * 24 * 60);
    if (window !== null) {
      perModel.push({ label: prettyModelLabel(key), windows: [window] });
    }
  }

  let extraUsage: ClaudeUsageSnapshot["extraUsage"] = null;
  if (typeof root.extra_usage === "object" && root.extra_usage !== null) {
    const eu = root.extra_usage as Record<string, unknown>;
    extraUsage = {
      enabled: eu.is_enabled === true,
      monthlyLimit: typeof eu.monthly_limit === "number" ? eu.monthly_limit : null,
      usedCredits: typeof eu.used_credits === "number" ? eu.used_credits : null,
      currency: typeof eu.currency === "string" ? eu.currency : null,
    };
  }

  return {
    subscription: { label: "Subscription", windows },
    perModel,
    extraUsage,
    fetchedAt: new Date().toISOString(),
  };
}

const snapshotTtlMs = 60 * 1000;
let snapshotCache: { expiresAt: number; snapshot: ClaudeUsageSnapshot } | null = null;

export async function readClaudeUsage(input: { timeoutMs?: number; forceRefresh?: boolean } = {}): Promise<ClaudeUsageSnapshot | null> {
  const now = Date.now();
  if (input.forceRefresh !== true && snapshotCache !== null && snapshotCache.expiresAt > now) {
    return snapshotCache.snapshot;
  }
  const token = await readAccessToken();
  if (token === null) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 8000);
  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        "anthropic-version": "2023-06-01",
        "User-Agent": "closed-loop-runtime-status",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const json = (await response.json()) as Record<string, unknown>;
    const snapshot = parseSnapshot(json);
    snapshotCache = { expiresAt: now + snapshotTtlMs, snapshot };
    return snapshot;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
