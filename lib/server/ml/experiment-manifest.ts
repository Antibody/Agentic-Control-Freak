import path from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { normalizeInferenceContract, type InferenceContract } from "@/lib/shared/inference-contract";
import type { MlDataContract, MlDatasetFormat, MlDatasetMode } from "@/lib/shared/types";

export interface ManifestPredictDeclaration {
  /** Workspace-relative `.py` entrypoint exposing the Inference Protocol (CONTRACT/load/predict). */
  entrypoint: string;
  /** Static contract for pre-warm widget rendering; the live worker handshake is authoritative. */
  contract: InferenceContract | null;
}

/**
 * Optional post-training calibration surface. When present, ACF offers a "Calibrate best model" action after
 * a successful full training run. Calibration NEVER updates model weights — the declared entrypoint fits
 * post-hoc parameters (probability calibrators, uncertainty scaling, applicability thresholds) against the
 * calibration split and writes a separate calibrated SERVING checkpoint that inference loads. Projects
 * without this block never show the calibration UI (model-agnostic, opt-in).
 */
export interface CalibrationDeclaration {
  /** Workspace-relative `.py` entrypoint ACF runs (`python <entrypoint>`; supports `--smoke`). */
  entrypoint: string;
  /** Uncalibrated input checkpoint (the trained best model). Defaults to checkpoints/best.pt downstream. */
  defaultCheckpoint: string | null;
  /** Calibration-split dataset (must NOT be the test split). */
  defaultCalibrationData: string | null;
  /** Optional out-of-distribution validation set for applicability/OOD calibration. */
  defaultOodValidationData: string | null;
  /** Calibrated serving checkpoint to write (what inference's load_predictor resolves). */
  defaultOutputCheckpoint: string | null;
  /** Calibration report JSON the entrypoint writes (stored as an artifact). */
  defaultReport: string | null;
}

export interface ExperimentManifest {
  kind: string;
  entrypoint: string;
  metrics: string | null;
  summary: string | null;
  /** Optional inference surface; absent for legacy manifests and non-model scaffolds (back-compatible). */
  predict?: ManifestPredictDeclaration | null;
  /** Optional data contract: how the user should feed this model. Absent for legacy manifests. */
  data?: MlDataContract | null;
  /** Optional post-training calibration surface; absent for legacy manifests and non-model scaffolds. */
  calibration?: CalibrationDeclaration | null;
}

const DATASET_MODES: MlDatasetMode[] = ["builtin", "single_corpus", "train_test", "train_val_test", "jsonl_finetune", "custom"];
const DATASET_FORMATS: MlDatasetFormat[] = ["auto", "text", "jsonl", "csv", "image_folder", "other"];

function parseManifestData(raw: unknown): MlDataContract | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const recommendedMode = DATASET_MODES.find((mode) => mode === candidate.recommendedMode);
  if (recommendedMode === undefined) {
    return null;
  }
  const format = DATASET_FORMATS.find((value) => value === candidate.format) ?? "auto";
  const supportedModes = Array.isArray(candidate.supportedModes)
    ? candidate.supportedModes.filter((mode): mode is MlDatasetMode => DATASET_MODES.some((known) => known === mode))
    : [];
  return {
    recommendedMode,
    supportedModes: supportedModes.length > 0 ? supportedModes : [recommendedMode],
    format,
    accept: typeof candidate.accept === "string" ? candidate.accept : null,
    builtinFallback: candidate.builtinFallback === true,
    guidance: typeof candidate.guidance === "string" ? candidate.guidance : "",
  };
}

const ownedManifestRelative = path.join(".orchestrator", "experiment", "manifest.json");

const entrypointPriority = [
  "train.py",
  "main.py",
  "run.py",
  "finetune.py",
  "quantize.py",
  "distill.py",
  "trm.py",
  "inference.py",
  "eval.py",
];

function isSafeRelativeEntrypoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return false;
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    return false;
  }
  return normalized.endsWith(".py");
}

function parseManifestPredict(raw: unknown): ManifestPredictDeclaration | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (!isSafeRelativeEntrypoint(candidate.entrypoint)) {
    return null;
  }
  return {
    entrypoint: candidate.entrypoint.replace(/\\/g, "/"),
    contract: normalizeInferenceContract(candidate.contract),
  };
}

function asSafeRelativeResource(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    return null;
  }
  if (normalized.split("/").some((segment) => segment === "..")) {
    return null;
  }
  return normalized;
}

