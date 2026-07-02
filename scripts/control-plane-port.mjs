import net from "node:net";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_CONTROL_PLANE_PORT = 3000;
export const CONTROL_PLANE_HOST = "127.0.0.1";
const DEFAULT_PREVIEW_PORT_START = 3100;

export function parsePortValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = String(value).trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }
  return parsed;
}

function extractPortFlag(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-p" || arg === "--port") {
      const candidate = parsePortValue(args[i + 1]);
      if (candidate !== null) {
        return candidate;
      }
    } else if (arg.startsWith("--port=")) {
      const candidate = parsePortValue(arg.slice("--port=".length));
      if (candidate !== null) {
        return candidate;
      }
    } else if (arg.startsWith("-p=")) {
      const candidate = parsePortValue(arg.slice("-p=".length));
      if (candidate !== null) {
        return candidate;
      }
    }
  }
  return null;
}

function stripPortFlags(args) {
  const result = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-p" || arg === "--port") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=") || arg.startsWith("-p=")) {
      continue;
    }
    result.push(arg);
  }
  return result;
}

function autoScanRange() {
  const base = DEFAULT_CONTROL_PLANE_PORT;
  const previewStart = parsePortValue(process.env.PREVIEW_PORT_START) ?? DEFAULT_PREVIEW_PORT_START;
  const end = Math.max(base, Math.min(base + 99, previewStart - 1));
  return { base, end };
}

export function resolveControlPlanePort(extraArgs = []) {
  const passthroughArgs = stripPortFlags(extraArgs);
  const flagPort = extractPortFlag(extraArgs);
  if (flagPort !== null) {
    return { mode: "fixed", port: flagPort, source: "flag", passthroughArgs };
  }

  const rawEnv = process.env.CONTROL_PLANE_PORT;
  const envPort = parsePortValue(rawEnv);
  if (envPort !== null) {
    return { mode: "fixed", port: envPort, source: "env", passthroughArgs };
  }

  const wantsAuto = rawEnv === undefined || rawEnv.trim().length === 0 || rawEnv.trim().toLowerCase() === "auto";
  if (!wantsAuto) {
    console.warn(
      `[orchestrator] CONTROL_PLANE_PORT="${rawEnv}" is not a valid port (1-65535) or "auto". Picking a free port automatically.`,
    );
  }
  const { base, end } = autoScanRange();
  return { mode: "auto", base, end, source: rawEnv === undefined ? "default" : "env", passthroughArgs };
}

const LOOPBACK_PROBE_HOSTS = ["127.0.0.1", "::1"];

function probeListening(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (listening) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function bindCheck(host, port) {
  return new Promise((resolve, reject) => {
    const tester = net.createServer();
    tester.once("error", (error) => {
      tester.close(() => undefined);
      reject(error);
    });
    tester.once("listening", () => {
      tester.close(() => resolve());
    });
    tester.listen(port, host);
  });
}

async function answeringLoopbackHosts(port) {
  const answering = [];
  for (const probeHost of LOOPBACK_PROBE_HOSTS) {
    if (await probeListening(probeHost, port)) {
      answering.push(probeHost);
    }
  }
  return answering;
}

export async function isControlPlanePortFree(port, host = CONTROL_PLANE_HOST) {
  if ((await answeringLoopbackHosts(port)).length > 0) {
    return false;
  }
  try {
    await bindCheck(host, port);
    return true;
  } catch {
    return false;
  }
}

function loopbackLabel(host) {
  return host === "::1" ? "[::1] (IPv6 localhost)" : "127.0.0.1 (IPv4 localhost)";
}

function buildPortBusyMessage(port, answeringHosts) {
  const where = answeringHosts.map(loopbackLabel).join(" and ");
  const ipv6Only = answeringHosts.includes("::1") && !answeringHosts.includes("127.0.0.1");
  const dualStackNote = ipv6Only
    ? `"localhost" resolves to IPv6 [::1], so an IPv4 127.0.0.1 bind still looks free even though ` +
      `localhost:${port} is already taken — that is why this is easy to miss. `
    : "";
  return (
    `Control plane port ${port} is already in use — a service is already answering on ${where}. ` +
    dualStackNote +
    `Stop that process, set CONTROL_PLANE_PORT to a free port, or use CONTROL_PLANE_PORT=auto ` +
    `(and update TELEGRAM_CONTROL_APP_URL / the GitHub OAuth callback URL to match).`
  );
}

export async function assertControlPlanePortFree(host, port) {
  const answeringHosts = await answeringLoopbackHosts(port);
  if (answeringHosts.length > 0) {
    throw new Error(buildPortBusyMessage(port, answeringHosts));
  }
  try {
    await bindCheck(host, port);
  } catch (error) {
    if (error && (error.code === "EADDRINUSE" || error.code === "EACCES")) {
      throw new Error(
        `Control plane port ${port} on ${host} could not be bound (${error.code}). ` +
          `Stop whatever holds it, set CONTROL_PLANE_PORT to a free port, or use CONTROL_PLANE_PORT=auto.`,
      );
    }
    throw error;
  }
}

export async function allocateControlPlanePort({ base, end, host = CONTROL_PLANE_HOST }) {
  for (let port = base; port <= end; port += 1) {
    if (await isControlPlanePortFree(port, host)) {
      return port;
    }
  }
  throw new Error(
    `No free control-plane port in ${base}-${end}. Free one up, or pin a specific port with CONTROL_PLANE_PORT=<port>.`,
  );
}

export async function resolveBindablePort(resolution, host = CONTROL_PLANE_HOST) {
  if (resolution.mode === "fixed") {
    await assertControlPlanePortFree(host, resolution.port);
    return resolution.port;
  }
  return allocateControlPlanePort({ base: resolution.base, end: resolution.end, host });
}

function runtimeFilePath() {
  return process.env.CONTROL_PLANE_RUNTIME_FILE ?? path.join(process.cwd(), ".data", "control-plane.json");
}

export function writeControlPlaneRuntimeFile(port) {
  try {
    const filePath = runtimeFilePath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = {
      port,
      baseUrl: `http://${CONTROL_PLANE_HOST}:${port}`,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(filePath, JSON.stringify(payload));
  } catch {
    /* best-effort discovery hint */
  }
}

export function clearControlPlaneRuntimeFile() {
  try {
    rmSync(runtimeFilePath(), { force: true });
  } catch {
    /* best-effort */
  }
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid)) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === "EPERM";
  }
}

export function readControlPlaneRuntimeFile() {
  try {
    const data = JSON.parse(readFileSync(runtimeFilePath(), "utf8"));
    if (!data || typeof data.baseUrl !== "string" || !Number.isInteger(data.port)) {
      return null;
    }
    if (typeof data.pid === "number" && !pidIsAlive(data.pid)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}
