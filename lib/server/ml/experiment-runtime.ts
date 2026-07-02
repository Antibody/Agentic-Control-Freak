import path from "node:path";
import { mkdir, readFile, rm } from "node:fs/promises";
import { getConfig } from "@/lib/server/config";
import {
  createExperimentRunRecord,
  getDatabaseSnapshot,
  mutateDatabase,
  updateWorkSessionTimestamp,
} from "@/lib/server/db/file-db";
import { emitEvent, emitEvents, type EmitEventInput } from "@/lib/server/events";
import { logProcess } from "@/lib/server/logging";
import { saveArtifact } from "@/lib/server/artifacts";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import { createMlJobProcessEnv } from "@/lib/server/runtime/env";
import { probeVenvCapability, runMlDoctor, type VenvCapability } from "@/lib/server/runtime/ml-doctor";
import { resolvePythonCommand } from "@/lib/server/runtime/python-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";
import {
  abortWorkSessionOperationsByKind,
  registerWorkSessionOperation,
  type WorkSessionOperationHandle,
} from "@/lib/server/runtime/operation-registry";
import { readExperimentManifest, resolveExperimentEntrypoint, type ExperimentManifest } from "@/lib/server/ml/experiment-manifest";
import { parseMetricLines, type MetricLine } from "@/lib/server/ml/metrics-contract";
import { buildScorecard, readSummary, scorecardSummaryText, writeScorecardArtifact } from "@/lib/server/ml/scorecard";
import { writeProvenanceArtifact } from "@/lib/server/ml/provenance";
import { emptyMlRunConfig, experimentDir, writeRunConfig } from "@/lib/server/ml/run-config";
import { installMlRequirements } from "@/lib/server/ml/ml-installer";
import { mlCacheEnv, readVenvCapabilityArtifact } from "@/lib/server/ml/ml-env";
import { tryAcquireGpu, releaseGpu, gpuHeldBy } from "@/lib/server/ml/gpu-mutex";
import { stopInferenceWorkersHoldingGpu } from "@/lib/server/ml/inference-runtime";
import { planVramFit, parseParamsMillions, type VramOptimizer } from "@/lib/server/ml/vram-preflight";
import type { ExperimentRunRecord, MlDatasetConfig, MlDevice, MlRunConfig, MlRunRegime, WorkSessionRecord } from "@/lib/shared/types";

export class ExperimentRuntimeError extends Error {}

function effectiveConfig(workSession: WorkSessionRecord, regime: MlRunRegime): MlRunConfig {
  const base = workSession.mlRunConfig ?? emptyMlRunConfig();
  return { ...base, regime };
}

function describeDataset(ds: MlDatasetConfig | undefined): string | null {
  if (ds === undefined) {
    return null;
  }
  const parts: string[] = [];
  if (ds.trainPath) parts.push(`train=${ds.trainPath}`);
  if (ds.valPath) parts.push(`val=${ds.valPath}`);
  if (ds.testPath) parts.push(`test=${ds.testPath}`);
  if (ds.corpusPath) parts.push(`corpus=${ds.corpusPath}`);
  if (parts.length === 0) {
    return ds.mode === "builtin" ? null : ds.mode;
  }
  return `${ds.mode}: ${parts.join(", ")}`;
}

async function activeRunExists(workSessionId: string): Promise<boolean> {
  const snapshot = await getDatabaseSnapshot();
  return snapshot.experimentRuns.some(
    (run) => run.workSessionId === workSessionId && (run.status === "running" || run.status === "queued"),
  );
}

interface AcceleratorDecision {
  config: MlRunConfig;
  gpuRunId: string | null;
  notes: string[];
}

function optimizerForConfig(config: MlRunConfig): VramOptimizer {
  const declared = (config.extra.optimizer ?? "").toLowerCase();
  if (declared === "sgd" || declared === "adam" || declared === "adamw" || declared === "none") {
    return declared;
  }
  return "adamw";
}