function parseManifestCalibration(raw: unknown): CalibrationDeclaration | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (!isSafeRelativeEntrypoint(candidate.entrypoint)) {
    return null;
  }
  return {
    entrypoint: candidate.entrypoint.replace(/\\/g, "/"),
    defaultCheckpoint: asSafeRelativeResource(candidate.defaultCheckpoint),
    defaultCalibrationData: asSafeRelativeResource(candidate.defaultCalibrationData),
    defaultOodValidationData: asSafeRelativeResource(candidate.defaultOodValidationData),
    defaultOutputCheckpoint: asSafeRelativeResource(candidate.defaultOutputCheckpoint),
    defaultReport: asSafeRelativeResource(candidate.defaultReport),
  };
}

function parseManifest(raw: string): ExperimentManifest | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!isSafeRelativeEntrypoint(parsed.entrypoint)) {
    return null;
  }
  return {
    kind: typeof parsed.kind === "string" ? parsed.kind : "ml",
    entrypoint: parsed.entrypoint.replace(/\\/g, "/"),
    metrics: typeof parsed.metrics === "string" ? parsed.metrics : null,
    summary: typeof parsed.summary === "string" ? parsed.summary : null,
    predict: parseManifestPredict(parsed.predict),
    data: parseManifestData(parsed.data),
    calibration: parseManifestCalibration(parsed.calibration),
  };
}

async function readRootCalibration(workspacePath: string): Promise<CalibrationDeclaration | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(workspacePath, "experiment.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  return parseManifestCalibration((parsed as Record<string, unknown>).calibration);
}

async function readManifestFile(file: string): Promise<ExperimentManifest | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  return parseManifest(raw);
}

export async function writeExperimentManifest(workspacePath: string, manifest: ExperimentManifest): Promise<void> {
  const target = path.join(workspacePath, ownedManifestRelative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function reconstructManifest(workspacePath: string): Promise<ExperimentManifest | null> {
  let names: string[];
  try {
    names = (await readdir(workspacePath, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  let best: { name: string; score: number } | null = null;
  for (const name of names) {
    let source: string;
    try {
      source = await readFile(path.join(workspacePath, name), "utf8");
    } catch {
      continue;
    }
    if (!source.includes("__main__") || !/--smoke/.test(source)) {
      continue;
    }
    const index = entrypointPriority.indexOf(name);
    const score = index >= 0 ? 100 - index : 1;
    if (best === null || score > best.score) {
      best = { name, score };
    }
  }
  if (best === null) {
    return null;
  }
  return { kind: "ml", entrypoint: best.name, metrics: "metrics.jsonl", summary: "metrics.json" };
}

/** Directories never worth scanning for a project entrypoint (vendored / generated / virtualenvs). */
const SCAN_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".orchestrator",
  ".next",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "site-packages",
  "dist",
  "build",
  ".mypy_cache",
  ".pytest_cache",
  "checkpoints",
  "outputs",
  "runs",
  "artifacts",
  "data",
]);

/** Bundled scaffold entrypoints the authoring agent is expected to outgrow (placeholders). */
const PLACEHOLDER_ENTRYPOINTS = new Set(["sim.py"]);

function entrypointScore(baseName: string): number {
  const index = entrypointPriority.indexOf(baseName);
  return index >= 0 ? 100 - index : 1;
}

function baseNameOf(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

interface EntrypointCandidate {
  relPath: string;
  baseName: string;
  score: number;
  depth: number;
}

async function scanForMlEntrypoints(workspacePath: string, maxDepth: number): Promise<EntrypointCandidate[]> {
  const found: EntrypointCandidate[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".py")) {
        let source: string;
        try {
          source = await readFile(full, "utf8");
        } catch {
          continue;
        }
        if (!source.includes("__main__") || !/--smoke/.test(source)) {
          continue;
        }
        const relPath = path.relative(workspacePath, full).replace(/\\/g, "/");
        found.push({ relPath, baseName: entry.name, score: entrypointScore(entry.name), depth });
      } else if (
        entry.isDirectory() &&
        depth < maxDepth &&
        !SCAN_SKIP_DIRS.has(entry.name) &&
        !entry.name.startsWith(".")
      ) {
        await walk(full, depth + 1);
      }
    }
  }
  await walk(workspacePath, 0);
  return found;
}

async function entrypointConforms(workspacePath: string, relPath: string): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(path.join(workspacePath, relPath), "utf8");
  } catch {
    return false;
  }
  return source.includes("__main__") && /--smoke/.test(source);
}

export interface EntrypointResolution {
  /** The manifest to actually run (entrypoint repointed when a stronger one was adopted). */
  manifest: ExperimentManifest;
  /** Set when the run entrypoint was repointed away from the manifest's declared one. */
  adopted: { from: string; to: string } | null;
  /** Set when no runnable entrypoint exists; the caller should fail the run with this message. */
  fail: string | null;
}

