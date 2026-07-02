import path from "node:path";
import { constants, type Dirent } from "node:fs";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { getConfig } from "@/lib/server/config";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { logProcess } from "@/lib/server/logging";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import { createMlJobProcessEnv } from "@/lib/server/runtime/env";
import { probeVenvCapability } from "@/lib/server/runtime/ml-doctor";
import { resolvePythonCommand } from "@/lib/server/runtime/python-resolver";
import {
  registerWorkSessionOperation,
  type WorkSessionOperationHandle,
} from "@/lib/server/runtime/operation-registry";
import {
  readExperimentManifest,
  writeExperimentManifest,
  type ExperimentManifest,
} from "@/lib/server/ml/experiment-manifest";
import { mlCacheEnv, readVenvCapabilityArtifact } from "@/lib/server/ml/ml-env";
import { tryAcquireGpu, releaseGpu } from "@/lib/server/ml/gpu-mutex";
import { PREDICT_HARNESS_FILENAME, predictHarnessSource } from "@/lib/server/ml/inference/predict-harness-source";
import { normalizeInferenceContract, type InferenceContract, type InferenceWorkerInfo } from "@/lib/shared/inference-contract";
import type { MlDevice } from "@/lib/shared/types";

export class InferenceRuntimeError extends Error {}

const INFERENCE_SUBDIR = path.join(".orchestrator", "inference");

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

interface InferenceResultMessage {
  type: string;
  id?: string | null;
  outputs?: unknown;
  timing_ms?: number;
  message?: string;
  traceback?: string;
  text?: string;
}

interface PendingRequest {
  resolve: (msg: InferenceResultMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  onToken?: (text: string) => void;
}

interface InferenceWorker {
  workSessionId: string;
  workspacePath: string;
  /** The workspace-relative predict entrypoint (e.g. "predict.py"); used to refresh the owned manifest. */
  entrypoint: string;
  child: ChildProcess;
  status: InferenceWorkerInfo["status"];
  device: MlDevice;
  deviceName: string | null;
  contract: InferenceContract | null;
  message: string | null;
  startedAt: string;
  gpuRunId: string | null;
  operation: WorkSessionOperationHandle | null;
  pending: Map<string, PendingRequest>;
  stdoutBuffer: string;
  stderrTail: string;
  idleTimer: NodeJS.Timeout | null;
  bootTimer: NodeJS.Timeout | null;
  stopping: boolean;
}

const workers = new Map<string, InferenceWorker>();
const startingWorkers = new Set<string>();
const STDERR_TAIL_MAX = 8000;

export interface InferencePredictionResult {
  outputs: unknown;
  timingMs: number | null;
}

function workerInfo(worker: InferenceWorker): InferenceWorkerInfo {
  return {
    status: worker.status,
    device: worker.device,
    deviceName: worker.deviceName,
    message: worker.message,
    startedAt: worker.startedAt,
    contract: worker.contract,
  };
}

const COLD_INFO: InferenceWorkerInfo = {
  status: "cold",
  device: null,
  deviceName: null,
  message: null,
  startedAt: null,
  contract: null,
};

export function getInferenceWorkerInfo(workSessionId: string): InferenceWorkerInfo {
  const worker = workers.get(workSessionId);
  return worker === undefined ? COLD_INFO : workerInfo(worker);
}

export function inferenceSandboxDir(workspacePath: string): string {
  return path.join(workspacePath, INFERENCE_SUBDIR);
}

/** Resolve a sandbox-relative path to an absolute path, refusing anything that escapes the inference sandbox. */
export function resolveSandboxFile(workspacePath: string, rel: string): string | null {
  const base = path.resolve(inferenceSandboxDir(workspacePath));
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return null;
  }
  return target;
}

async function resolveInferenceDevice(
  workspacePath: string,
  signal: AbortSignal,
): Promise<{ device: MlDevice; deviceName: string | null }> {
  const config = getConfig();
  if (!config.mlAllowGpu) {
    return { device: "cpu", deviceName: null };
  }
  let capability = await readVenvCapabilityArtifact(workspacePath);
  if (capability === null) {
    capability = await probeVenvCapability(workspacePath, { force: true, signal });
  }
  if (capability.cudaAvailable) {
    return { device: "cuda", deviceName: capability.deviceName };
  }
  if (capability.mpsAvailable) {
    return { device: "mps", deviceName: capability.deviceName };
  }
  return { device: "cpu", deviceName: null };
}

