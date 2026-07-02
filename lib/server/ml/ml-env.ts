import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getConfig } from "@/lib/server/config";
import type { VenvCapability } from "@/lib/server/runtime/ml-doctor";

export function mlCacheEnv(): Record<string, string> {
  const config = getConfig();
  const env: Record<string, string> = {
    HF_HOME: path.join(config.mlCacheDir, "huggingface"),
    HUGGINGFACE_HUB_CACHE: path.join(config.mlCacheDir, "huggingface", "hub"),
    TORCH_HOME: path.join(config.mlCacheDir, "torch"),
    PIP_CACHE_DIR: path.join(config.mlCacheDir, "pip"),
    MPLBACKEND: "Agg",
    PYTHONUNBUFFERED: "1",
    TOKENIZERS_PARALLELISM: "false",
  };
  if (!config.mlAllowNetworkDownloads) {
    env.HF_HUB_OFFLINE = "1";
    env.TRANSFORMERS_OFFLINE = "1";
  }
  if (!config.mlAllowGpu) {
    env.CUDA_VISIBLE_DEVICES = "";
  }
  return env;
}

export function cudaIndexTag(cudaVersion: string | null): string | null {
  if (cudaVersion === null) {
    return null;
  }
  const digits = cudaVersion.replace(/[^0-9]/g, "");
  if (digits.length < 2) {
    return null;
  }
  return `cu${digits.slice(0, 3)}`;
}

const publishedCudaTags = ["cu118", "cu121", "cu124", "cu126", "cu128"];

function cudaTagNumber(tag: string): number {
  const digits = tag.replace(/[^0-9]/g, "");
  return digits.length > 0 ? Number(digits) : 0;
}

export function resolveCudaIndexTag(cudaVersion: string | null, defaultTag: string): string | null {
  const derived = cudaIndexTag(cudaVersion);
  if (derived !== null) {
    if (publishedCudaTags.includes(derived)) {
      return derived;
    }
    const target = cudaTagNumber(derived);
    const lowerOrEqual = publishedCudaTags.filter((tag) => cudaTagNumber(tag) <= target);
    if (lowerOrEqual.length > 0) {
      return lowerOrEqual.reduce((best, tag) => (cudaTagNumber(tag) > cudaTagNumber(best) ? tag : best));
    }
    return publishedCudaTags.reduce((best, tag) => (cudaTagNumber(tag) < cudaTagNumber(best) ? tag : best));
  }
  return publishedCudaTags.includes(defaultTag) ? defaultTag : null;
}

export function venvCapabilityPath(workspacePath: string): string {
  return path.join(workspacePath, ".orchestrator", "experiment", "venv-capability.json");
}

export async function writeVenvCapabilityArtifact(workspacePath: string, capability: VenvCapability): Promise<void> {
  const target = venvCapabilityPath(workspacePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(capability, null, 2)}\n`, "utf8");
}

export async function readVenvCapabilityArtifact(workspacePath: string): Promise<VenvCapability | null> {
  try {
    return JSON.parse(await readFile(venvCapabilityPath(workspacePath), "utf8")) as VenvCapability;
  } catch {
    return null;
  }
}
