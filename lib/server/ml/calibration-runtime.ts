import path from "node:path";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { resolvePythonCommand } from "@/lib/server/runtime/python-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";
import {
  registerWorkSessionOperation,
  type WorkSessionOperationHandle,
} from "@/lib/server/runtime/operation-registry";
import {
  readExperimentManifest,
  type CalibrationDeclaration,
} from "@/lib/server/ml/experiment-manifest";
import { parseMetricLines, type MetricLine } from "@/lib/server/ml/metrics-contract";
import { buildScorecard, readSummary, scorecardSummaryText } from "@/lib/server/ml/scorecard";
import { emptyMlRunConfig } from "@/lib/server/ml/run-config";
import { mlCacheEnv, readVenvCapabilityArtifact } from "@/lib/server/ml/ml-env";
import { installMlRequirements } from "@/lib/server/ml/ml-installer";
import { tryAcquireGpu, releaseGpu, gpuHeldBy } from "@/lib/server/ml/gpu-mutex";
import { ensureInferenceWorker, stopInferenceWorker, stopInferenceWorkersHoldingGpu } from "@/lib/server/ml/inference-runtime";
import type { ExperimentRunRecord, MlDevice, MlRunConfig, WorkSessionRecord } from "@/lib/shared/types";

export class CalibrationRuntimeError extends Error {}

const calibrationDir = path.join(".orchestrator", "calibration");

const DEFAULT_CHECKPOINT = "checkpoints/best.pt";
const DEFAULT_OUTPUT_CHECKPOINT = "artifacts/example_or_latest_checkpoint.pt";
const DEFAULT_REPORT = "artifacts/calibration_report.json";
const CALIBRATION_METRICS = path.join(calibrationDir, "metrics.jsonl");
const CALIBRATION_SUMMARY = path.join(calibrationDir, "metrics.json");

export interface ResolvedCalibrationPaths {
  checkpoint: string;
  calibrationData: string | null;
  oodValidationData: string | null;
  outputCheckpoint: string;
  report: string;
}

export interface CalibrationDataEntry {
  path: string;
  kind: "dir" | "file";
}

const MAX_DATA_ENTRY_OPTIONS = 1000;
const MAX_DATA_ENTRY_DEPTH = 4;

async function scanDataEntries(workspacePath: string): Promise<CalibrationDataEntry[]> {
  const dataDir = path.join(workspacePath, "data");
  try {
    const out: CalibrationDataEntry[] = [];
    const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
      if (out.length >= MAX_DATA_ENTRY_OPTIONS || depth > MAX_DATA_ENTRY_DEPTH) {
        return;
      }
      const entries = await readdir(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (out.length >= MAX_DATA_ENTRY_OPTIONS || entry.name.startsWith(".")) {
          continue;
        }
        const rel = `${relDir}/${entry.name}`;
        const abs = path.join(absDir, entry.name);
        if (entry.isDirectory()) {
          out.push({ path: rel, kind: "dir" });
          await walk(abs, rel, depth + 1);
        } else if (entry.isFile()) {
          out.push({ path: rel, kind: "file" });
        }
      }
    };
    await walk(dataDir, "data", 1);
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  } catch {
    return [];
  }
}

function normalizeOverridePath(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return cleaned.length > 0 ? cleaned : null;
}

export interface CalibrationStatus {
  enabled: boolean;
  available: boolean;
  reason: string | null;
  calibration: CalibrationDeclaration | null;
  paths: ResolvedCalibrationPaths | null;
  bestCheckpointExists: boolean;
  calibrationDataExists: boolean;
  oodValidationExists: boolean;
  latestTrainingRun: ExperimentRunRecord | null;
  latestCalibrationRun: ExperimentRunRecord | null;
  active: boolean;
  dataEntries: CalibrationDataEntry[];
}