async function resolvePredictEntrypoint(
  workspacePath: string,
  manifest: ExperimentManifest | null,
): Promise<string | null> {
  const declared = manifest?.predict?.entrypoint ?? null;
  if (declared !== null && (await fileExists(path.join(workspacePath, declared)))) {
    return declared;
  }
  if (await fileExists(path.join(workspacePath, "predict.py"))) {
    return "predict.py";
  }
  return null;
}

const NON_CHECKPOINT_EXT = /\.(txt|log|md|csv|tsv|tmp|part|partial|lock|crdownload)$/i;
const SMOKE_ARTIFACT = /(^|_)smoke(\.|$)/i;

/**
 * A real (non-smoke) trained checkpoint must exist before inference is offered. Format-agnostic by design:
 * predict.py owns (de)serialization, so a fixed binary-extension allowlist wrongly hid models saved as
 * JSON/npz/HF-dir/etc. We accept any non-smoke checkpoint artifact and let predict.py's load() be the
 * authority — a missing/garbage checkpoint surfaces as a clean worker load error, which the UI already shows.
 */
export async function hasTrainedCheckpoint(workspacePath: string): Promise<boolean> {
  const checkpointsDir = path.join(workspacePath, "checkpoints");
  let entries: Dirent[];
  try {
    entries = await readdir(checkpointsDir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const name = entry.name;
    if (SMOKE_ARTIFACT.test(name) || name.startsWith(".") || NON_CHECKPOINT_EXT.test(name)) {
      continue;
    }
    if (entry.isDirectory()) {
      return true; // a saved-model directory (e.g. HF save_pretrained) counts as a checkpoint
    }
    if (entry.isFile()) {
      try {
        if ((await stat(path.join(checkpointsDir, name))).size > 0) {
          return true;
        }
      } catch {
      }
    }
  }
  return false;
}

export async function isInferenceAvailable(workspacePath: string): Promise<boolean> {
  const manifest = await readExperimentManifest(workspacePath);
  const entrypoint = await resolvePredictEntrypoint(workspacePath, manifest);
  if (entrypoint === null) {
    return false;
  }
  return hasTrainedCheckpoint(workspacePath);
}

export async function getStaticInferenceContract(workspacePath: string): Promise<InferenceContract | null> {
  const manifest = await readExperimentManifest(workspacePath);
  return manifest?.predict?.contract ?? null;
}

function killWorkerProcess(child: ChildProcess): void {
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
}

function clearWorkerTimers(worker: InferenceWorker): void {
  if (worker.idleTimer !== null) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
  }
  if (worker.bootTimer !== null) {
    clearTimeout(worker.bootTimer);
    worker.bootTimer = null;
  }
}

function finalizeWorker(worker: InferenceWorker, status: "stopped" | "error", message: string | null): void {
  clearWorkerTimers(worker);
  for (const pending of worker.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new InferenceRuntimeError(message ?? "Inference worker stopped."));
  }
  worker.pending.clear();
  if (worker.gpuRunId !== null) {
    releaseGpu(worker.gpuRunId);
    worker.gpuRunId = null;
  }
  worker.operation?.unregister();
  worker.operation = null;
  worker.status = worker.status === "error" ? "error" : status;
  if (message !== null) {
    worker.message = message;
  }
}

function bumpIdle(worker: InferenceWorker): void {
  if (worker.idleTimer !== null) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
  }
  const idleMs = getConfig().mlInferenceIdleMs;
  if (idleMs > 0) {
    worker.idleTimer = setTimeout(() => {
      void stopInferenceWorker(worker.workSessionId, "Inference worker idle-stopped to free resources.");
    }, idleMs);
  }
}

/**
 * Refresh `.orchestrator/experiment/manifest.json` with the live contract from the worker's `ready`
 * handshake, preserving the manifest base (kind/entrypoint/metrics/summary). Scaffolds ship a generic
 * default contract in root `experiment.json` that goes stale once predict.py is specialized; persisting the
 * authoritative contract here makes the pre-warm widget correct on the next page load. Best-effort and
 * idempotent (skips the write when the owned manifest already matches).
 */
