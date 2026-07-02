import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  CONTROL_PLANE_HOST,
  clearControlPlaneRuntimeFile,
  resolveBindablePort,
  resolveControlPlanePort,
  writeControlPlaneRuntimeFile,
} from "./control-plane-port.mjs";

const mode = process.argv[2] === "start" ? "start" : "dev";
const extraArgs = process.argv.slice(3);
const resolution = resolveControlPlanePort(extraArgs);

const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");

async function main() {
  let port;
  try {
    port = await resolveBindablePort(resolution, CONTROL_PLANE_HOST);
  } catch (error) {
    console.error(`[orchestrator] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const chosenNote =
    resolution.mode === "auto" && port !== resolution.base
      ? ` (auto: ${resolution.base} was busy)`
      : ` (port source: ${resolution.mode === "auto" ? "auto" : resolution.source})`;
  console.log(`[orchestrator] starting control plane (${mode}) on http://${CONTROL_PLANE_HOST}:${port}${chosenNote}`);

  if (!existsSync(path.join(process.cwd(), ".env"))) {
    const autonomy = process.env.DEFAULT_AUTONOMY_LEVEL || "checkpoint (code default)";
    const sandbox = process.env.CODEX_SANDBOX_MODE || "workspace-write (code default)";
    console.warn(
      `[orchestrator] WARNING: no .env file found — running on code defaults ` +
        `(autonomy: ${autonomy}; codex sandbox: ${sandbox}). ` +
        `Copy .env.example to .env to configure this deliberately; see README.md.`,
    );
  }

  process.env.CONTROL_PLANE_PORT = String(port);
  writeControlPlaneRuntimeFile(port);

  const child = spawn(
    process.execPath,
    [nextCli, mode, "-H", CONTROL_PLANE_HOST, "-p", String(port), ...resolution.passthroughArgs],
    { stdio: "inherit", env: process.env, windowsHide: true },
  );

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };
  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    clearControlPlaneRuntimeFile();
    process.exit(signal ? 1 : code ?? 0);
  });
}

void main();
