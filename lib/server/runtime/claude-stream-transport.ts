import { spawn } from "node:child_process";
import { isWindowsBatchCommand, windowsBatchSpawnTarget, type SpawnTarget } from "@/lib/server/runtime/windows-command";
import type { ProcessEnvironment, ProcessProgressHandlers, ProcessResult } from "@/lib/server/runtime/process-runner";
import { logProcess } from "@/lib/server/logging";


const INTERRUPT_GRACE_MS = 15_000;
const RESULT_CLOSE_GRACE_MS = 10_000;
const STEER_ACK_TIMEOUT_MS = 10_000;

export class ClaudeStreamStartupError extends Error {}

export type ClaudeStreamTurnStatus = "starting" | "running" | "finalizing" | "closed";

export interface ClaudeStreamTurnHandle {
  result: Promise<ProcessResult>;
  steer: (text: string) => Promise<{ ok: boolean; message: string }>;
  interrupt: (kind: "abort" | "timeout") => void;
  status: () => ClaudeStreamTurnStatus;
  pid: number | null;
}

function createSpawnTarget(command: string, args: string[]): SpawnTarget {
  if (process.platform === "win32" && isWindowsBatchCommand(command)) {
    return windowsBatchSpawnTarget(command, args);
  }
  return { command, args };
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      try { child.kill(); } catch { /* ignore */ }
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
  }
  setTimeout(() => {
    try { process.kill(-pid, "SIGKILL"); } catch {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }, 2000);
}

function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