async function persistLiveContract(worker: InferenceWorker, contract: InferenceContract): Promise<void> {
  try {
    const base = await readExperimentManifest(worker.workspacePath);
    if (
      base?.predict?.entrypoint === worker.entrypoint
      && JSON.stringify(base?.predict?.contract ?? null) === JSON.stringify(contract)
    ) {
      return; // already current — avoid rewriting on every warm
    }
    await writeExperimentManifest(worker.workspacePath, {
      kind: base?.kind ?? "ml",
      entrypoint: base?.entrypoint ?? worker.entrypoint,
      metrics: base?.metrics ?? "metrics.jsonl",
      summary: base?.summary ?? "metrics.json",
      predict: { entrypoint: worker.entrypoint, contract },
    });
    logProcess("info", "inference.manifest.contract_refreshed", { workSessionId: worker.workSessionId });
  } catch {
  }
}

function handleWorkerLine(worker: InferenceWorker, line: string): void {
  let msg: InferenceResultMessage;
  try {
    msg = JSON.parse(line) as InferenceResultMessage;
  } catch {
    return; // ignore non-JSON noise on the protocol stream
  }
  if (msg.type === "ready") {
    worker.status = "ready";
    worker.contract = normalizeInferenceContract((msg as { contract?: unknown }).contract);
    if (worker.contract !== null) {
      void persistLiveContract(worker, worker.contract);
    }
    if (worker.bootTimer !== null) {
      clearTimeout(worker.bootTimer);
      worker.bootTimer = null;
    }
    bumpIdle(worker);
    logProcess("info", "inference.worker.ready", { workSessionId: worker.workSessionId, device: worker.device });
    return;
  }
  if (msg.type === "error" && (msg.id === undefined || msg.id === null)) {
    worker.status = "error";
    worker.message = msg.message ?? "Inference worker failed to start.";
    logProcess("warn", "inference.worker.start_error", { workSessionId: worker.workSessionId, message: worker.message });
    return;
  }
  const id = typeof msg.id === "string" ? msg.id : null;
  if (id === null) {
    return;
  }
  const pending = worker.pending.get(id);
  if (pending === undefined) {
    return;
  }
  if (msg.type === "token") {
    if (typeof msg.text === "string") {
      pending.onToken?.(msg.text);
    }
    return;
  }
  clearTimeout(pending.timer);
  worker.pending.delete(id);
  pending.resolve(msg);
}

function attachWorkerHandlers(worker: InferenceWorker): void {
  worker.child.stdout?.on("data", (chunk: Buffer) => {
    worker.stdoutBuffer += chunk.toString("utf8");
    let newlineIndex = worker.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = worker.stdoutBuffer.slice(0, newlineIndex).trim();
      worker.stdoutBuffer = worker.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        handleWorkerLine(worker, line);
      }
      newlineIndex = worker.stdoutBuffer.indexOf("\n");
    }
  });
  worker.child.stderr?.on("data", (chunk: Buffer) => {
    worker.stderrTail = (worker.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_MAX);
  });
  worker.child.on("error", (error) => {
    finalizeWorker(worker, "error", error.message);
    logProcess("warn", "inference.worker.process_error", { workSessionId: worker.workSessionId, message: error.message });
  });
  worker.child.on("close", (code) => {
    const message = worker.status === "error"
      ? worker.message
      : worker.stopping
        ? worker.message ?? "Inference worker stopped."
        : `Inference worker exited (code ${code ?? "unknown"}).${worker.stderrTail.trim().length > 0 ? ` ${worker.stderrTail.trim().slice(-400)}` : ""}`;
    finalizeWorker(worker, "stopped", message);
    logProcess("info", "inference.worker.closed", { workSessionId: worker.workSessionId, code });
  });
}

export async function ensureInferenceWorker(workSessionId: string): Promise<InferenceWorkerInfo> {
  const existing = workers.get(workSessionId);
  if (existing !== undefined && !existing.stopping && (existing.status === "ready" || existing.status === "starting")) {
    return workerInfo(existing);
  }
  return startInferenceWorker(workSessionId);
}

