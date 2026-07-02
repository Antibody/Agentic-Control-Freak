import { spawn } from "node:child_process";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolveCodexCliBin } from "@/lib/server/runtime/codex-cli-resolver";
import { isWindowsBatchCommand, windowsBatchSpawnTarget, type SpawnTarget } from "@/lib/server/runtime/windows-command";


export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimitBucket {
  limitId: string;
  limitName: string | null;
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  creditsBalance: string | null;
}

export interface CodexRateLimitSnapshot {
  primaryBucket: CodexRateLimitBucket | null;
  buckets: CodexRateLimitBucket[];
  fetchedAt: string;
}

function spawnTargetFor(command: string, args: string[]): SpawnTarget {
  if (process.platform === "win32" && isWindowsBatchCommand(command)) {
    return windowsBatchSpawnTarget(command, args);
  }
  return { command, args };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseWindow(value: unknown): CodexRateLimitWindow | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const usedPercent = numberOrNull(candidate.usedPercent);
  if (usedPercent === null) {
    return null;
  }
  return {
    usedPercent,
    windowDurationMins: numberOrNull(candidate.windowDurationMins),
    resetsAt: numberOrNull(candidate.resetsAt),
  };
}

function parseBucket(limitId: string, value: unknown): CodexRateLimitBucket | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const credits = typeof candidate.credits === "object" && candidate.credits !== null
    ? (candidate.credits as Record<string, unknown>)
    : null;
  const balance = credits !== null && typeof credits.balance === "string" ? credits.balance : null;
  return {
    limitId,
    limitName: typeof candidate.limitName === "string" ? candidate.limitName : null,
    planType: typeof candidate.planType === "string" ? candidate.planType : null,
    primary: parseWindow(candidate.primary),
    secondary: parseWindow(candidate.secondary),
    creditsBalance: balance,
  };
}

function parseRateLimitsResult(result: unknown): CodexRateLimitSnapshot {
  const root = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  const primaryRaw = root.rateLimits;
  const primaryLimitId = typeof primaryRaw === "object" && primaryRaw !== null && typeof (primaryRaw as Record<string, unknown>).limitId === "string"
    ? (primaryRaw as Record<string, unknown>).limitId as string
    : "codex";
  const primaryBucket = parseBucket(primaryLimitId, primaryRaw);

  const byId = typeof root.rateLimitsByLimitId === "object" && root.rateLimitsByLimitId !== null
    ? (root.rateLimitsByLimitId as Record<string, unknown>)
    : {};
  const buckets: CodexRateLimitBucket[] = [];
  for (const [limitId, value] of Object.entries(byId)) {
    const bucket = parseBucket(limitId, value);
    if (bucket !== null) {
      buckets.push(bucket);
    }
  }
  if (buckets.length === 0 && primaryBucket !== null) {
    buckets.push(primaryBucket);
  }
  return { primaryBucket, buckets, fetchedAt: new Date().toISOString() };
}

const snapshotTtlMs = 60 * 1000;
let snapshotCache: { expiresAt: number; snapshot: CodexRateLimitSnapshot } | null = null;

export async function readCodexRateLimits(input: { timeoutMs?: number; forceRefresh?: boolean } = {}): Promise<CodexRateLimitSnapshot | null> {
  const now = Date.now();
  if (input.forceRefresh !== true && snapshotCache !== null && snapshotCache.expiresAt > now) {
    return snapshotCache.snapshot;
  }
  const result = await readCodexRateLimitsUncached(input);
  if (result !== null) {
    snapshotCache = { expiresAt: now + snapshotTtlMs, snapshot: result };
  }
  return result;
}

async function readCodexRateLimitsUncached(input: { timeoutMs?: number } = {}): Promise<CodexRateLimitSnapshot | null> {
  const timeoutMs = input.timeoutMs ?? 8000;
  let executable;
  try {
    executable = await resolveCodexCliBin();
  } catch {
    return null;
  }
  const target = spawnTargetFor(executable.command, ["app-server"]);

  return new Promise<CodexRateLimitSnapshot | null>((resolve) => {
    let settled = false;
    const finish = (value: CodexRateLimitSnapshot | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
      }
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(target.command, target.args, {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
        windowsVerbatimArguments: target.windowsVerbatimArguments,
        env: createSanitizedProcessEnv({ CI: "true" }) as NodeJS.ProcessEnv,
      });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => finish(null), timeoutMs);

    let buffer = "";
    let initialized = false;
    const send = (message: unknown): void => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(null);
      }
    };

    child.on("error", () => finish(null));
    child.on("close", () => finish(null));

    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length === 0) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.id === 1 && !initialized) {
          initialized = true;
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
          continue;
        }
        if (message.id === 2) {
          if (typeof message.error === "object" && message.error !== null) {
            finish(null);
            return;
          }
          finish(parseRateLimitsResult(message.result));
          return;
        }
      }
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "closed-loop", title: "closed-loop runtime status", version: "0.0.0" } },
    });
  });
}
