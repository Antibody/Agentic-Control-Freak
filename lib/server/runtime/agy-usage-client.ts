import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";


const HOSTS = ["https://cloudcode-pa.googleapis.com", "https://daily-cloudcode-pa.googleapis.com"];
const METHODS = ["retrieveUserQuotaSummary", "loadCodeAssist"];

export interface AgyQuotaWindow {
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface AgyQuotaBucket {
  label: string;
  windows: AgyQuotaWindow[];
  creditsBalance: string | null;
}

export interface AgyUsageSnapshot {
  tier: string | null;
  buckets: AgyQuotaBucket[];
  fetchedAt: string;
}

function credentialsPath(): string {
  return path.join(os.homedir(), ".gemini", "oauth_creds.json");
}

async function readAccessToken(): Promise<string | null> {
  try {
    const raw = await readFile(credentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as { access_token?: unknown; expiry_date?: unknown };
    const token = parsed.access_token;
    if (typeof token !== "string" || token.trim().length === 0) {
      return null;
    }
    if (typeof parsed.expiry_date === "number" && parsed.expiry_date > 0 && parsed.expiry_date < Date.now()) {
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function toIso(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "number" && value > 0) {
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function extractBuckets(node: unknown, keyHint: string | null, out: AgyQuotaBucket[], depth: number): void {
  if (depth > 6) return;
  if (Array.isArray(node)) {
    for (const entry of node) extractBuckets(entry, keyHint, out, depth + 1);
    return;
  }
  const record = asRecord(node);
  if (record === null) return;

  const percent = firstNumber(record, ["usedPercent", "utilization", "percentUsed", "usagePercent"]);
  const used = firstNumber(record, ["used", "usedCount", "consumed", "usedCredits"]);
  const limit = firstNumber(record, ["limit", "total", "max", "quota", "monthlyLimit"]);
  const resetsAt = toIso(record.resets_at ?? record.resetsAt ?? record.resetTime ?? record.nextResetTime);
  const label = firstString(record, ["name", "displayName", "id", "label", "limitName"]) ?? keyHint ?? "quota";

  let usedPercent: number | null = null;
  if (percent !== null) {
    usedPercent = Math.max(0, Math.min(100, percent <= 1 ? percent * 100 : percent));
  } else if (used !== null && limit !== null && limit > 0) {
    usedPercent = Math.max(0, Math.min(100, (used / limit) * 100));
  }

  if (usedPercent !== null) {
    out.push({
      label,
      windows: [{ label: resetsAt !== null ? "window" : label, usedPercent, resetsAt }],
      creditsBalance: limit !== null && used !== null ? String(Math.max(0, limit - used)) : null,
    });
    return;
  }

  for (const [key, value] of Object.entries(record)) {
    extractBuckets(value, key, out, depth + 1);
  }
}

const snapshotTtlMs = 60 * 1000;
let snapshotCache: { expiresAt: number; snapshot: AgyUsageSnapshot } | null = null;

export async function readAgyUsage(input: { timeoutMs?: number; forceRefresh?: boolean } = {}): Promise<AgyUsageSnapshot | null> {
  const now = Date.now();
  if (input.forceRefresh !== true && snapshotCache !== null && snapshotCache.expiresAt > now) {
    return snapshotCache.snapshot;
  }
  const token = await readAccessToken();
  if (token === null) {
    return null;
  }

  for (const host of HOSTS) {
    for (const method of METHODS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 6000);
      try {
        const response = await fetch(`${host}/v1internal:${method}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ metadata: { pluginType: "GEMINI" } }),
          signal: controller.signal,
        });
        if (!response.ok) {
          continue;
        }
        const json = (await response.json()) as unknown;
        const root = asRecord(json);
        if (root === null) {
          continue;
        }
        const buckets: AgyQuotaBucket[] = [];
        extractBuckets(json, null, buckets, 0);
        const tier = firstString(asRecord(root.currentTier) ?? {}, ["name", "displayName", "id"])
          ?? firstString(root, ["tier", "tierName"]);
        if (buckets.length === 0 && tier === null) {
          continue;
        }
        const snapshot: AgyUsageSnapshot = { tier, buckets, fetchedAt: new Date().toISOString() };
        snapshotCache = { expiresAt: now + snapshotTtlMs, snapshot };
        return snapshot;
      } catch {
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  return null;
}