async function prepareAccelerator(
  run: ExperimentRunRecord,
  runConfig: MlRunConfig,
  workSessionId: string,
  stamp: number,
): Promise<AcceleratorDecision> {
  const config = getConfig();
  const notes: string[] = [];
  const doctor = await runMlDoctor().catch(() => null);
  const acceleratorAvailable = doctor !== null && config.mlAllowGpu && doctor.accelerator !== "cpu";
  const wantsGpu = runConfig.device === "cuda" || runConfig.device === "mps"
    || (runConfig.device === "auto" && acceleratorAvailable);
  const usesGpu = wantsGpu && acceleratorAvailable && run.regime !== "smoke";

  if (!usesGpu) {
    return { config: runConfig, gpuRunId: null, notes };
  }

  const evicted = await stopInferenceWorkersHoldingGpu();
  if (evicted > 0) {
    notes.push(`Stopped ${evicted} inference worker(s) to free the GPU for this run.`);
  }

  const holder = gpuHeldBy();
  if (holder !== null && holder !== run.id) {
    throw new ExperimentRuntimeError(
      "Another GPU experiment is already running on this machine; only one accelerator job runs at a time. Wait for it to finish or abort it first.",
    );
  }
  if (!tryAcquireGpu(run.id)) {
    throw new ExperimentRuntimeError("Could not acquire the GPU lock for this experiment.");
  }

  let effective = runConfig;
  const declaredParams = runConfig.extra.modelParamsMillions ?? runConfig.extra.modelSize ?? "";
  const paramsMillions = parseParamsMillions(String(declaredParams));
  if (paramsMillions !== null) {
    const budgetMb = doctor?.cuda.vramFreeMb ?? doctor?.cuda.vramTotalMb ?? null;
    const plan = planVramFit(
      {
        paramsMillions,
        precision: runConfig.precision,
        batchSize: runConfig.batchSize ?? 1,
        seqLen: Number(runConfig.extra.seqLen ?? "") || 512,
        gradAccum: runConfig.gradAccum ?? 1,
        optimizer: optimizerForConfig(runConfig),
        training: run.regime !== "smoke",
        trainableFraction: Number(runConfig.extra.trainableFraction ?? "") || 1,
        hiddenSize: Number(runConfig.extra.hiddenSize ?? "") || 2048,
        layers: Number(runConfig.extra.layers ?? "") || 24,
        gradientCheckpointing: runConfig.extra.gradientCheckpointing === "true",
      },
      budgetMb,
    );
    notes.push(...plan.rationale);
    await saveArtifact({
      workSessionId,
      kind: "report",
      fileName: `ml-vram-decision-${stamp}.json`,
      content: JSON.stringify({ paramsMillions, plan }, null, 2),
      metadata: { reportType: "ml_vram_decision", summary: `${plan.decision}: estimated ${plan.estimatedMb}MB vs budget ${plan.budgetMb ?? "n/a"}MB` },
    }).catch(() => undefined);

    if (plan.decision === "refuse") {
      releaseGpu(run.id);
      throw new ExperimentRuntimeError(plan.rationale.join(" "));
    }
    if (plan.decision === "downshift") {
      effective = {
        ...runConfig,
        batchSize: plan.adjusted.batchSize,
        gradAccum: plan.adjusted.gradAccum,
        extra: { ...runConfig.extra, gradientCheckpointing: String(plan.adjusted.gradientCheckpointing), seqLen: String(plan.adjusted.seqLen) },
      };
    }
  }

  return { config: effective, gpuRunId: run.id, notes };
}

interface PreflightDecision {
  effectiveDevice: MlDevice;
  intendedDevice: MlDevice;
  mismatch: boolean;
  releaseGpu: boolean;
  notes: string[];
}