async function startInferenceWorker(workSessionId: string): Promise<InferenceWorkerInfo> {
  const config = getConfig();
  if (!config.mlPipelineEnabled) {
    throw new InferenceRuntimeError("The ML pipeline is disabled (set ML_PIPELINE_ENABLED=true).");
  }
  if (startingWorkers.has(workSessionId)) {
    const inflight = workers.get(workSessionId);
    if (inflight !== undefined) {
      return workerInfo(inflight);
    }
    throw new InferenceRuntimeError("The inference worker is already starting.");
  }
  startingWorkers.add(workSessionId);
  try {
    return await startInferenceWorkerInner(workSessionId, config);
  } finally {
    startingWorkers.delete(workSessionId);
  }
}

async function startInferenceWorkerInner(
  workSessionId: string,
  config: ReturnType<typeof getConfig>,
): Promise<InferenceWorkerInfo> {
  const snapshot = await getDatabaseSnapshot();
  const workSession = snapshot.workSessions.find((session) => session.id === workSessionId);
  if (workSession === undefined) {
    throw new InferenceRuntimeError("Work session was not found.");
  }
  const workspacePath = workSession.activeWorktreePath;
  await assertSafeWorkspace(workspacePath, { operation: "inference" });

  const manifest = await readExperimentManifest(workspacePath);
  const entrypoint = await resolvePredictEntrypoint(workspacePath, manifest);
  if (entrypoint === null) {
    throw new InferenceRuntimeError(
      "This workspace has no inference entrypoint. The model must ship a predict.py exposing CONTRACT + predict().",
    );
  }
  if (!(await hasTrainedCheckpoint(workspacePath))) {
    throw new InferenceRuntimeError("No trained checkpoint was found yet. Run a short or full experiment first.");
  }

  const operation = registerWorkSessionOperation({ workSessionId, kind: "inference", label: "Inference worker" });
  let gpuRunId: string | null = null;
  try {
    const resolvedDevice = await resolveInferenceDevice(workspacePath, operation.signal);
    let device = resolvedDevice.device;
    let deviceName = resolvedDevice.deviceName;
    let deviceMessage: string | null = null;
    if (device !== "cpu") {
      const runId = `inference:${workSessionId}`;
      if (tryAcquireGpu(runId)) {
        gpuRunId = runId;
      } else {
        device = "cpu";
        deviceName = null;
        deviceMessage = "GPU is busy with another job; the model is loading on CPU.";
      }
    }

    const sandbox = inferenceSandboxDir(workspacePath);
    await mkdir(path.join(sandbox, "inputs"), { recursive: true });
    await mkdir(path.join(sandbox, "outputs"), { recursive: true });
    const harnessPath = path.join(sandbox, PREDICT_HARNESS_FILENAME);
    await writeFile(harnessPath, predictHarnessSource, "utf8");

    const python = await resolvePythonCommand(workspacePath);
    const env = createMlJobProcessEnv(
      {
        ...mlCacheEnv(),
        ACF_INFERENCE_DIR: sandbox,
        ACF_PREDICT_ENTRYPOINT: entrypoint,
        ACF_DEVICE: device,
        CUBLAS_WORKSPACE_CONFIG: ":4096:8",
        ACF_INFERENCE_TIMEOUT_S: String(Math.max(5, Math.floor(config.mlInferenceTimeoutMs / 1000))),
        ACF_TRUST_REMOTE_CODE: config.mlTrustRemoteCode ? "1" : "0",
      },
      { allowSecrets: config.mlAllowSecrets },
    );

    const child = spawn(python.command, [harnessPath], {
      cwd: workspacePath,
      env: env as NodeJS.ProcessEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const worker: InferenceWorker = {
      workSessionId,
      workspacePath,
      entrypoint,
      child,
      status: "starting",
      device,
      deviceName,
      contract: manifest?.predict?.contract ?? null,
      message: deviceMessage,
      startedAt: new Date().toISOString(),
      gpuRunId,
      operation,
      pending: new Map(),
      stdoutBuffer: "",
      stderrTail: "",
      idleTimer: null,
      bootTimer: null,
      stopping: false,
    };
    workers.set(workSessionId, worker);
    attachWorkerHandlers(worker);

    operation.signal.addEventListener(
      "abort",
      () => {
        void stopInferenceWorker(workSessionId, "Inference worker aborted.");
      },
      { once: true },
    );

    const bootTimeoutMs = Math.max(config.mlInferenceTimeoutMs, 600000);
    worker.bootTimer = setTimeout(() => {
      if (worker.status === "starting") {
        worker.status = "error";
        worker.message = `Model load did not complete within ${Math.round(bootTimeoutMs / 1000)}s.`;
        void stopInferenceWorker(workSessionId, worker.message);
      }
    }, bootTimeoutMs);

    logProcess("info", "inference.worker.started", { workSessionId, device, entrypoint });
    return workerInfo(worker);
  } catch (error) {
    if (gpuRunId !== null) {
      releaseGpu(gpuRunId);
    }
    operation.unregister();
    if (error instanceof InferenceRuntimeError) {
      throw error;
    }
    throw new InferenceRuntimeError(error instanceof Error ? error.message : String(error));
  }
}

function sendRequest(
  worker: InferenceWorker,
  id: string,
  payload: unknown,
  onToken?: (text: string) => void,
): Promise<InferenceResultMessage> {
  const config = getConfig();
  return new Promise<InferenceResultMessage>((resolve, reject) => {
    const stdin = worker.child.stdin;
    if (stdin === null || stdin.destroyed) {
      reject(new InferenceRuntimeError("The inference worker input stream is closed."));
      return;
    }
    const timer = setTimeout(() => {
      worker.pending.delete(id);
      reject(new InferenceRuntimeError("Inference request timed out."));
    }, config.mlInferenceTimeoutMs + 15000);
    worker.pending.set(id, { resolve, reject, timer, onToken });
    stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
      if (error !== null && error !== undefined) {
        clearTimeout(timer);
        worker.pending.delete(id);
        reject(new InferenceRuntimeError(error.message));
      }
    });
  });
}

