import { spawn } from "node:child_process";
import { isWindowsBatchCommand, windowsBatchSpawnTarget, type SpawnTarget } from "@/lib/server/runtime/windows-command";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export type ProcessEnvironment = Record<string, string | undefined>;

const MAX_TIMER_DELAY_MS = 2147483647;

const MAX_CAPTURED_OUTPUT_CHARS = 8 * 1024 * 1024;

function appendCapped(buffer: string, text: string, marker: string): string {
  if (buffer.length >= MAX_CAPTURED_OUTPUT_CHARS) {
    return buffer;
  }
  const next = buffer + text;
  if (next.length <= MAX_CAPTURED_OUTPUT_CHARS) {
    return next;
  }
  return next.slice(0, MAX_CAPTURED_OUTPUT_CHARS) + marker;
}

export interface ProcessProgressHandlers {
  onStart?: (pid: number | null) => void;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (result: ProcessResult) => void;
}

function createSpawnCommand(command: string, args: string[]): SpawnTarget {
  if (process.platform !== "win32") {
    return { command, args };
  }

  if (isWindowsBatchCommand(command)) {
    return windowsBatchSpawnTarget(command, args);
  }

  return { command, args };
}

function renderSpawnTarget(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function killProcessTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      try {
        child.kill();
      } catch {
      }
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
      }
    }
  }, 2000);
}

export async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: ProcessEnvironment;
  stdin?: string;
  signal?: AbortSignal;
  progress?: ProcessProgressHandlers;
}): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    const env = input.env ?? process.env;
    const spawnTarget = createSpawnCommand(input.command, input.args);
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd: input.cwd,
      env: env as NodeJS.ProcessEnv,
      shell: false,
      stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsVerbatimArguments: spawnTarget.windowsVerbatimArguments,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    input.progress?.onStart?.(child.pid ?? null);

    const timeout = setTimeout(() => {
      if (!settled) {
        killProcessTree(child);
        settled = true;
        const result = { exitCode: null, stdout, stderr, timedOut: true, aborted: false };
        input.progress?.onExit?.(result);
        resolve(result);
      }
    }, Number.isFinite(input.timeoutMs) ? Math.min(Math.max(input.timeoutMs, 1), MAX_TIMER_DELAY_MS) : MAX_TIMER_DELAY_MS);

    const onAbort = (): void => {
      if (!settled) {
        clearTimeout(timeout);
        killProcessTree(child);
        settled = true;
        const result = { exitCode: null, stdout, stderr, timedOut: false, aborted: true };
        input.progress?.onExit?.(result);
        resolve(result);
      }
    };
    if (input.signal !== undefined) {
      if (input.signal.aborted) {
        onAbort();
      } else {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = appendCapped(stdout, text, "\n…[stdout truncated; exceeded capture cap]…");
      input.progress?.onStdout?.(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = appendCapped(stderr, text, "\n…[stderr truncated; exceeded capture cap]…");
      input.progress?.onStderr?.(text);
    });

    if (input.stdin !== undefined) {
      child.stdin?.end(input.stdin);
    }

    child.on("error", (error) => {
      if (!settled) {
        clearTimeout(timeout);
        settled = true;
        const target = renderSpawnTarget(spawnTarget.command, spawnTarget.args);
        const result = { exitCode: 1, stdout, stderr: `${stderr}\n${error.message}\nSpawn target: ${target}`.trim(), timedOut: false, aborted: false };
        input.progress?.onExit?.(result);
        resolve(result);
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        clearTimeout(timeout);
        settled = true;
        const result = { exitCode: code, stdout, stderr, timedOut: false, aborted: false };
        input.progress?.onExit?.(result);
        resolve(result);
      }
    });
  });
}

export async function runShellCommand(input: { command: string; cwd: string; timeoutMs: number; env?: ProcessEnvironment; signal?: AbortSignal; progress?: ProcessProgressHandlers }): Promise<ProcessResult> {
  const isWindows = process.platform === "win32";
  const command = isWindows ? "cmd.exe" : "/bin/sh";
  const args = isWindows ? ["/d", "/s", "/c", input.command] : ["-lc", input.command];
  return runProcess({ command, args, cwd: input.cwd, timeoutMs: input.timeoutMs, env: input.env, signal: input.signal, progress: input.progress });
}
