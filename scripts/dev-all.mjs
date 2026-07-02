import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import {
  CONTROL_PLANE_HOST,
  clearControlPlaneRuntimeFile,
  resolveBindablePort,
  resolveControlPlanePort,
  writeControlPlaneRuntimeFile,
} from "./control-plane-port.mjs";

const isWindows = process.platform === "win32";
const projectRoot = process.cwd();
const nodeCommand = process.execPath;
const nextCli = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
const telegramWorker = path.join(projectRoot, "scripts", "telegram-control-worker.mjs");
const noisyNpmEnvKeys = new Set([
  "npm_config_npm_globalconfig",
  "npm_config_verify_deps_before_run",
  "npm_config__jsr_registry",
]);

const children = [];
let shuttingDown = false;

function childEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (noisyNpmEnvKeys.has(key.toLowerCase())) {
      delete env[key];
    }
  }
  return env;
}

function prefixStream(stream, label, write) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    write(`[${label}] ${line}\n`);
  });
}

function start(label, command, args) {
  const child = spawn(command, args, {
    stdio: ["inherit", "pipe", "pipe"],
    shell: false,
    env: childEnvironment(),
    windowsHide: true,
  });
  children.push({ label, child });
  prefixStream(child.stdout, label, (line) => process.stdout.write(line));
  prefixStream(child.stderr, label, (line) => process.stderr.write(line));
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev:all] ${label} exited (${signal ?? code ?? "unknown"}). Stopping the other process.`);
      shutdown(code ?? 1);
    }
  });
}

function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) {
    return;
  }

  if (isWindows && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  child.kill("SIGTERM");
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearControlPlaneRuntimeFile();
  for (const { child } of children) {
    stopChild(child);
  }
  setTimeout(() => {
    process.exit(exitCode);
  }, 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  const resolution = resolveControlPlanePort();
  let port;
  try {
    port = await resolveBindablePort(resolution, CONTROL_PLANE_HOST);
  } catch (error) {
    console.error(`[dev:all] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  process.env.CONTROL_PLANE_PORT = String(port);
  if (process.env.TELEGRAM_CONTROL_APP_URL === undefined) {
    process.env.TELEGRAM_CONTROL_APP_URL = `http://${CONTROL_PLANE_HOST}:${port}`;
  }
  writeControlPlaneRuntimeFile(port);

  const chosenNote =
    resolution.mode === "auto" && port !== resolution.base ? ` (auto: ${resolution.base} was busy)` : "";
  console.log(`[dev:all] control plane on http://${CONTROL_PLANE_HOST}:${port}${chosenNote}`);
  start("app", nodeCommand, [nextCli, "dev", "-H", CONTROL_PLANE_HOST, "-p", String(port)]);
  start("telegram", nodeCommand, [telegramWorker]);
}

void main();
