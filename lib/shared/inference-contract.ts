import type { MlDevice } from "@/lib/shared/types";


export type InferenceModality =
  | "text"
  | "number"
  | "image"
  | "audio"
  | "video"
  | "file"
  | "tabular"
  | "json";

export type InferenceTask =
  | "regression"
  | "classification"
  | "generation"
  | "embedding"
  | "detection"
  | "segmentation"
  | "custom";

export type InferenceOutputKind =
  | "scalar"
  | "label"
  | "labels"
  | "text"
  | "image"
  | "file"
  | "table"
  | "json"
  | "plot";

export interface InferenceInputSpec {
  name: string;
  modality: InferenceModality;
  label: string;
  help: string | null;
  required: boolean;
  /** Comma-separated accept hint for file/image/audio/video widgets (e.g. "image/*", ".fasta,.txt"). */
  accept: string | null;
  /** Prefill value for text/number/json/tabular widgets. */
  example: string | null;
  /** File widgets may accept multiple files. */
  multiple: boolean;
}

export interface InferenceOutputSpec {
  kind: InferenceOutputKind;
  name: string;
  unit: string | null;
  goal: "max" | "min" | null;
  /** Closed label set for classification outputs (optional). */
  labels: string[] | null;
}

export interface InferenceExample {
  label: string;
  inputs: Record<string, unknown>;
}

export interface InferenceContract {
  task: InferenceTask;
  title: string;
  inputs: InferenceInputSpec[];
  output: InferenceOutputSpec;
  examples: InferenceExample[];
  /** The model accepts a list of inputs in one call. */
  batch: boolean;
}

export type InferenceWorkerStatus = "cold" | "starting" | "ready" | "error" | "stopped";

export interface InferenceWorkerInfo {
  status: InferenceWorkerStatus;
  device: MlDevice | null;
  deviceName: string | null;
  message: string | null;
  startedAt: string | null;
  /** Authoritative contract from the live `ready` handshake; null until the worker is ready. */
  contract: InferenceContract | null;
}

export interface InferenceOutputFileRef {
  outputId: string;
  name: string;
  mime: string;
  /** Server-filled URL to stream the file from the sandbox. */
  url: string;
}

const MODALITIES: ReadonlySet<string> = new Set<InferenceModality>([
  "text", "number", "image", "audio", "video", "file", "tabular", "json",
]);
const TASKS: ReadonlySet<string> = new Set<InferenceTask>([
  "regression", "classification", "generation", "embedding", "detection", "segmentation", "custom",
]);
const OUTPUT_KINDS: ReadonlySet<string> = new Set<InferenceOutputKind>([
  "scalar", "label", "labels", "text", "image", "file", "table", "json", "plot",
]);

const TASK_ALIASES: ReadonlyMap<string, InferenceTask> = new Map<string, InferenceTask>([
  ["text-generation", "generation"],
  ["text2text-generation", "generation"],
  ["text2text", "generation"],
  ["text-gen", "generation"],
  ["causal-lm", "generation"],
  ["causal-language-modeling", "generation"],
  ["language-modeling", "generation"],
  ["seq2seq", "generation"],
  ["completion", "generation"],
  ["chat", "generation"],
  ["summarization", "generation"],
  ["translation", "generation"],
  ["image-classification", "classification"],
  ["text-classification", "classification"],
  ["sentiment-analysis", "classification"],
  ["multiclass", "classification"],
  ["multi-class", "classification"],
  ["binary-classification", "classification"],
  ["classify", "classification"],
  ["regress", "regression"],
  ["object-detection", "detection"],
  ["semantic-segmentation", "segmentation"],
  ["feature-extraction", "embedding"],
  ["embeddings", "embedding"],
]);

function resolveTask(raw: unknown): InferenceTask {
  if (typeof raw !== "string") {
    return "custom";
  }
  const key = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (TASKS.has(key)) {
    return key as InferenceTask;
  }
  return TASK_ALIASES.get(key) ?? "custom";
}

