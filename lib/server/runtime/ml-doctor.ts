import os from "node:os";
import { statfs } from "node:fs/promises";
import { getConfig } from "@/lib/server/config";
import { createSanitizedProcessEnv } from "@/lib/server/runtime/env";
import { resolvePythonCommand } from "@/lib/server/runtime/python-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";

export interface MlDoctorResult {
  enabled: boolean;
  available: boolean;
  python: { command: string | null; version: string | null };
  cpuCount: number | null;
  ramTotalMb: number | null;
  diskFreeMb: number | null;
  accelerator: "cpu" | "cuda" | "mps";
  cuda: {
    available: boolean;
    version: string | null;
    deviceCount: number | null;
    deviceName: string | null;
    vramTotalMb: number | null;
    vramFreeMb: number | null;
    cudnnVersion: number | null;
    driverVersion: number | null;
  };
  mpsAvailable: boolean;
  torch: { installed: boolean; version: string | null; cudaBuild: string | null };
  libraries: Record<string, string | null>;
  warnings: string[];
  error: string | null;
  checkedAt: string;
}

export interface VenvCapability {
  torchInstalled: boolean;
  torchVersion: string | null;
  cudaBuild: string | null;
  cudaAvailable: boolean;
  deviceName: string | null;
  bf16Supported: boolean;
  bitsandbytesAvailable: boolean;
  bitsandbytesVersion: string | null;
  mpsAvailable: boolean;
  probedAt: string;
}

let cached: { expiresAt: number; result: MlDoctorResult } | null = null;
const ttlMs = 60_000;
const venvProbeCache = new Map<string, { expiresAt: number; result: VenvCapability }>();

const venvProbeScript = `import json, importlib.util
def ver(name):
    try:
        import importlib.metadata as m
        return m.version(name)
    except Exception:
        return None
out = {"torch_installed": False, "torch_version": None, "cuda_build": None, "cuda_available": False, "device_name": None, "bf16_supported": False, "bitsandbytes_available": False, "bitsandbytes_version": None, "mps_available": False}
if importlib.util.find_spec("torch") is not None:
    try:
        import torch
        out["torch_installed"] = True
        out["torch_version"] = getattr(torch, "__version__", None)
        out["cuda_build"] = getattr(torch.version, "cuda", None)
        if torch.cuda.is_available():
            out["cuda_available"] = True
            try:
                out["device_name"] = torch.cuda.get_device_name(0)
            except Exception:
                out["device_name"] = None
            try:
                out["bf16_supported"] = bool(torch.cuda.is_bf16_supported())
            except Exception:
                out["bf16_supported"] = False
        backends = getattr(torch.backends, "mps", None)
        if backends is not None and backends.is_available():
            out["mps_available"] = True
    except Exception as exc:
        out["torch_error"] = str(exc)
out["bitsandbytes_available"] = importlib.util.find_spec("bitsandbytes") is not None
if out["bitsandbytes_available"]:
    out["bitsandbytes_version"] = ver("bitsandbytes")
print(json.dumps(out))
`;

function unknownVenvCapability(): VenvCapability {
  return {
    torchInstalled: false,
    torchVersion: null,
    cudaBuild: null,
    cudaAvailable: false,
    deviceName: null,
    bf16Supported: false,
    bitsandbytesAvailable: false,
    bitsandbytesVersion: null,
    mpsAvailable: false,
    probedAt: new Date().toISOString(),
  };
}

