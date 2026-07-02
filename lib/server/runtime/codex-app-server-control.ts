import { spawn } from "node:child_process";
import { resolveCodexCliBin } from "@/lib/server/runtime/codex-cli-resolver";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import type { ProcessEnvironment } from "@/lib/server/runtime/process-runner";
import { isWindowsBatchCommand, windowsBatchSpawnTarget } from "@/lib/server/runtime/windows-command";
import { asRecord, codexErrorMessage, decodeCodexAppServerLine } from "@/lib/server/runtime/codex-app-server-protocol";

export interface CodexAppServerControlClient {
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params?: Record<string, unknown>): void;
  waitForNotification(
    predicate: (notification: CodexAppServerNotification) => boolean,
    timeoutMs: number,
    description?: string,
  ): Promise<CodexAppServerNotification>;
  close(): void;
}

export class CodexAppServerControlError extends Error {}

export interface CodexAppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface CodexAppServerControlOptions {
  env?: ProcessEnvironment;
  configOverrides?: string[];
}

function spawnTargetFor(command: string, args: string[]) {
  if (process.platform === "win32" && isWindowsBatchCommand(command)) {
    return windowsBatchSpawnTarget(command, args);
  }
  return { command, args };
}

function appServerArgs(options: CodexAppServerControlOptions): string[] {
  const args = ["app-server"];
  for (const override of options.configOverrides ?? []) {
    args.push("-c", override);
  }
  return args;
}

export async function openCodexAppServerControlClient(cwd: string, options: CodexAppServerControlOptions = {}): Promise<CodexAppServerControlClient> {
  const executable = await resolveCodexCliBin();
  const target = spawnTargetFor(executable.command, appServerArgs(options));
  const child = spawn(target.command, target.args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: target.windowsVerbatimArguments,
    cwd,
    env: createSanitizedProcessEnv({
      CI: "true",
      NEXT_TELEMETRY_DISABLED: "1",
      ...options.env,
    }) as NodeJS.ProcessEnv,
  });

  let buffer = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const notifications: CodexAppServerNotification[] = [];
  const notificationWaiters = new Set<{
    predicate: (notification: CodexAppServerNotification) => boolean;
    resolve: (notification: CodexAppServerNotification) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    description: string;
  }>();

  const failAll = (message: string): void => {
    closed = true;
    for (const entry of pending.values()) {
      entry.reject(new CodexAppServerControlError(message));
    }
    pending.clear();
    for (const waiter of notificationWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new CodexAppServerControlError(message));
    }
    notificationWaiters.clear();
  };

  const dispatchNotification = (notification: CodexAppServerNotification): void => {
    notifications.push(notification);
    if (notifications.length > 200) {
      notifications.splice(0, notifications.length - 200);
    }
    for (const waiter of [...notificationWaiters]) {
      if (!waiter.predicate(notification)) continue;
      clearTimeout(waiter.timer);
      notificationWaiters.delete(waiter);
      waiter.resolve(notification);
    }
  };

  child.on("error", (error) => failAll(error.message));
  child.on("close", () => failAll("Codex app-server control process closed."));
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim().length === 0) continue;
      const decoded = decodeCodexAppServerLine(line);
      if (decoded.kind === "server_request") {
        try {
          writeRaw({ jsonrpc: "2.0", id: decoded.id, error: { code: -32601, message: "Unsupported Codex app-server control request." } });
        } catch {
        }
        continue;
      }
      if (decoded.kind === "notification") {
        dispatchNotification({ method: decoded.method, params: decoded.params });
        continue;
      }
      if (decoded.kind !== "response") continue;
      const entry = pending.get(decoded.id);
      if (entry === undefined) continue;
      pending.delete(decoded.id);
      if (decoded.error !== null) {
        entry.reject(new CodexAppServerControlError(codexErrorMessage(decoded.error, "Codex app-server request failed.")));
      } else {
        entry.resolve(decoded.result);
      }
    }
  });

  const writeRaw = (message: Record<string, unknown>): void => {
    if (closed) {
      throw new CodexAppServerControlError("Codex app-server control process is closed.");
    }
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };

  const client: CodexAppServerControlClient = {
    request(method, params) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          writeRaw({ jsonrpc: "2.0", id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error instanceof Error ? error : new CodexAppServerControlError("Codex app-server write failed."));
        }
      });
    },
    notify(method, params = {}) {
      writeRaw({ jsonrpc: "2.0", method, params });
    },
    waitForNotification(predicate, timeoutMs, description = "Codex app-server notification") {
      for (const notification of notifications) {
        if (predicate(notification)) {
          return Promise.resolve(notification);
        }
      }
      if (closed) {
        return Promise.reject(new CodexAppServerControlError("Codex app-server control process is closed."));
      }
      return new Promise<CodexAppServerNotification>((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          description,
          timer: setTimeout(() => {
            notificationWaiters.delete(waiter);
            reject(new CodexAppServerControlError(`${description} timed out after ${timeoutMs}ms.`));
          }, timeoutMs),
        };
        notificationWaiters.add(waiter);
      });
    },
    close() {
      closed = true;
      for (const waiter of notificationWaiters.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new CodexAppServerControlError("Codex app-server control process is closed."));
      }
      notificationWaiters.clear();
      try {
        child.kill();
      } catch {
      }
    },
  };

  await client.request("initialize", {
    clientInfo: { name: "closed-loop-control", title: "closed-loop Codex control", version: "0.0.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  client.notify("initialized", {});
  return client;
}

export async function withCodexAppServerControl<T>(
  cwd: string,
  fn: (client: CodexAppServerControlClient) => Promise<T>,
  options: CodexAppServerControlOptions = {},
): Promise<T> {
  const client = await openCodexAppServerControlClient(cwd, options);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return asRecord(value);
}