async function assertVenvAccelerator(
  workspacePath: string,
  runConfig: MlRunConfig,
  signal: AbortSignal,
): Promise<PreflightDecision> {
  const config = getConfig();
  let capability = await readVenvCapabilityArtifact(workspacePath);
  if (capability === null) {
    capability = await probeVenvCapability(workspacePath, { force: true, signal });
  }
  const intendedDevice = runConfig.device;
  if (intendedDevice === "cpu") {
    return { effectiveDevice: "cpu", intendedDevice, mismatch: false, releaseGpu: false, notes: [] };
  }
  const explicitGpu = intendedDevice === "cuda" || intendedDevice === "mps";
  const acceleratorAvailable = capability.cudaAvailable || capability.mpsAvailable;
  const effectiveDevice: MlDevice = capability.cudaAvailable ? "cuda" : capability.mpsAvailable ? "mps" : "cpu";
  const notes: string[] = [];

  if (explicitGpu && !acceleratorAvailable) {
    if (config.mlGpuUnavailablePolicy === "refuse") {
      throw new ExperimentRuntimeError(
        `GPU was requested (device=${intendedDevice}) but the project venv cannot use it (torch=${capability.torchVersion ?? "unknown"}, cuda_build=${capability.cudaBuild ?? "none"}, cuda_available=${capability.cudaAvailable}, mps_available=${capability.mpsAvailable}). Real training will not run on CPU for this configuration. Reinstall a CUDA-enabled torch (set ML_ALLOW_GPU=true with a matching driver) or set device=cpu. Set ML_GPU_UNAVAILABLE_POLICY=cpu-downgrade to fall back to CPU automatically.`,
      );
    }
    notes.push(`GPU unavailable for device=${intendedDevice}; downgraded to CPU (ML_GPU_UNAVAILABLE_POLICY=cpu-downgrade).`);
    return { effectiveDevice: "cpu", intendedDevice, mismatch: true, releaseGpu: true, notes };
  }

  if (intendedDevice === "auto" && !acceleratorAvailable) {
    notes.push("No accelerator detected in the project venv; running on CPU (device=auto).");
    return { effectiveDevice: "cpu", intendedDevice, mismatch: false, releaseGpu: true, notes };
  }

  if (runConfig.precision === "bf16" && effectiveDevice === "cuda" && !capability.bf16Supported) {
    throw new ExperimentRuntimeError(
      "precision=bf16 was requested but the CUDA device reports no bf16 support. Use fp16 or fp32.",
    );
  }
  const wantsQuant = runConfig.precision === "int8" || runConfig.precision === "int4"
    || (runConfig.extra.quantization ?? "").length > 0;
  if (wantsQuant && effectiveDevice === "cuda" && !capability.bitsandbytesAvailable) {
    throw new ExperimentRuntimeError(
      "Quantized (int8/int4) execution was requested but bitsandbytes is not importable in the project venv. Add bitsandbytes to requirements.txt or remove the quantization request.",
    );
  }

  return { effectiveDevice, intendedDevice, mismatch: false, releaseGpu: false, notes };
}

async function emitMetricLines(workSessionId: string, runId: string, lines: MetricLine[]): Promise<void> {
  if (lines.length === 0) {
    return;
  }
  const latestBySeries = new Map<string, MetricLine>();
  const phases: MetricLine[] = [];
  for (const line of lines) {
    if (line.type === "phase") {
      phases.push(line);
    } else {
      latestBySeries.set(`${line.name}::${line.split}::${line.depth ?? ""}`, line);
    }
  }
  const kept: MetricLine[] = [...phases, ...latestBySeries.values()];
  const inputs = kept.map((line): EmitEventInput =>
    line.type === "phase"
      ? {
          workSessionId,
          eventName: "experiment.phase",
          aggregateType: "experiment",
          aggregateId: runId,
          payload: { phase: line.phase, t: line.t },
          producer: { module: "experiment-runtime" },
        }
      : {
          workSessionId,
          eventName: "experiment.metric",
          aggregateType: "experiment",
          aggregateId: runId,
          payload: { name: line.name, value: line.value, split: line.split, step: line.step, depth: line.depth, t: line.t },
          producer: { module: "experiment-runtime" },
        },
  );
  await emitEvents(inputs);
}