function resolvePaths(calibration: CalibrationDeclaration): ResolvedCalibrationPaths {
  return {
    checkpoint: calibration.defaultCheckpoint ?? DEFAULT_CHECKPOINT,
    calibrationData: calibration.defaultCalibrationData,
    oodValidationData: calibration.defaultOodValidationData,
    outputCheckpoint: calibration.defaultOutputCheckpoint ?? DEFAULT_OUTPUT_CHECKPOINT,
    report: calibration.defaultReport ?? DEFAULT_REPORT,
  };
}

function resolveWorkspacePath(workspacePath: string, rel: string): string | null {
  const base = path.resolve(workspacePath);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return null;
  }
  return target;
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

function latestRun(
  runs: ExperimentRunRecord[],
  workSessionId: string,
  predicate: (run: ExperimentRunRecord) => boolean,
): ExperimentRunRecord | null {
  const owned = runs
    .filter((run) => run.workSessionId === workSessionId && predicate(run))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return owned[0] ?? null;
}

function activeRun(runs: ExperimentRunRecord[], workSessionId: string): boolean {
  return runs.some(
    (run) => run.workSessionId === workSessionId && (run.status === "running" || run.status === "queued"),
  );
}

function latestTrainingRun(
  runs: ExperimentRunRecord[],
  workSessionId: string,
): ExperimentRunRecord | null {
  return latestRun(
    runs,
    workSessionId,
    (run) => run.status === "succeeded" && (run.regime === "full" || run.regime === "short"),
  );
}

export async function getCalibrationStatus(
  workSessionId: string,
  options: { allowShort?: boolean; calibrationDataOverride?: string; oodValidationOverride?: string } = {},
): Promise<CalibrationStatus> {
  const config = getConfig();
  const empty: CalibrationStatus = {
    enabled: false,
    available: false,
    reason: null,
    calibration: null,
    paths: null,
    bestCheckpointExists: false,
    calibrationDataExists: false,
    oodValidationExists: false,
    latestTrainingRun: null,
    latestCalibrationRun: null,
    active: false,
    dataEntries: [],
  };

  const snapshot = await getDatabaseSnapshot();
  const workSession = snapshot.workSessions.find((session) => session.id === workSessionId);
  if (workSession === undefined) {
    return { ...empty, reason: "Work session was not found." };
  }
  if (!config.mlPipelineEnabled) {
    return { ...empty, reason: "The ML pipeline is disabled (set ML_PIPELINE_ENABLED=true)." };
  }

  const dataEntries = await scanDataEntries(workSession.activeWorktreePath);
  const manifest = await readExperimentManifest(workSession.activeWorktreePath);
  const calibration = manifest?.calibration ?? null;
  const latestCalibrationRun = latestRun(snapshot.experimentRuns, workSessionId, (run) => run.regime === "calibration");
  const trainingRun = latestTrainingRun(snapshot.experimentRuns, workSessionId);
  const active = activeRun(snapshot.experimentRuns, workSessionId);

  if (calibration === null) {
    return {
      ...empty,
      reason: "This workspace does not declare a calibration entrypoint in experiment.json.",
      latestCalibrationRun,
      latestTrainingRun: trainingRun,
      active,
      dataEntries,
    };
  }

  const paths = resolvePaths(calibration);
  const calibrationOverride = normalizeOverridePath(options.calibrationDataOverride);
  if (calibrationOverride !== null) {
    paths.calibrationData = calibrationOverride;
  }
  const oodOverride = normalizeOverridePath(options.oodValidationOverride);
  if (oodOverride !== null) {
    paths.oodValidationData = oodOverride;
  }
  const checkpointAbs = resolveWorkspacePath(workSession.activeWorktreePath, paths.checkpoint);
  const calibrationDataAbs = paths.calibrationData
    ? resolveWorkspacePath(workSession.activeWorktreePath, paths.calibrationData)
    : null;
  const oodAbs = paths.oodValidationData
    ? resolveWorkspacePath(workSession.activeWorktreePath, paths.oodValidationData)
    : null;

  const bestCheckpointExists = checkpointAbs !== null && (await pathExists(checkpointAbs));
  const calibrationDataExists = calibrationDataAbs !== null && (await pathExists(calibrationDataAbs));
  const oodValidationExists = oodAbs !== null && (await pathExists(oodAbs));

  let reason: string | null = null;
  if (active) {
    reason = "A training or calibration run is currently in progress.";
  } else if (!bestCheckpointExists) {
    reason = `No trained checkpoint found at '${paths.checkpoint}'. Train the model first, or point calibration.defaultCheckpoint at the saved checkpoint.`;
  } else if (paths.calibrationData === null) {
    reason = "No calibration dataset is declared (calibration.defaultCalibrationData).";
  } else if (!calibrationDataExists) {
    reason = `Calibration dataset '${paths.calibrationData}' was not found. Use the "choose file" menu to pick or upload one.`;
  }

  return {
    enabled: true,
    available: reason === null,
    reason,
    calibration,
    paths,
    bestCheckpointExists,
    calibrationDataExists,
    oodValidationExists,
    latestTrainingRun: trainingRun,
    latestCalibrationRun,
    active,
    dataEntries,
  };
}