export async function runInferencePrediction(input: {
  workSessionId: string;
  requestId: string;
  inputs: Record<string, unknown>;
  options?: Record<string, unknown>;
  /** Called for each streamed token (when predict.py opts into streaming via ctx.emit_token). */
  onToken?: (text: string) => void;
}): Promise<InferencePredictionResult> {
  const worker = workers.get(input.workSessionId);
  if (worker === undefined || worker.stopping) {
    throw new InferenceRuntimeError("The inference worker is not running. Start it first.");
  }
  if (worker.status === "starting") {
    throw new InferenceRuntimeError("The inference worker is still loading the model. Try again shortly.");
  }
  if (worker.status !== "ready") {
    throw new InferenceRuntimeError(worker.message ?? "The inference worker is not ready.");
  }
  bumpIdle(worker);
  const message = await sendRequest(
    worker,
    input.requestId,
    {
      type: "predict",
      id: input.requestId,
      inputs: input.inputs,
      options: input.options ?? {},
    },
    input.onToken,
  );
  bumpIdle(worker);
  if (message.type === "error") {
    throw new InferenceRuntimeError(message.message ?? "Prediction failed.");
  }
  return {
    outputs: message.outputs ?? null,
    timingMs: typeof message.timing_ms === "number" ? message.timing_ms : null,
  };
}

export async function stopInferenceWorker(workSessionId: string, reason: string): Promise<boolean> {
  const worker = workers.get(workSessionId);
  if (worker === undefined || worker.stopping) {
    return false;
  }
  worker.stopping = true;
  worker.message = reason;
  clearWorkerTimers(worker);
  if (worker.gpuRunId !== null) {
    releaseGpu(worker.gpuRunId);
    worker.gpuRunId = null;
  }
  try {
    worker.child.stdin?.write(`${JSON.stringify({ type: "shutdown" })}\n`);
    worker.child.stdin?.end();
  } catch {
  }
  setTimeout(() => {
    killWorkerProcess(worker.child);
  }, 500);
  logProcess("info", "inference.worker.stop", { workSessionId, reason });
  return true;
}

/** Stop any inference worker currently holding the GPU mutex so an experiment run can take it. */
export async function stopInferenceWorkersHoldingGpu(reason = "GPU released for an experiment run."): Promise<number> {
  let stopped = 0;
  for (const worker of workers.values()) {
    if (worker.gpuRunId !== null && !worker.stopping) {
      await stopInferenceWorker(worker.workSessionId, reason);
      stopped += 1;
    }
  }
  return stopped;
}