export async function probeVenvCapability(
  workspacePath: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<VenvCapability> {
  const config = getConfig();
  if (!config.mlPipelineEnabled) {
    return unknownVenvCapability();
  }
  const now = Date.now();
  const existing = venvProbeCache.get(workspacePath);
  if (!options.force && existing !== undefined && existing.expiresAt > now) {
    return existing.result;
  }
  try {
    const resolved = await resolvePythonCommand(workspacePath);
    const probe = await runProcess({
      command: resolved.command,
      args: ["-c", venvProbeScript],
      cwd: workspacePath,
      timeoutMs: 60_000,
      env: createSanitizedProcessEnv({ CI: "true", PYTHONWARNINGS: "ignore" }),
      signal: options.signal,
    });
    if (probe.exitCode !== 0 || probe.timedOut) {
      const fallback = unknownVenvCapability();
      venvProbeCache.set(workspacePath, { expiresAt: now + ttlMs, result: fallback });
      return fallback;
    }
    const parsed = JSON.parse(probe.stdout.trim()) as {
      torch_installed?: boolean;
      torch_version?: string | null;
      cuda_build?: string | null;
      cuda_available?: boolean;
      device_name?: string | null;
      bf16_supported?: boolean;
      bitsandbytes_available?: boolean;
      bitsandbytes_version?: string | null;
      mps_available?: boolean;
    };
    const result: VenvCapability = {
      torchInstalled: parsed.torch_installed === true,
      torchVersion: parsed.torch_version ?? null,
      cudaBuild: parsed.cuda_build ?? null,
      cudaAvailable: parsed.cuda_available === true,
      deviceName: parsed.device_name ?? null,
      bf16Supported: parsed.bf16_supported === true,
      bitsandbytesAvailable: parsed.bitsandbytes_available === true,
      bitsandbytesVersion: parsed.bitsandbytes_version ?? null,
      mpsAvailable: parsed.mps_available === true,
      probedAt: new Date().toISOString(),
    };
    venvProbeCache.set(workspacePath, { expiresAt: now + ttlMs, result });
    return result;
  } catch {
    return unknownVenvCapability();
  }
}

const probeScript = `import json, importlib.util, platform
def ver(name):
    try:
        import importlib.metadata as m
        return m.version(name)
    except Exception:
        return None
libs = ["numpy", "pandas", "scikit-learn", "scipy", "matplotlib", "torch", "xgboost", "lightgbm", "transformers"]
out = {
    "python_version": platform.python_version(),
    "libraries": {name: ver(name) for name in libs},
    "cuda": {"available": False, "version": None, "device_count": None, "device_name": None, "vram_total_mb": None, "vram_free_mb": None, "cudnn": None, "driver": None},
    "mps": False,
    "torch_cuda_build": None,
}
if importlib.util.find_spec("torch") is not None:
    try:
        import torch
        out["torch_cuda_build"] = getattr(torch.version, "cuda", None)
        if torch.cuda.is_available():
            out["cuda"]["available"] = True
            out["cuda"]["version"] = getattr(torch.version, "cuda", None)
            out["cuda"]["device_count"] = torch.cuda.device_count()
            out["cuda"]["device_name"] = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            out["cuda"]["vram_total_mb"] = int(props.total_memory / (1024 * 1024))
            try:
                free_bytes, _total = torch.cuda.mem_get_info(0)
                out["cuda"]["vram_free_mb"] = int(free_bytes / (1024 * 1024))
            except Exception:
                out["cuda"]["vram_free_mb"] = None
            try:
                out["cuda"]["cudnn"] = torch.backends.cudnn.version()
            except Exception:
                out["cuda"]["cudnn"] = None
            try:
                out["cuda"]["driver"] = torch._C._cuda_getDriverVersion()
            except Exception:
                out["cuda"]["driver"] = None
        backends = getattr(torch.backends, "mps", None)
        if backends is not None and backends.is_available():
            out["mps"] = True
    except Exception as exc:
        out["torch_error"] = str(exc)
print(json.dumps(out))
`;

function disabledResult(): MlDoctorResult {
  return {
    enabled: false,
    available: false,
    python: { command: null, version: null },
    cpuCount: null,
    ramTotalMb: null,
    diskFreeMb: null,
    accelerator: "cpu",
    cuda: { available: false, version: null, deviceCount: null, deviceName: null, vramTotalMb: null, vramFreeMb: null, cudnnVersion: null, driverVersion: null },
    mpsAvailable: false,
    torch: { installed: false, version: null, cudaBuild: null },
    libraries: {},
    warnings: [],
    error: "ML pipeline is disabled (set ML_PIPELINE_ENABLED=true).",
    checkedAt: new Date().toISOString(),
  };
}

export async function freeDiskMb(targetPath: string): Promise<number | null> {
  try {
    const stats = await statfs(targetPath);
    const available = Number(stats.bsize) * Number(stats.bavail);
    return Number.isFinite(available) ? Math.floor(available / (1024 * 1024)) : null;
  } catch {
    return null;
  }
}

export async function runMlDoctor(options: { force?: boolean } = {}): Promise<MlDoctorResult> {
  const now = Date.now();
  if (!options.force && cached !== null && cached.expiresAt > now) {
    return cached.result;
  }

  const config = getConfig();
  if (!config.mlPipelineEnabled) {
    const result = disabledResult();
    cached = { expiresAt: now + ttlMs, result };
    return result;
  }

  const cpuCount = os.cpus().length || null;
  const ramTotalMb = Math.floor(os.totalmem() / (1024 * 1024)) || null;
  const diskFreeMb = await freeDiskMb(config.workspaceRoot).catch(() => null);
  const warnings: string[] = [];

  let python: { command: string | null; version: string | null } = { command: null, version: null };
  try {
    const resolved = await resolvePythonCommand();
    python = { command: resolved.command, version: null };
    const probe = await runProcess({
      command: resolved.command,
      args: ["-c", probeScript],
      cwd: process.cwd(),
      timeoutMs: 30_000,
      env: createSanitizedProcessEnv({ CI: "true", PYTHONWARNINGS: "ignore" }),
    });

    if (probe.exitCode !== 0 || probe.timedOut) {
      const result: MlDoctorResult = {
        ...disabledResult(),
        enabled: true,
        python,
        cpuCount,
        ramTotalMb,
        diskFreeMb,
        error: probe.stderr || probe.stdout || "Python ML probe failed.",
      };
      cached = { expiresAt: now + ttlMs, result };
      return result;
    }

    const parsed = JSON.parse(probe.stdout.trim()) as {
      python_version?: string;
      libraries?: Record<string, string | null>;
      cuda?: { available?: boolean; version?: string | null; device_count?: number | null; device_name?: string | null; vram_total_mb?: number | null; vram_free_mb?: number | null; cudnn?: number | null; driver?: number | null };
      mps?: boolean;
      torch_cuda_build?: string | null;
      torch_error?: string;
    };

    python = { command: resolved.command, version: parsed.python_version ?? null };
    const libraries = parsed.libraries ?? {};
    const torchVersion = libraries.torch ?? null;
    const cudaAvailable = parsed.cuda?.available === true && config.mlAllowGpu;
    const mpsAvailable = parsed.mps === true && config.mlAllowGpu;
    if (parsed.torch_error) {
      warnings.push(`torch device probe error: ${parsed.torch_error}`);
    }
    if (parsed.cuda?.available === true && !config.mlAllowGpu) {
      warnings.push("CUDA detected but ML_ALLOW_GPU is false; jobs run CPU-only.");
    }

    const result: MlDoctorResult = {
      enabled: true,
      available: true,
      python,
      cpuCount,
      ramTotalMb,
      diskFreeMb,
      accelerator: cudaAvailable ? "cuda" : mpsAvailable ? "mps" : "cpu",
      cuda: {
        available: cudaAvailable,
        version: parsed.cuda?.version ?? null,
        deviceCount: parsed.cuda?.device_count ?? null,
        deviceName: parsed.cuda?.device_name ?? null,
        vramTotalMb: parsed.cuda?.vram_total_mb ?? null,
        vramFreeMb: parsed.cuda?.vram_free_mb ?? null,
        cudnnVersion: parsed.cuda?.cudnn ?? null,
        driverVersion: parsed.cuda?.driver ?? null,
      },
      mpsAvailable,
      torch: { installed: torchVersion !== null, version: torchVersion, cudaBuild: parsed.torch_cuda_build ?? null },
      libraries,
      warnings,
      error: null,
      checkedAt: new Date().toISOString(),
    };
    cached = { expiresAt: now + ttlMs, result };
    return result;
  } catch (error) {
    const result: MlDoctorResult = {
      ...disabledResult(),
      enabled: true,
      python,
      cpuCount,
      ramTotalMb,
      diskFreeMb,
      error: error instanceof Error ? error.message : "Unknown ML doctor failure.",
    };
    cached = { expiresAt: now + ttlMs, result };
    return result;
  }
}
