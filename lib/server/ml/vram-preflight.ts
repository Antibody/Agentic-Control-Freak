import type { MlPrecision } from "@/lib/shared/types";

export type VramOptimizer = "adam" | "adamw" | "sgd" | "none";

export interface VramEstimateInput {
  paramsMillions: number;
  precision: MlPrecision;
  batchSize: number;
  seqLen: number;
  gradAccum: number;
  optimizer: VramOptimizer;
  training: boolean;
  trainableFraction: number;
  hiddenSize: number;
  layers: number;
  gradientCheckpointing: boolean;
}

export interface VramAdjustments {
  batchSize: number;
  gradAccum: number;
  seqLen: number;
  gradientCheckpointing: boolean;
}

export interface VramPlan {
  estimatedMb: number;
  budgetMb: number | null;
  fits: boolean;
  decision: "ok" | "downshift" | "refuse";
  original: VramAdjustments;
  adjusted: VramAdjustments;
  rationale: string[];
}

const overheadMb = 700;
const seqFloor = 128;

function bytesPerParam(precision: MlPrecision): number {
  switch (precision) {
    case "fp32":
      return 4;
    case "fp16":
    case "bf16":
      return 2;
    case "int8":
      return 1;
    case "int4":
      return 0.5;
    default:
      return 4;
  }
}

function optimizerBytesPerParam(optimizer: VramOptimizer): number {
  if (optimizer === "adam" || optimizer === "adamw") {
    return 8;
  }
  if (optimizer === "sgd") {
    return 4;
  }
  return 0;
}

export function estimateVramMb(input: VramEstimateInput): number {
  const params = Math.max(0, input.paramsMillions) * 1_000_000;
  const trainable = params * Math.min(1, Math.max(0, input.trainableFraction));
  const computeBytes = Math.max(2, bytesPerParam(input.precision));

  const weightsMb = (params * bytesPerParam(input.precision)) / (1024 * 1024);

  let trainingMb = 0;
  if (input.training) {
    const gradMb = (trainable * computeBytes) / (1024 * 1024);
    const optMb = (trainable * optimizerBytesPerParam(input.optimizer)) / (1024 * 1024);
    const mixedPrecision = input.precision !== "fp32";
    const masterMb = mixedPrecision ? (trainable * 4) / (1024 * 1024) : 0;
    trainingMb = gradMb + optMb + masterMb;
  }

  const activationPerSampleMb = (input.seqLen * input.hiddenSize * input.layers * computeBytes * 2) / (1024 * 1024);
  const checkpointFactor = input.gradientCheckpointing ? 0.3 : 1;
  const activationMb = activationPerSampleMb * Math.max(1, input.batchSize) * checkpointFactor * (input.training ? 1 : 0.5);

  return Math.round(weightsMb + trainingMb + activationMb + overheadMb);
}

function withAdjustments(input: VramEstimateInput, adjusted: VramAdjustments): VramEstimateInput {
  return {
    ...input,
    batchSize: adjusted.batchSize,
    gradAccum: adjusted.gradAccum,
    seqLen: adjusted.seqLen,
    gradientCheckpointing: adjusted.gradientCheckpointing,
  };
}

export function planVramFit(input: VramEstimateInput, budgetMb: number | null): VramPlan {
  const original: VramAdjustments = {
    batchSize: input.batchSize,
    gradAccum: input.gradAccum,
    seqLen: input.seqLen,
    gradientCheckpointing: input.gradientCheckpointing,
  };
  const baseEstimate = estimateVramMb(input);

  if (budgetMb === null || budgetMb <= 0) {
    return {
      estimatedMb: baseEstimate,
      budgetMb,
      fits: true,
      decision: "ok",
      original,
      adjusted: original,
      rationale: ["No VRAM budget provided; estimate is advisory only."],
    };
  }

  if (baseEstimate <= budgetMb) {
    return {
      estimatedMb: baseEstimate,
      budgetMb,
      fits: true,
      decision: "ok",
      original,
      adjusted: original,
      rationale: [`Estimated ${baseEstimate}MB fits within the ${budgetMb}MB budget.`],
    };
  }

  const rationale: string[] = [`Estimated ${baseEstimate}MB exceeds the ${budgetMb}MB budget; attempting downshift.`];
  const adjusted: VramAdjustments = { ...original };

  if (input.training && !adjusted.gradientCheckpointing) {
    adjusted.gradientCheckpointing = true;
    rationale.push("Enabled gradient checkpointing.");
    if (estimateVramMb(withAdjustments(input, adjusted)) <= budgetMb) {
      return finalizePlan(input, budgetMb, original, adjusted, rationale, "downshift");
    }
  }

  for (let guard = 0; guard < 16 && adjusted.batchSize > 1; guard += 1) {
    adjusted.batchSize = Math.max(1, Math.floor(adjusted.batchSize / 2));
    adjusted.gradAccum = adjusted.gradAccum * 2;
    rationale.push(`Reduced micro-batch to ${adjusted.batchSize} and raised grad accumulation to ${adjusted.gradAccum} (effective batch preserved).`);
    if (estimateVramMb(withAdjustments(input, adjusted)) <= budgetMb) {
      return finalizePlan(input, budgetMb, original, adjusted, rationale, "downshift");
    }
  }

  for (let guard = 0; guard < 16 && adjusted.seqLen > seqFloor; guard += 1) {
    adjusted.seqLen = Math.max(seqFloor, Math.floor(adjusted.seqLen / 2));
    rationale.push(`Shortened sequence length to ${adjusted.seqLen}.`);
    if (estimateVramMb(withAdjustments(input, adjusted)) <= budgetMb) {
      return finalizePlan(input, budgetMb, original, adjusted, rationale, "downshift");
    }
  }

  const finalEstimate = estimateVramMb(withAdjustments(input, adjusted));
  rationale.push(`Still ${finalEstimate}MB after maximum downshift; refusing to launch to avoid an out-of-memory failure. Use a smaller model, stronger quantization, or more VRAM.`);
  return {
    estimatedMb: finalEstimate,
    budgetMb,
    fits: false,
    decision: "refuse",
    original,
    adjusted,
    rationale,
  };
}

function finalizePlan(
  input: VramEstimateInput,
  budgetMb: number,
  original: VramAdjustments,
  adjusted: VramAdjustments,
  rationale: string[],
  decision: "ok" | "downshift" | "refuse",
): VramPlan {
  const estimate = estimateVramMb(withAdjustments(input, adjusted));
  rationale.push(`Downshifted estimate ${estimate}MB fits within the ${budgetMb}MB budget.`);
  return {
    estimatedMb: estimate,
    budgetMb,
    fits: true,
    decision,
    original,
    adjusted,
    rationale,
  };
}

const sizeSuffixPattern = /(\d+(?:\.\d+)?)\s*([bm])\b/i;

export function parseParamsMillions(text: string): number | null {
  const match = text.match(sizeSuffixPattern);
  if (match === null) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return null;
  }
  return match[2].toLowerCase() === "b" ? value * 1000 : value;
}