async function updateRun(runId: string, patch: Partial<ExperimentRunRecord>): Promise<void> {
  await mutateDatabase((db) => {
    const record = db.experimentRuns.find((run) => run.id === runId);
    if (record !== undefined) {
      Object.assign(record, patch);
    }
  });
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
          payload: { phase: line.phase, t: line.t, regime: "calibration" },
          producer: { module: "calibration-runtime" },
        }
      : {
          workSessionId,
          eventName: "experiment.metric",
          aggregateType: "experiment",
          aggregateId: runId,
          payload: { name: line.name, value: line.value, split: line.split, step: line.step, depth: line.depth, t: line.t, regime: "calibration" },
          producer: { module: "calibration-runtime" },
        },
  );
  await emitEvents(inputs);
}

export interface StartCalibrationInput {
  workSessionId: string;
  smoke?: boolean;
  allowShort?: boolean;
  autoRestartInference?: boolean;
  /** Optional user-chosen calibration dataset (from the "choose file" menu); overrides the manifest default. */
  calibrationData?: string;
  /** Optional user-chosen OOD validation dataset; overrides the manifest default. */
  oodValidationData?: string;
}

export async function startCalibrationRun(input: StartCalibrationInput): Promise<ExperimentRunRecord> {
  const config = getConfig();
  if (!config.mlPipelineEnabled) {
    throw new CalibrationRuntimeError("The ML pipeline is disabled (set ML_PIPELINE_ENABLED=true).");
  }

  const snapshot = await getDatabaseSnapshot();
  const workSession = snapshot.workSessions.find((session) => session.id === input.workSessionId);
  if (workSession === undefined) {
    throw new CalibrationRuntimeError("Work session was not found.");
  }
  await assertSafeWorkspace(workSession.activeWorktreePath, { operation: "calibration" });

  const status = await getCalibrationStatus(input.workSessionId, {
    allowShort: input.allowShort,
    calibrationDataOverride: input.calibrationData,
    oodValidationOverride: input.oodValidationData,
  });
  if (!status.enabled || status.calibration === null || status.paths === null) {
    throw new CalibrationRuntimeError(
      status.reason ?? "Calibration is not available for this workspace.",
    );
  }
  if (input.smoke !== true && !status.available) {
    throw new CalibrationRuntimeError(status.reason ?? "Calibration preconditions are not met.");
  }

  const runConfig: MlRunConfig = { ...(workSession.mlRunConfig ?? emptyMlRunConfig()), regime: "calibration" };
  const run = await mutateDatabase((db) => {
    const record = createExperimentRunRecord({
      workSessionId: workSession.id,
      taskId: null,
      regime: "calibration",
      status: "running",
      config: runConfig,
      entrypoint: status.calibration!.entrypoint,
      datasetRef: status.paths!.calibrationData,
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

  void executeCalibrationRun(run, workSession, status.calibration, status.paths, status.latestTrainingRun, {
    smoke: input.smoke === true,
    autoRestartInference: input.autoRestartInference !== false,
  }).catch((error: unknown) => {
    logProcess("error", "calibration.run.crashed", {
      workSessionId: workSession.id,
      runId: run.id,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  return run;
}

async function executeCalibrationRun(
  run: ExperimentRunRecord,
  workSession: WorkSessionRecord,
  calibration: CalibrationDeclaration,
  paths: ResolvedCalibrationPaths,
  trainingRun: ExperimentRunRecord | null,
  options: { smoke: boolean; autoRestartInference: boolean },
): Promise<void> {
  const config = getConfig();
  const workspacePath = workSession.activeWorktreePath;
  const stamp = Date.now();
  const smoke = options.smoke;
  let operation: WorkSessionOperationHandle | null = null;
  let gpuRunId: string | null = null;
  let effectiveDevice: MlDevice = "cpu";

  try {
    operation = registerWorkSessionOperation({
      workSessionId: workSession.id,
      kind: "calibration",
      label: smoke ? "Calibration smoke" : "Post-training calibration",
    });

    await emitEvent({
      workSessionId: workSession.id,
      eventName: "experiment.started",
      aggregateType: "experiment",
      aggregateId: run.id,
      payload: { regime: "calibration", entrypoint: calibration.entrypoint, smoke },
      producer: { module: "calibration-runtime" },
    });

    await mkdir(path.join(workspacePath, calibrationDir), { recursive: true });

    await stopInferenceWorker(workSession.id, "Stopped to run post-training calibration.").catch(() => undefined);

    await installMlRequirements({ workspacePath, signal: operation.signal });

    const capability = await readVenvCapabilityArtifact(workspacePath);
    const acceleratorAvailable = capability !== null && (capability.cudaAvailable || capability.mpsAvailable);
    const usesGpu = !smoke && config.mlAllowGpu && acceleratorAvailable;
    if (usesGpu) {
      const evicted = await stopInferenceWorkersHoldingGpu();
      if (evicted > 0) {
        logProcess("info", "calibration.gpu.evicted_inference", { workSessionId: workSession.id, evicted });
      }
      const holder = gpuHeldBy();
      if (holder !== null && holder !== run.id) {
        throw new CalibrationRuntimeError(
          "Another GPU job is already running on this machine; only one accelerator job runs at a time.",
        );
      }
      if (!tryAcquireGpu(run.id)) {
        throw new CalibrationRuntimeError("Could not acquire the GPU lock for calibration.");
      }
      gpuRunId = run.id;
      effectiveDevice = capability!.cudaAvailable ? "cuda" : "mps";
    }

    const checkpointAbs = resolveWorkspacePath(workspacePath, paths.checkpoint);
    if (checkpointAbs === null) {
      throw new CalibrationRuntimeError(`Checkpoint path escapes the workspace: ${paths.checkpoint}`);
    }
    const frozenRel = path.posix.join("checkpoints", "frozen", `best_uncalibrated_${stamp}.pt`);
    const frozenAbs = resolveWorkspacePath(workspacePath, frozenRel);
    if (frozenAbs === null) {
      throw new CalibrationRuntimeError("Could not resolve the frozen checkpoint path.");
    }
    if (!smoke) {
      if (!(await pathExists(checkpointAbs))) {
        throw new CalibrationRuntimeError(`Best checkpoint '${paths.checkpoint}' was not found; cannot calibrate.`);
      }
      await mkdir(path.dirname(frozenAbs), { recursive: true });
      await copyFile(checkpointAbs, frozenAbs);
    }

    await emitEvent({
      workSessionId: workSession.id,
      eventName: "experiment.phase",
      aggregateType: "experiment",
      aggregateId: run.id,
      payload: {
        phase: "freeze",
        regime: "calibration",
        notes: smoke ? ["Smoke run: skipped checkpoint freeze."] : [`Froze ${paths.checkpoint} -> ${frozenRel}`],
      },
      producer: { module: "calibration-runtime" },
    });

    const configRel = path.posix.join(".orchestrator", "calibration", "calibration_config.json");
    const configAbs = path.join(workspacePath, calibrationDir, "calibration_config.json");
    const calibrationConfig = {
      checkpoint_path: smoke ? paths.checkpoint : frozenRel,
      source_best_checkpoint: paths.checkpoint,
      frozen_uncalibrated_checkpoint: smoke ? null : frozenRel,
      calibration_path: paths.calibrationData,
      ood_validation_path: paths.oodValidationData,
      output_checkpoint_path: paths.outputCheckpoint,
      calibrated_serving_checkpoint: paths.outputCheckpoint,
      report_path: paths.report,
      metrics_path: CALIBRATION_METRICS.replace(/\\/g, "/"),
      summary_path: CALIBRATION_SUMMARY.replace(/\\/g, "/"),
      device: effectiveDevice,
      seed: run.config.seed,
      source_training_run_id: trainingRun?.id ?? null,
      smoke,
    };
    await writeFile(configAbs, `${JSON.stringify(calibrationConfig, null, 2)}\n`, "utf8");

    const metricsAbs = path.join(workspacePath, CALIBRATION_METRICS);
    const summaryAbs = path.join(workspacePath, CALIBRATION_SUMMARY);
    const reportAbs = resolveWorkspacePath(workspacePath, paths.report);
    const outputAbs = resolveWorkspacePath(workspacePath, paths.outputCheckpoint);
    await rm(metricsAbs, { force: true }).catch(() => undefined);
    await rm(summaryAbs, { force: true }).catch(() => undefined);

    const python = await resolvePythonCommand(workspacePath);
    const args = smoke ? [calibration.entrypoint, "--smoke"] : [calibration.entrypoint];
    const timeoutMs = smoke ? config.mlSmokeTimeoutMs : config.mlJobTimeoutMs;

    let emittedLineCount = 0;
    async function pollMetrics(): Promise<void> {
      try {
        const contents = await readFile(metricsAbs, "utf8");
        const lines = parseMetricLines(contents);
        if (lines.length > emittedLineCount) {
          const fresh = lines.slice(emittedLineCount);
          emittedLineCount = lines.length;
          await emitMetricLines(workSession.id, run.id, fresh);
        }
      } catch {
        return;
      }
    }
    const poller = setInterval(() => {
      void pollMetrics();
    }, 1500);

    const result = await runProcess({
      command: python.command,
      args,
      cwd: workspacePath,
      timeoutMs,
      env: createMlJobProcessEnv(
        {
          ...mlCacheEnv(),
          CALIBRATION_CONFIG: configAbs,
          ACF_CALIBRATION_CONFIG: configRel,
          ACF_DEVICE: effectiveDevice,
          CUBLAS_WORKSPACE_CONFIG: ":4096:8",
          ACF_TRUST_REMOTE_CODE: config.mlTrustRemoteCode ? "1" : "0",
        },
        { allowSecrets: config.mlAllowSecrets },
      ),
      signal: operation.signal,
    });

    clearInterval(poller);
    await pollMetrics();

    if (result.aborted) {
      await updateRun(run.id, {
        status: "aborted",
        endedAt: new Date().toISOString(),
        summary: "Calibration aborted by user.",
        effectiveDevice,
      });
      await emitEvent({
        workSessionId: workSession.id,
        eventName: "experiment.aborted",
        aggregateType: "experiment",
        aggregateId: run.id,
        payload: { regime: "calibration" },
        producer: { module: "calibration-runtime" },
      });
      return;
    }

    const baseSucceeded = result.exitCode === 0 && !result.timedOut;
    const summaryJson = await readSummary(workspacePath, CALIBRATION_SUMMARY);
    const scorecard = buildScorecard(summaryJson);
    const reportWritten = reportAbs !== null && (await pathExists(reportAbs));
    const outputWritten = outputAbs !== null && (await pathExists(outputAbs));
    const contractOk = smoke
      ? true
      : scorecard.ok !== false && reportWritten && outputWritten;
    const succeeded = baseSucceeded && contractOk;

    let reportArtifactId: string | null = null;
    if (reportWritten && reportAbs !== null) {
      try {
        const reportContent = await readFile(reportAbs, "utf8");
        const artifact = await saveArtifact({
          workSessionId: workSession.id,
          kind: "report",
          fileName: `ml-calibration-${stamp}.json`,
          content: reportContent,
          metadata: {
            reportType: "ml_calibration",
            summary: scorecard.primary !== null
              ? scorecardSummaryText(scorecard)
              : "Post-training calibration report.",
          },
        });
        reportArtifactId = artifact.id;
      } catch {
        reportArtifactId = null;
      }
    }

    let metricsArtifactId: string | null = null;
    try {
      const metricsContents = await readFile(metricsAbs, "utf8");
      if (metricsContents.trim().length > 0) {
        const metricsArtifact = await saveArtifact({
          workSessionId: workSession.id,
          kind: "report",
          fileName: `ml-calibration-metrics-${stamp}.jsonl`,
          content: metricsContents,
          metadata: { reportType: "ml_metrics", summary: "calibration metrics stream" },
        });
        metricsArtifactId = metricsArtifact.id;
      }
    } catch {
      metricsArtifactId = null;
    }

    const summaryText = result.timedOut
      ? `Calibration timed out after ${Math.round(timeoutMs / 1000)}s.`
      : !baseSucceeded
        ? `Calibration exited with code ${result.exitCode ?? "unknown"}.`
        : !contractOk
          ? smoke
            ? "Calibration smoke failed."
            : `Calibration produced no ${reportWritten ? "serving checkpoint" : "calibration report"}.`
          : smoke
            ? "Calibration smoke passed."
            : scorecard.primary !== null
              ? scorecardSummaryText(scorecard)
              : "Calibrated serving checkpoint ready.";

    await updateRun(run.id, {
      status: succeeded ? "succeeded" : "failed",
      endedAt: new Date().toISOString(),
      primaryMetric: scorecard.primary,
      metricsArtifactId,
      reportArtifactId,
      summary: summaryText,
      failureSummary: succeeded ? null : `${summaryText}\n${(result.stderr || result.stdout).slice(-2000)}`,
      effectiveDevice,
    });

    await emitEvent({
      workSessionId: workSession.id,
      eventName: succeeded ? "experiment.completed" : "experiment.failed",
      aggregateType: "experiment",
      aggregateId: run.id,
      payload: {
        regime: "calibration",
        summary: summaryText,
        smoke,
        servingCheckpoint: succeeded && !smoke ? paths.outputCheckpoint : null,
        frozenCheckpoint: succeeded && !smoke ? frozenRel : null,
        primary: scorecard.primary === null
          ? null
          : { name: scorecard.primary.name, value: scorecard.primary.value, split: scorecard.primary.split },
      },
      producer: { module: "calibration-runtime" },
    });

    if (succeeded && !smoke && options.autoRestartInference) {
      await ensureInferenceWorker(workSession.id).catch((error: unknown) => {
        logProcess("warn", "calibration.inference.restart_failed", {
          workSessionId: workSession.id,
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRun(run.id, {
      status: "failed",
      endedAt: new Date().toISOString(),
      summary: "Calibration runtime error.",
      failureSummary: message.slice(0, 2000),
      effectiveDevice,
    });
    await emitEvent({
      workSessionId: workSession.id,
      eventName: "experiment.failed",
      aggregateType: "experiment",
      aggregateId: run.id,
      payload: { regime: "calibration", summary: message.slice(0, 500) },
      producer: { module: "calibration-runtime" },
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