const MAX_INPUTS = 16;
const MAX_EXAMPLES = 12;
const MAX_LABELS = 1000;
const MAX_STRING = 4000;

export function fileModalities(): ReadonlySet<InferenceModality> {
  return new Set<InferenceModality>(["image", "audio", "video", "file"]);
}

export function isFileModality(modality: InferenceModality): boolean {
  return modality === "image" || modality === "audio" || modality === "video" || modality === "file";
}

function asTrimmedString(value: unknown, fallback: string, max = MAX_STRING): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  return trimmed.slice(0, max);
}

function asOptionalString(value: unknown, max = MAX_STRING): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function isSafeInputName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
}

function normalizeInput(raw: unknown): InferenceInputSpec | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (!isSafeInputName(candidate.name)) {
    return null;
  }
  const modality = (typeof candidate.modality === "string" && MODALITIES.has(candidate.modality)
    ? candidate.modality
    : "text") as InferenceModality;
  return {
    name: candidate.name,
    modality,
    label: asTrimmedString(candidate.label, candidate.name, 200),
    help: asOptionalString(candidate.help, 600),
    required: candidate.required !== false,
    accept: asOptionalString(candidate.accept, 200),
    example: isFileModality(modality) ? null : asOptionalString(candidate.example),
    multiple: candidate.multiple === true,
  } satisfies InferenceInputSpec;
}

function normalizeOutput(raw: unknown): InferenceOutputSpec {
  const candidate = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const kind = (typeof candidate.kind === "string" && OUTPUT_KINDS.has(candidate.kind)
    ? candidate.kind
    : "json") as InferenceOutputKind;
  const goalRaw = candidate.goal;
  const goal = goalRaw === "max" || goalRaw === "min" ? goalRaw : null;
  let labels: string[] | null = null;
  if (Array.isArray(candidate.labels)) {
    labels = candidate.labels
      .filter((entry): entry is string => typeof entry === "string")
      .slice(0, MAX_LABELS)
      .map((entry) => entry.slice(0, 200));
    if (labels.length === 0) {
      labels = null;
    }
  }
  return {
    kind,
    name: asTrimmedString(candidate.name, "output", 200),
    unit: asOptionalString(candidate.unit, 60),
    goal,
    labels,
  } satisfies InferenceOutputSpec;
}

function normalizeExample(raw: unknown, index: number): InferenceExample | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const inputs = typeof candidate.inputs === "object" && candidate.inputs !== null
    ? (candidate.inputs as Record<string, unknown>)
    : null;
  if (inputs === null) {
    return null;
  }
  return {
    label: asTrimmedString(candidate.label, `Example ${index + 1}`, 200),
    inputs,
  } satisfies InferenceExample;
}

/**
 * Validate + normalize an agent/scaffold-authored contract (the trust boundary). Returns null when the input is
 * not a usable contract (e.g. no valid inputs). Bounds array/string sizes so a hostile contract cannot bloat the UI.
 */
export function normalizeInferenceContract(raw: unknown): InferenceContract | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  const inputsRaw = Array.isArray(candidate.inputs) ? candidate.inputs.slice(0, MAX_INPUTS) : [];
  const inputs = inputsRaw
    .map((entry) => normalizeInput(entry))
    .filter((entry): entry is InferenceInputSpec => entry !== null);
  if (inputs.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.name)) {
      return null;
    }
    seen.add(input.name);
  }
  const task = resolveTask(candidate.task);
  const examplesRaw = Array.isArray(candidate.examples) ? candidate.examples.slice(0, MAX_EXAMPLES) : [];
  const examples = examplesRaw
    .map((entry, index) => normalizeExample(entry, index))
    .filter((entry): entry is InferenceExample => entry !== null);
  return {
    task,
    title: asTrimmedString(candidate.title, "Model inference", 200),
    inputs,
    output: normalizeOutput(candidate.output),
    examples,
    batch: candidate.batch === true,
  } satisfies InferenceContract;
}
