import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type {
  MlDatasetConfig,
  MlDatasetFormat,
  MlDatasetMode,
  MlDevice,
  MlPrecision,
  MlRunConfig,
  MlRunRegime,
} from "@/lib/shared/types";

const devices: MlDevice[] = ["auto", "cpu", "cuda", "mps"];
const precisions: MlPrecision[] = ["fp32", "fp16", "bf16", "int8", "int4"];
const regimes: MlRunRegime[] = ["smoke", "short", "full"];
const datasetModes: MlDatasetMode[] = ["builtin", "single_corpus", "train_test", "train_val_test", "jsonl_finetune", "custom"];
const datasetFormats: MlDatasetFormat[] = ["auto", "text", "jsonl", "csv", "image_folder", "other"];

export const RUN_CONFIG_ALIASES: Record<string, string[]> = {
  maxSteps: ["max_steps"],
  gradAccum: ["gradient_accumulation_steps", "grad_accum"],
  lr: ["learning_rate"],
  epochs: ["num_epochs", "num_train_epochs"],
  subsetLimit: ["subset_limit"],
  batchSize: ["per_device_train_batch_size", "batch_size"],
  blockSize: ["block_size", "context_length"],
  embedDim: ["embed_dim", "embedding_dim"],
  hiddenDim: ["hidden_dim"],
  numLayers: ["num_layers", "layers"],
};

export const experimentDir = path.join(".orchestrator", "experiment");

export function emptyMlDatasetConfig(): MlDatasetConfig {
  return { mode: "builtin", format: "auto", trainPath: null, valPath: null, testPath: null, corpusPath: null };
}

export function emptyMlRunConfig(): MlRunConfig {
  return {
    seed: 42,
    device: "auto",
    regime: "smoke",
    maxSteps: null,
    epochs: null,
    batchSize: null,
    gradAccum: null,
    precision: "fp32",
    subsetLimit: null,
    lr: null,
    blockSize: null,
    embedDim: null,
    hiddenDim: null,
    numLayers: null,
    decode: { temperature: null, topP: null, maxNewTokens: null, greedy: true },
    dataset: emptyMlDatasetConfig(),
    extra: {},
  };
}

function asPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return cleaned.length > 0 ? cleaned : null;
}

function asPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
  }
  return null;
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function normalizeMlRunConfig(input: unknown): MlRunConfig {
  const config = emptyMlRunConfig();
  if (typeof input !== "object" || input === null) {
    return config;
  }
  const candidate = input as Record<string, unknown>;
  for (const [canonical, aliases] of Object.entries(RUN_CONFIG_ALIASES)) {
    if (candidate[canonical] === undefined) {
      for (const alias of aliases) {
        if (candidate[alias] !== undefined) {
          candidate[canonical] = candidate[alias];
          break;
        }
      }
    }
  }

  const seed = asPositiveInt(candidate.seed);
  if (seed !== null) {
    config.seed = seed;
  } else if (candidate.seed === 0) {
    config.seed = 0;
  }
  if (typeof candidate.device === "string" && (devices as string[]).includes(candidate.device)) {
    config.device = candidate.device as MlDevice;
  }
  if (typeof candidate.regime === "string" && (regimes as string[]).includes(candidate.regime)) {
    config.regime = candidate.regime as MlRunRegime;
  }
  if (typeof candidate.precision === "string" && (precisions as string[]).includes(candidate.precision)) {
    config.precision = candidate.precision as MlPrecision;
  }
  config.maxSteps = asPositiveInt(candidate.maxSteps);
  config.epochs = asPositiveInt(candidate.epochs);
  config.batchSize = asPositiveInt(candidate.batchSize);
  config.gradAccum = asPositiveInt(candidate.gradAccum);
  config.subsetLimit = asPositiveInt(candidate.subsetLimit);
  config.lr = asPositiveNumber(candidate.lr);
  config.blockSize = asPositiveInt(candidate.blockSize);
  config.embedDim = asPositiveInt(candidate.embedDim);
  config.hiddenDim = asPositiveInt(candidate.hiddenDim);
  config.numLayers = asPositiveInt(candidate.numLayers);

  const decodeSource: Record<string, unknown> =
    typeof candidate.decode === "object" && candidate.decode !== null
      ? { ...(candidate.decode as Record<string, unknown>) }
      : {};
  if (decodeSource.temperature === undefined) {
    decodeSource.temperature = candidate.temperature;
  }
  if (decodeSource.topP === undefined) {
    decodeSource.topP = candidate.topP ?? candidate.top_p;
  }
  if (decodeSource.maxNewTokens === undefined) {
    decodeSource.maxNewTokens = candidate.maxNewTokens ?? candidate.max_new_tokens;
  }
  if (decodeSource.greedy === undefined) {
    decodeSource.greedy = candidate.greedy;
  }
  config.decode.temperature = asPositiveNumber(decodeSource.temperature);
  config.decode.topP = asPositiveNumber(decodeSource.topP);
  config.decode.maxNewTokens = asPositiveInt(decodeSource.maxNewTokens);
  config.decode.greedy = decodeSource.greedy !== false;

  const datasetSource: Record<string, unknown> =
    typeof candidate.dataset === "object" && candidate.dataset !== null
      ? { ...(candidate.dataset as Record<string, unknown>) }
      : {};
  if (datasetSource.mode === undefined) {
    datasetSource.mode = candidate.dataset_mode ?? candidate.datasetMode;
  }
  if (datasetSource.format === undefined) {
    datasetSource.format = candidate.dataset_format ?? candidate.datasetFormat;
  }
  if (datasetSource.trainPath === undefined) {
    datasetSource.trainPath = candidate.trainPath ?? candidate.train_path ?? candidate.train_dir;
  }
  if (datasetSource.valPath === undefined) {
    datasetSource.valPath = candidate.valPath ?? candidate.val_path ?? candidate.val_dir;
  }
  if (datasetSource.testPath === undefined) {
    datasetSource.testPath = candidate.testPath ?? candidate.test_path ?? candidate.test_dir;
  }
  if (datasetSource.corpusPath === undefined) {
    datasetSource.corpusPath = candidate.corpusPath ?? candidate.corpus_path ?? candidate.data_path ?? candidate.text_path;
  }
  if (typeof datasetSource.mode === "string" && (datasetModes as string[]).includes(datasetSource.mode)) {
    config.dataset.mode = datasetSource.mode as MlDatasetMode;
  }
  if (typeof datasetSource.format === "string" && (datasetFormats as string[]).includes(datasetSource.format)) {
    config.dataset.format = datasetSource.format as MlDatasetFormat;
  }
  config.dataset.trainPath = asPath(datasetSource.trainPath);
  config.dataset.valPath = asPath(datasetSource.valPath);
  config.dataset.testPath = asPath(datasetSource.testPath);
  config.dataset.corpusPath = asPath(datasetSource.corpusPath);

  if (typeof candidate.extra === "object" && candidate.extra !== null) {
    for (const [key, value] of Object.entries(candidate.extra as Record<string, unknown>)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string") {
        config.extra[key] = value;
      }
    }
  }

  return config;
}

const RUN_CONFIG_KNOWN_TOP_LEVEL_KEYS = new Set<string>([
  "seed", "device", "regime", "precision",
  "maxSteps", "epochs", "batchSize", "gradAccum", "subsetLimit", "lr",
  "blockSize", "embedDim", "hiddenDim", "numLayers",
  "decode", "dataset", "extra",
  "temperature", "topP", "top_p", "maxNewTokens", "max_new_tokens", "greedy",
  "dataset_mode", "datasetMode", "dataset_format", "datasetFormat",
  "trainPath", "train_path", "train_dir", "valPath", "val_path", "val_dir",
  "testPath", "test_path", "test_dir", "corpusPath", "corpus_path", "data_path", "text_path",
  ...Object.values(RUN_CONFIG_ALIASES).flat(),
]);