async function updateRun(runId: string, patch: Partial<ExperimentRunRecord>): Promise<void> {
  await mutateDatabase((db) => {
    const record = db.experimentRuns.find((run) => run.id === runId);
    if (record !== undefined) {
      Object.assign(record, patch);
    }
  });
}

export async function startExperimentRun(input: {
  workSessionId: string;
  regime: MlRunRegime;
}): Promise<ExperimentRunRecord> {
  const config = getConfig();
  if (!config.mlPipelineEnabled) {
    throw new ExperimentRuntimeError("The ML pipeline is disabled (set ML_PIPELINE_ENABLED=true).");
  }

  const snapshot = await getDatabaseSnapshot();
  const workSession = snapshot.workSessions.find((session) => session.id === input.workSessionId);
  if (workSession === undefined) {
    throw new ExperimentRuntimeError("Work session was not found.");
  }
  await assertSafeWorkspace(workSession.activeWorktreePath, { operation: "experiment" });

  const declaredManifest = await readExperimentManifest(workSession.activeWorktreePath);
  if (declaredManifest === null) {
    throw new ExperimentRuntimeError("No experiment.json manifest was found in the workspace; this is not an ML workspace.");
  }
  if (await activeRunExists(workSession.id)) {
    throw new ExperimentRuntimeError("An experiment run is already in progress for this work session.");
  }

  const resolution = await resolveExperimentEntrypoint(workSession.activeWorktreePath, declaredManifest);
  if (resolution.fail !== null) {
    throw new ExperimentRuntimeError(resolution.fail);
  }
  const manifest = resolution.manifest;

  const runConfig = effectiveConfig(workSession, input.regime);
  const run = await mutateDatabase((db) => {
    const record = createExperimentRunRecord({
      workSessionId: workSession.id,
      taskId: null,
      regime: input.regime,
      status: "running",
      config: runConfig,
      entrypoint: manifest.entrypoint,
      datasetRef: describeDataset(runConfig.dataset),
      metricsArtifactId: null,
      reportArtifactId: null,
      checkpointArtifactIds: [],
      hardware: null,
      libraryVersions: null,
      primaryMetric: null,
      summary: "",
      failureSummary: null,
    });
    db.experimentRuns.push(record);
    const session = db.workSessions.find((candidate) => candidate.id === workSession.id);
    if (session !== undefined) {
      session.activeExperimentRunId = record.id;
      updateWorkSessionTimestamp(session);
    }
    return record;
  });

  if (resolution.adopted !== null) {
    logProcess("warn", "experiment.entrypoint.adopted", {
      workSessionId: workSession.id,
      runId: run.id,
      from: resolution.adopted.from,
      to: resolution.adopted.to,
    });
    await emitEvent({
      workSessionId: workSession.id,
      eventName: "experiment.phase",
      aggregateType: "experiment",
      aggregateId: run.id,
      payload: {
        phase: "entrypoint-adopted",
        notes: [
          `The declared entrypoint '${resolution.adopted.from}' was not runnable as the experiment; ` +
            `adopted the conforming trainer at '${resolution.adopted.to}' and pinned it in the orchestrator manifest.`,
        ],
      },
      producer: { module: "experiment-runtime" },
    });
  }

  void executeExperimentRun(run, workSession, manifest, runConfig).catch((error: unknown) => {
    logProcess("error", "experiment.run.crashed", {
      workSessionId: workSession.id,
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return run;
}

async function executeExperimentRun(
  run: ExperimentRunRecord,
  workSession: WorkSessionRecord,
  manifest: ExperimentManifest,
  runConfig: MlRunConfig,
): Promise<void> {
  const config = getConfig();
  const workspacePath = workSession.activeWorktreePath;
  const stamp = Date.now();
  let operation: WorkSessionOperationHandle | null = null;
  let gpuRunId: string | null = null;
  let effectiveConfig = runConfig;
  let intendedDevice: MlDevice = runConfig.device;
  let effectiveDevice: MlDevice | null = null;
  let deviceMismatch = false;
  let venvCapability: VenvCapability | null = null;

  try {
    operation = registerWorkSessionOperation({
      workSessionId: workSession.id,
      kind: "experiment",
      label: `Experiment run (${run.regime})`,
    });

    await emitEvent({
      workSessionId: workSession.id,
      eventName: "experiment.started",
      aggregateType: "experiment",
      aggregateId: run.id,
      payload: { regime: run.regime, entrypoint: manifest.entrypoint },
      producer: { module: "experiment-runtime" },
    });

    await mkdir(path.join(workspacePath, experimentDir), { recursive: true });

    const decision = await prepareAccelerator(run, runConfig, workSession.id, stamp);
    effectiveConfig = decision.config;
    gpuRunId = decision.gpuRunId;
    if (decision.notes.length > 0) {
      await emitEvent({
        workSessionId: workSession.id,
        eventName: "experiment.phase",
        aggregateType: "experiment",
        aggregateId: run.id,
        payload: { phase: "preflight", notes: decision.notes.slice(0, 8) },
        producer: { module: "experiment-runtime" },
      });
    }
    await writeRunConfig(workspacePath, effectiveConfig);

    const metricsRelative = manifest.metrics ?? "metrics.jsonl";
    const summaryRelative = manifest.summary ?? "metrics.json";
    const metricsPath = path.join(workspacePath, metricsRelative);
    const summaryPath = path.join(workspacePath, summaryRelative);
    await rm(metricsPath, { force: true }).catch(() => undefined);
    await rm(summaryPath, { force: true }).catch(() => undefined);

    const installResult = await installMlRequirements({ workspacePath, signal: operation.signal });
    venvCapability = installResult.capability;

    if (run.regime !== "smoke") {
      const preflight = await assertVenvAccelerator(workspacePath, effectiveConfig, operation.signal);
      if (preflight.releaseGpu && gpuRunId !== null) {
        releaseGpu(gpuRunId);
        gpuRunId = null;
      }
      if (preflight.effectiveDevice !== effectiveConfig.device) {
        effectiveConfig = { ...effectiveConfig, device: preflight.effectiveDevice };
        await writeRunConfig(workspacePath, effectiveConfig);
      }
      intendedDevice = preflight.intendedDevice;
      effectiveDevice = preflight.effectiveDevice;
      deviceMismatch = preflight.mismatch;
      if (preflight.notes.length > 0) {
        await emitEvent({
          workSessionId: workSession.id,
          eventName: "experiment.phase",
          aggregateType: "experiment",
          aggregateId: run.id,
          payload: { phase: "accelerator-preflight", notes: preflight.notes.slice(0, 8), intendedDevice, effectiveDevice },
          producer: { module: "experiment-runtime" },
        });
      }
    }

    const python = await resolvePythonCommand(workspacePath);
    const configPath = path.join(workspacePath, experimentDir, "run_config.json");
    const args = run.regime === "smoke" ? [manifest.entrypoint, "--smoke"] : [manifest.entrypoint];
    const timeoutMs = run.regime === "smoke" ? config.mlSmokeTimeoutMs : config.mlJobTimeoutMs;
    const childDevice: MlDevice =
      run.regime === "smoke"
        ? "cpu"
        : effectiveDevice ?? (effectiveConfig.device === "auto" ? "cpu" : effectiveConfig.device);

    const idleLimitMs = config.mlJobHeartbeatIdleMs;
    const startupGraceMs = idleLimitMs > 0 ? idleLimitMs * 4 : 0;
    let sawActivity = false;
    let lastActivityAt = Date.now();
    let idleAborted = false;
    let idleAbortSeconds = Math.round(idleLimitMs / 1000);
    const markActivity = (): void => {
      lastActivityAt = Date.now();
      sawActivity = true;
    };

    let emittedLineCount = 0;
    async function pollMetrics(): Promise<void> {
      try {
        const contents = await readFile(metricsPath, "utf8");
        const lines = parseMetricLines(contents);
        if (lines.length > emittedLineCount) {
          const fresh = lines.slice(emittedLineCount);
          emittedLineCount = lines.length;
          markActivity();
          await emitMetricLines(workSession.id, run.id, fresh);
        }
      } catch {
        return;
      }
    }
    const poller = setInterval(() => {
      void pollMetrics();
    }, 1500);
    const idleWatchdog = idleLimitMs > 0
      ? setInterval(() => {
          const limitMs = sawActivity ? idleLimitMs : startupGraceMs;
          if (!idleAborted && Date.now() - lastActivityAt > limitMs) {
            idleAborted = true;
            idleAbortSeconds = Math.round(limitMs / 1000);
            logProcess("warn", "experiment.idle.timeout", {
              workSessionId: workSession.id,
              runId: run.id,
              idleLimitMs: limitMs,
              phase: sawActivity ? "running" : "startup",
            });
            abortWorkSessionOperationsByKind(
              workSession.id,
              "experiment",
              `No output for ${idleAbortSeconds}s (ML_JOB_HEARTBEAT_IDLE_MS).`,
            );
          }
        }, Math.min(Math.max(idleLimitMs, 1000), 5000))
      : null;

    const result = await runProcess({
      command: python.command,
      args,
      cwd: workspacePath,
      timeoutMs,
      env: createMlJobProcessEnv(
        {
          ...mlCacheEnv(),
          EXPERIMENT_CONFIG: configPath,
          ACF_DEVICE: childDevice,
          CUBLAS_WORKSPACE_CONFIG: ":4096:8",
          ACF_TRUST_REMOTE_CODE: config.mlTrustRemoteCode ? "1" : "0",
        },
        { allowSecrets: config.mlAllowSecrets },
      ),
      signal: operation.signal,
      progress: { onStdout: markActivity, onStderr: markActivity },
    });

    clearInterval(poller);
    if (idleWatchdog !== null) {
      clearInterval(idleWatchdog);
    }
    await pollMetrics();

    if (result.aborted) {
      if (idleAborted) {
        const idleSeconds = idleAbortSeconds;
        await updateRun(run.id, {
          status: "failed",
          endedAt: new Date().toISOString(),
          summary: `Experiment stopped after ${idleSeconds}s with no output (ML_JOB_HEARTBEAT_IDLE_MS).`,
          failureSummary: `No metrics or process output for ${idleSeconds}s; treated as a hung run and stopped.`,
          intendedDevice,
          effectiveDevice,
          deviceMismatch,
        });
        await emitEvent({
          workSessionId: workSession.id,
          eventName: "experiment.failed",
          aggregateType: "experiment",
          aggregateId: run.id,
          payload: { regime: run.regime, summary: `No output for ${idleSeconds}s; stopped as hung.`, intendedDevice, effectiveDevice, deviceMismatch },
          producer: { module: "experiment-runtime" },
        });
        return;
      }
      await updateRun(run.id, { status: "aborted", endedAt: new Date().toISOString(), summary: "Experiment aborted by user." });
      await emitEvent({
        workSessionId: workSession.id,
        eventName: "experiment.aborted",
        aggregateType: "experiment",
        aggregateId: run.id,
        payload: { regime: run.regime },
        producer: { module: "experiment-runtime" },
      });
      return;
    }

    const baseSucceeded = result.exitCode === 0 && !result.timedOut;
    const summaryJson = await readSummary(workspacePath, summaryRelative);
    const scorecard = buildScorecard(summaryJson);
    const contractOk = run.regime === "smoke" ? true : scorecard.ok !== false && scorecard.primary !== null;
    const succeeded = baseSucceeded && contractOk;

    let reportArtifactId: string | null = null;
    if (summaryJson !== null) {
      const scorecardArtifact = await writeScorecardArtifact(workSession.id, scorecard, summaryJson, stamp);
      reportArtifactId = scorecardArtifact.id;
    }
    const provenanceArtifact = await writeProvenanceArtifact({
      workSessionId: workSession.id,
      workspacePath,
      config: effectiveConfig,
      stamp,
      signal: operation.signal,
      capability: venvCapability,
      intendedDevice,
      effectiveDevice,
      deviceMismatch,
    }).catch(() => null);

    let metricsArtifactId: string | null = null;
    try {
      const metricsContents = await readFile(metricsPath, "utf8");
      if (metricsContents.trim().length > 0) {
        const metricsArtifact = await saveArtifact({
          workSessionId: workSession.id,
          kind: "report",
          fileName: `ml-metrics-${stamp}.jsonl`,
          content: metricsContents,
          metadata: { reportType: "ml_metrics", summary: `metrics stream for ${run.regime} run` },
        });
        metricsArtifactId = metricsArtifact.id;
      }
    } catch {
      metricsArtifactId = null;
    }

    const summaryText = result.timedOut
      ? `Experiment timed out after ${Math.round(timeoutMs / 1000)}s.`
      : !baseSucceeded
        ? `Experiment exited with code ${result.exitCode ?? "unknown"}.`
        : run.regime === "smoke" && scorecard.primary === null && scorecard.ok !== false
          ? "Smoke checks passed."
          : scorecardSummaryText(scorecard);

    await updateRun(run.id, {
      status: succeeded ? "succeeded" : "failed",
      endedAt: new Date().toISOString(),
      primaryMetric: scorecard.primary,
      metricsArtifactId,
      reportArtifactId: reportArtifactId ?? provenanceArtifact?.id ?? null,
      summary: summaryText,
      failureSummary: succeeded ? null : `${summaryText}\n${(result.stderr || result.stdout).slice(-2000)}`,
      intendedDevice,
      effectiveDevice,
      deviceMismatch,
    });

    await emitEvent({
      workSessionId: workSession.id,
      eventName: succeeded ? "experiment.completed" : "experiment.failed",
      aggregateType: "experiment",
      aggregateId: run.id,
      payload: {
        regime: run.regime,
        summary: summaryText,
        intendedDevice,
        effectiveDevice,
        deviceMismatch,
        primary: scorecard.primary === null
          ? null
          : { name: scorecard.primary.name, value: scorecard.primary.value, split: scorecard.primary.split },
      },
      producer: { module: "experiment-runtime" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRun(run.id, {
      status: "failed",
      endedAt: new Date().toISOString(),
      summary: "Experiment runtime error.",
      failureSummary: message.slice(0, 2000),
      intendedDevice,
      effectiveDevice,
      deviceMismatch,
    });
    await emitEvent({
      workSessionId: workSession.id,
      eventName: "experiment.failed",
      aggregateType: "experiment",
      aggregateId: run.id,
      payload: { regime: run.regime, summary: message.slice(0, 500), intendedDevice, effectiveDevice, deviceMismatch },
      producer: { module: "experiment-runtime" },
    }).catch(() => undefined);
  } finally {
    if (gpuRunId !== null) {
      releaseGpu(gpuRunId);
    }
    operation?.unregister();
    await mutateDatabase((db) => {
      const session = db.workSessions.find((candidate) => candidate.id === workSession.id);
      if (session !== undefined && session.activeExperimentRunId === run.id) {
        session.activeExperimentRunId = null;
      }
    }).catch(() => undefined);
  }
}