export function startClaudeStreamTurn(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: ProcessEnvironment;
  prompt: string;
  progress?: ProcessProgressHandlers;
}): ClaudeStreamTurnHandle {
  const spawnTarget = createSpawnTarget(input.command, input.args);
  const child = spawn(spawnTarget.command, spawnTarget.args, {
    cwd: input.cwd,
    env: (input.env ?? process.env) as NodeJS.ProcessEnv,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
    windowsHide: true,
  });

  let stdout = "";
  let stderr = "";
  let lineBuffer = "";
  let status: ClaudeStreamTurnStatus = "starting";
  let sawAnyOutput = false;
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let resultSeen = false;
  let escalation: ReturnType<typeof setTimeout> | null = null;
  const pendingSteerAcks = new Map<string, (ok: boolean) => void>();

  let resolveResult: (result: ProcessResult) => void;
  let rejectResult: (error: Error) => void;
  const result = new Promise<ProcessResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  input.progress?.onStart?.(child.pid ?? null);

  function settle(processResult: ProcessResult): void {
    if (settled) return;
    settled = true;
    status = "closed";
    clearTimeout(turnTimeout);
    if (escalation !== null) clearTimeout(escalation);
    for (const ack of pendingSteerAcks.values()) ack(false);
    pendingSteerAcks.clear();
    input.progress?.onExit?.(processResult);
    resolveResult(processResult);
  }

  function fail(error: Error): void {
    if (settled) return;
    settled = true;
    status = "closed";
    clearTimeout(turnTimeout);
    if (escalation !== null) clearTimeout(escalation);
    for (const ack of pendingSteerAcks.values()) ack(false);
    pendingSteerAcks.clear();
    rejectResult(error);
  }

  function writeLine(line: string): boolean {
    if (settled || child.stdin === null || child.stdin.destroyed) return false;
    try {
      child.stdin.write(line);
      return true;
    } catch {
      return false;
    }
  }

  function sendInterrupt(kind: "abort" | "timeout"): void {
    if (settled || status === "finalizing") return;
    if (kind === "abort") aborted = true;
    else timedOut = true;
    const requestId = `orch-int-${Date.now()}`;
    const sent = writeLine(`${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`);
    logProcess("info", "claude_stream.interrupt.sent", { kind, requestId, delivered: sent, pid: child.pid ?? 0 });
    if (!sent) {
      killProcessTree(child);
      settle({ exitCode: null, stdout, stderr, timedOut, aborted });
      return;
    }
    try { child.stdin?.end(); } catch { /* ignore */ }
    if (escalation === null) {
      escalation = setTimeout(() => {
        logProcess("warn", "claude_stream.interrupt.escalated", { kind, pid: child.pid ?? 0 });
        killProcessTree(child);
        settle({ exitCode: null, stdout, stderr, timedOut, aborted });
      }, INTERRUPT_GRACE_MS);
    }
  }

  const turnTimeout = setTimeout(() => sendInterrupt("timeout"), input.timeoutMs);

  function handleEventLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "user") {
      const content = (event.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const record = block as { type?: string; text?: string };
          if (record.type === "text" && typeof record.text === "string") {
            const ack = pendingSteerAcks.get(record.text);
            if (ack !== undefined) {
              pendingSteerAcks.delete(record.text);
              ack(true);
            }
          }
        }
      }
      return;
    }
    if (type === "result") {
      resultSeen = true;
      status = "finalizing";
      try { child.stdin?.end(); } catch { /* ignore */ }
      if (escalation === null) {
        escalation = setTimeout(() => {
          logProcess("warn", "claude_stream.close.escalated", { pid: child.pid ?? 0 });
          killProcessTree(child);
          settle({ exitCode: null, stdout, stderr, timedOut, aborted });
        }, RESULT_CLOSE_GRACE_MS);
      }
    }
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    if (!sawAnyOutput) {
      sawAnyOutput = true;
      if (status === "starting") status = "running";
    }
    input.progress?.onStdout?.(text);
    lineBuffer += text;
    let newlineIndex: number;
    while ((newlineIndex = lineBuffer.indexOf("\n")) >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).trim();
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0 && line[0] === "{") handleEventLine(line);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    input.progress?.onStderr?.(text);
  });

  child.on("error", (error) => {
    if (!sawAnyOutput) {
      logProcess("warn", "claude_stream.startup.failed", { message: error.message, command: spawnTarget.command });
      fail(new ClaudeStreamStartupError(`Claude stream transport failed to start: ${error.message}`));
      return;
    }
    settle({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut, aborted });
  });

  child.stdin?.on("error", () => undefined);

  child.on("close", (code) => {
    if (!sawAnyOutput && code !== 0 && !aborted && !timedOut) {
      fail(new ClaudeStreamStartupError(`Claude stream transport exited with code ${code === null ? "unknown" : String(code)} before producing output. Stderr: ${stderr.slice(0, 400)}`));
      return;
    }
    settle({ exitCode: code, stdout, stderr, timedOut, aborted });
  });

  writeLine(userMessageLine(input.prompt));

  return {
    result,
    pid: child.pid ?? null,
    status: () => status,
    steer: (text: string) => {
      if (settled || resultSeen || status !== "running") {
        return Promise.resolve({ ok: false, message: `Claude stream turn is not steerable (status: ${status}).` });
      }
      if (pendingSteerAcks.has(text)) {
        return Promise.resolve({ ok: false, message: "An identical steering message is already pending acknowledgement." });
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingSteerAcks.delete(text);
          resolve({ ok: false, message: "Steering was written to the Claude turn but not acknowledged in time; it will be re-delivered at the next prompt boundary." });
        }, STEER_ACK_TIMEOUT_MS);
        pendingSteerAcks.set(text, (ok: boolean) => {
          clearTimeout(timer);
          resolve(ok
            ? { ok: true, message: "Live steering acknowledged by the running Claude turn." }
            : { ok: false, message: "Claude turn ended before acknowledging the steering message." });
        });
        const sent = writeLine(userMessageLine(text));
        if (!sent) {
          clearTimeout(timer);
          pendingSteerAcks.delete(text);
          resolve({ ok: false, message: "Claude stream stdin is no longer writable." });
        }
      });
    },
    interrupt: (kind: "abort" | "timeout") => sendInterrupt(kind),
  };
}