/**
 * Decide which entrypoint the orchestrator should actually run, so the app trains the REAL model rather
 * than silently running an abandoned scaffold stub. Policy (adopt-if-conforming, else fail loudly):
 *  - If the manifest entrypoint exists, conforms (has __main__ + --smoke), and is not a bundled
 *    placeholder, trust it and run as-is.
 *  - Otherwise (the active entrypoint is a placeholder, is missing, or lacks a --smoke gate) scan the
 *    workspace (root + shallow subdirs) for a conforming ML entrypoint and ADOPT the strongest one,
 *    writing the orchestrator-owned manifest so the run and all later reads use it.
 *  - If the active entrypoint is not runnable and nothing conforming is found, return a fail message so
 *    the caller can fail the run with a precise repair instruction (never silently run a broken stub).
 * Adoption preserves the manifest's predict/data declarations and fills metric/summary defaults.
 */
export async function resolveExperimentEntrypoint(
  workspacePath: string,
  manifest: ExperimentManifest,
): Promise<EntrypointResolution> {
  const activeRel = manifest.entrypoint.replace(/\\/g, "/");
  const activeBase = baseNameOf(activeRel);
  const activeIsPlaceholder = manifest.kind === "numerical" || PLACEHOLDER_ENTRYPOINTS.has(activeBase);
  const activeConforms = await entrypointConforms(workspacePath, activeRel);

  if (activeConforms && !activeIsPlaceholder) {
    return { manifest, adopted: null, fail: null };
  }

  const activeScore = entrypointScore(activeBase);
  const candidates = await scanForMlEntrypoints(workspacePath, 2);
  let best: EntrypointCandidate | null = null;
  for (const candidate of candidates) {
    if (candidate.relPath === activeRel) {
      continue;
    }
    const qualifies = activeConforms ? candidate.score > activeScore : true;
    if (!qualifies) {
      continue;
    }
    if (
      best === null ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.depth < best.depth) ||
      (candidate.score === best.score && candidate.depth === best.depth && candidate.relPath < best.relPath)
    ) {
      best = candidate;
    }
  }

  if (best !== null) {
    const adoptedManifest: ExperimentManifest = {
      ...manifest,
      entrypoint: best.relPath,
      metrics: manifest.metrics ?? "metrics.jsonl",
      summary: manifest.summary ?? "metrics.json",
    };
    await writeExperimentManifest(workspacePath, adoptedManifest).catch(() => undefined);
    return { manifest: adoptedManifest, adopted: { from: activeRel, to: best.relPath }, fail: null };
  }

  if (!activeConforms) {
    return {
      manifest,
      adopted: null,
      fail:
        `The experiment entrypoint '${activeRel}' is missing or has no --smoke gate, and no runnable ML ` +
        `entrypoint (a .py with a __main__ block and a --smoke flag) was found in the workspace. Make ` +
        `'${activeRel}' runnable as 'python ${activeRel} --smoke', or add a conforming trainer at the ` +
        `workspace root so the orchestrator can train the model.`,
    };
  }

  return { manifest, adopted: null, fail: null };
}

const AGENT_DATA_CONTRACT_PATHS = [
  "data_contract.json",
  path.join(".orchestrator", "experiment", "data_contract.json"),
];

async function readAgentDataContract(workspacePath: string): Promise<MlDataContract | null> {
  for (const rel of AGENT_DATA_CONTRACT_PATHS) {
    let raw: string;
    try {
      raw = await readFile(path.join(workspacePath, rel), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const data = parseManifestData(parsed);
    if (data !== null) {
      return data;
    }
  }
  return null;
}

async function resolveBaseManifest(workspacePath: string): Promise<ExperimentManifest | null> {
  const owned = await readManifestFile(path.join(workspacePath, ownedManifestRelative));
  if (owned !== null) {
    return owned;
  }
  const root = await readManifestFile(path.join(workspacePath, "experiment.json"));
  if (root !== null) {
    return root;
  }
  const reconstructed = await reconstructManifest(workspacePath);
  if (reconstructed !== null) {
    await writeExperimentManifest(workspacePath, reconstructed).catch(() => undefined);
    return reconstructed;
  }
  return null;
}

export async function readExperimentManifest(workspacePath: string): Promise<ExperimentManifest | null> {
  const manifest = await resolveBaseManifest(workspacePath);
  if (manifest === null) {
    return null;
  }
  const agentData = await readAgentDataContract(workspacePath);
  if (agentData !== null) {
    manifest.data = agentData;
  }
  if (manifest.calibration === null || manifest.calibration === undefined) {
    const rootCalibration = await readRootCalibration(workspacePath);
    if (rootCalibration !== null) {
      manifest.calibration = rootCalibration;
    }
  }
  return manifest;
}