export function inspectMlRunConfigInput(input: unknown): { unknownKeys: string[]; coerced: string[] } {
  if (typeof input !== "object" || input === null) {
    return { unknownKeys: [], coerced: [] };
  }
  const candidate = input as Record<string, unknown>;
  const unknownKeys = Object.keys(candidate).filter((key) => !RUN_CONFIG_KNOWN_TOP_LEVEL_KEYS.has(key));
  const normalized = normalizeMlRunConfig({ ...candidate });

  const providedCanonical = (canonical: string): boolean => {
    if (candidate[canonical] !== undefined) {
      return true;
    }
    const aliases = RUN_CONFIG_ALIASES[canonical];
    return aliases !== undefined && aliases.some((alias) => candidate[alias] !== undefined);
  };

  const coerced: string[] = [];
  const numericFields: Array<[string, number | null]> = [
    ["maxSteps", normalized.maxSteps],
    ["epochs", normalized.epochs],
    ["batchSize", normalized.batchSize],
    ["gradAccum", normalized.gradAccum],
    ["subsetLimit", normalized.subsetLimit],
    ["lr", normalized.lr],
    ["blockSize", normalized.blockSize],
    ["embedDim", normalized.embedDim],
    ["hiddenDim", normalized.hiddenDim],
    ["numLayers", normalized.numLayers],
  ];
  for (const [field, value] of numericFields) {
    if (value === null && providedCanonical(field)) {
      coerced.push(field);
    }
  }
  for (const enumField of ["device", "regime", "precision"] as const) {
    const raw = candidate[enumField];
    if (raw !== undefined && raw !== normalized[enumField]) {
      coerced.push(enumField);
    }
  }
  const ds = (typeof candidate.dataset === "object" && candidate.dataset !== null)
    ? (candidate.dataset as Record<string, unknown>)
    : {};
  const rawMode = ds.mode ?? candidate.dataset_mode ?? candidate.datasetMode;
  if (rawMode !== undefined && rawMode !== normalized.dataset.mode) {
    coerced.push("dataset.mode");
  }
  const rawFormat = ds.format ?? candidate.dataset_format ?? candidate.datasetFormat;
  if (rawFormat !== undefined && rawFormat !== normalized.dataset.format) {
    coerced.push("dataset.format");
  }
  return { unknownKeys, coerced };
}

export function projectRunConfigForDisk(config: MlRunConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  const typed = config as unknown as Record<string, unknown>;
  for (const [canonical, aliases] of Object.entries(RUN_CONFIG_ALIASES)) {
    const value = typed[canonical] ?? null;
    for (const alias of aliases) {
      out[alias] = value;
    }
  }
  if (config.decode !== undefined && config.decode !== null) {
    out.maxNewTokens = config.decode.maxNewTokens;
    out.max_new_tokens = config.decode.maxNewTokens;
    out.temperature = config.decode.temperature;
    out.top_p = config.decode.topP;
    out.greedy = config.decode.greedy;
  }
  if (config.dataset !== undefined && config.dataset !== null) {
    const d = config.dataset;
    out.dataset_mode = d.mode;
    out.dataset_format = d.format;
    out.train_path = d.trainPath;
    out.train_dir = d.trainPath;
    out.val_path = d.valPath;
    out.val_dir = d.valPath;
    out.test_path = d.testPath;
    out.test_dir = d.testPath;
    out.corpus_path = d.corpusPath;
    out.data_path = d.corpusPath;
    out.text_path = d.corpusPath;
  }
  const reserved = new Set(Object.keys(out));
  for (const [key, value] of Object.entries(config.extra ?? {})) {
    if (!reserved.has(key)) {
      out[key] = value;
    }
  }
  return out;
}

export async function writeRunConfig(workspacePath: string, config: MlRunConfig): Promise<string> {
  const dir = path.join(workspacePath, experimentDir);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "run_config.json");
  await writeFile(target, `${JSON.stringify(projectRunConfigForDisk(config), null, 2)}\n`, "utf8");
  return target;
}
