import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { getConfig } from "@/lib/server/config";
import { logProcess } from "@/lib/server/logging";
import { createMlJobProcessEnv } from "@/lib/server/runtime/env";
import { freeDiskMb, probeVenvCapability, runMlDoctor, type VenvCapability } from "@/lib/server/runtime/ml-doctor";
import { ensurePythonWorkspaceEnvironment } from "@/lib/server/runtime/python-environment";
import { runProcess, type ProcessEnvironment, type ProcessProgressHandlers } from "@/lib/server/runtime/process-runner";
import { cudaIndexTag, mlCacheEnv, resolveCudaIndexTag, writeVenvCapabilityArtifact } from "@/lib/server/ml/ml-env";

export class MlInstallError extends Error {}

const heavyPackagePattern = /\b(torch|torchvision|torchaudio|tensorflow|jax|jaxlib|transformers|accelerate|xgboost|lightgbm|vllm|unsloth)\b/i;
const torchFamily = ["torch", "torchvision", "torchaudio"];

function torchPackageSpec(lines: string[], pkg: string): string {
  const matcher = new RegExp(`^${pkg}\\b`, "i");
  for (const line of lines) {
    const clean = line.replace(/\s+#.*$/, "").trim();
    if (matcher.test(clean)) {
      return clean;
    }
  }
  return pkg;
}

export interface RequirementsAnalysis {
  meaningful: string[];
  heavy: boolean;
  torchPackages: string[];
  torchRequested: boolean;
}

function requirementName(line: string): string {
  const clean = line.replace(/\s+#.*$/, "").trim();
  const match = clean.match(/^([A-Za-z0-9._-]+)/);
  return match === null ? "" : match[1].toLowerCase();
}

export function analyzeRequirements(requirements: string): RequirementsAnalysis {
  const meaningful = requirements
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const heavy = heavyPackagePattern.test(meaningful.join("\n"));
  const names = new Set(meaningful.map(requirementName));
  const torchPackages = torchFamily.filter((pkg) => names.has(pkg));
  return { meaningful, heavy, torchPackages, torchRequested: heavy && torchPackages.length > 0 };
}

const VERSION_UNAVAILABLE = /no matching distribution found|could not find a version that satisfies/i;

function hasVersionPin(spec: string): boolean {
  return /[<>=!~]/.test(spec.replace(/^[A-Za-z0-9._-]+/, ""));
}

/** Read the installed versions of the requested torch-family packages (e.g. "torch" -> "2.6.0+cu124"). */
async function installedTorchVersions(
  pythonCommand: string,
  packages: string[],
  cwd: string,
  env: ProcessEnvironment,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  if (packages.length === 0) {
    return versions;
  }
  const probe = await runProcess({
    command: pythonCommand,
    args: [
      "-c",
      "import importlib.metadata as m,sys\nfor n in sys.argv[1:]:\n try: print(n+'=='+m.version(n))\n except Exception: pass",
      ...packages,
    ],
    cwd,
    timeoutMs: 60000,
    env,
    signal,
  }).catch(() => null);
  for (const line of (probe?.stdout ?? "").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9._-]+)==(.+)$/);
    if (match !== null) {
      versions.set(match[1].toLowerCase(), match[2]);
    }
  }
  return versions;
}

/** Rewrite the torch-family lines in requirements.txt to the resolved CUDA build (e.g. torch==2.6.0+cu124) so a
 *  later `pip install -r requirements.txt` resolves the same wheel from the CUDA index instead of clobbering it
 *  with a CPU build from PyPI. */
async function reconcileRequirementsTorch(workspacePath: string, versions: Map<string, string>): Promise<void> {
  if (versions.size === 0) {
    return;
  }
  const reqPath = path.join(workspacePath, "requirements.txt");
  let text: string;
  try {
    text = await readFile(reqPath, "utf8");
  } catch {
    return;
  }
  const seenTorch = new Set<string>();
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = requirementName(line);
    if (torchFamily.includes(name)) {
      if (seenTorch.has(name)) {
        continue; // drop the duplicate torch-family line
      }
      seenTorch.add(name);
      const resolved = versions.get(name);
      lines.push(resolved !== undefined ? `${name}==${resolved}` : line);
    } else {
      lines.push(line);
    }
  }
  await writeFile(reqPath, lines.join("\n"), "utf8").catch(() => undefined);
}

export interface CudaTorchResult {
  extraIndexArgs: string[];
  command: string | null;
  stdout: string;
  stderr: string;
  cpuFallback: boolean;
}

const CPU_TORCH_INDEX_URL = "https://download.pytorch.org/whl/cpu";

async function installCpuTorchFallback(input: {
  workspacePath: string;
  pythonCommand: string;
  analysis: RequirementsAnalysis;
  env: ProcessEnvironment;
  timeoutMs: number;
  signal?: AbortSignal;
  progress?: ProcessProgressHandlers;
  forceReinstall: boolean;
  reason: string;
}): Promise<CudaTorchResult> {
  const cpuArgs = [
    "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--no-cache-dir",
    "--index-url", CPU_TORCH_INDEX_URL,
    ...(input.forceReinstall ? ["--force-reinstall"] : []),
    ...input.analysis.torchPackages, // bare names: newest mutually-compatible CPU build on the index
  ];
  const cpu = await runProcess({
    command: input.pythonCommand,
    args: cpuArgs,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    env: input.env,
    signal: input.signal,
    progress: input.progress,
  });
  if (cpu.exitCode !== 0 || cpu.timedOut) {
    throw new MlInstallError(`CUDA torch install failed and the CPU-wheel fallback also failed.\n${cpu.stderr || cpu.stdout}`);
  }
  const resolved = await installedTorchVersions(input.pythonCommand, input.analysis.torchPackages, input.workspacePath, input.env, input.signal);
  await reconcileRequirementsTorch(input.workspacePath, resolved);
  logProcess("warn", "ml.cuda_torch.cpu_fallback", {
    reason: input.reason,
    resolved: [...resolved.entries()].map(([name, ver]) => `${name}==${ver}`).join(" "),
    index: CPU_TORCH_INDEX_URL,
  });
  return {
    extraIndexArgs: ["--extra-index-url", CPU_TORCH_INDEX_URL],
    command: `python ${cpuArgs.join(" ")}`,
    stdout: cpu.stdout,
    stderr: cpu.stderr,
    cpuFallback: true,
  };
}

export async function ensureCudaTorch(input: {
  workspacePath: string;
  pythonCommand: string;
  analysis: RequirementsAnalysis;
  env: ProcessEnvironment;
  timeoutMs: number;
  signal?: AbortSignal;
  progress?: ProcessProgressHandlers;
}): Promise<CudaTorchResult> {
  const config = getConfig();
  if (!(input.analysis.torchRequested && config.mlAllowGpu)) {
    return { extraIndexArgs: [], command: null, stdout: "", stderr: "", cpuFallback: false };
  }
  if (!config.mlAllowNetworkDownloads) {
    throw new MlInstallError(
      "GPU was requested (ML_ALLOW_GPU=true) but downloads are disabled (ML_ALLOW_NETWORK_DOWNLOADS=false), so a CUDA-enabled torch wheel cannot be fetched. Enable downloads, or set ML_ALLOW_GPU=false / device=cpu to run on CPU.",
    );
  }
  const doctor = await runMlDoctor().catch(() => null);
  const cudaTag = resolveCudaIndexTag(doctor?.cuda.version ?? null, config.mlDefaultCudaTag);
  if (cudaTag === null) {
    throw new MlInstallError(
      "GPU was requested but no published PyTorch CUDA index tag could be determined. Set ML_DEFAULT_CUDA_TAG to one of cu118/cu121/cu124/cu126/cu128 matching your GPU driver.",
    );
  }
  const indexUrl = `https://download.pytorch.org/whl/${cudaTag}`;
  const extraIndexArgs = ["--extra-index-url", indexUrl];

  const current = await probeVenvCapability(input.workspacePath, { force: true, signal: input.signal });
  if (current.torchInstalled && current.cudaAvailable && cudaIndexTag(current.cudaBuild) === cudaTag) {
    return { extraIndexArgs, command: null, stdout: "", stderr: "", cpuFallback: false };
  }

  const torchSpecs = input.analysis.torchPackages.map((pkg) => torchPackageSpec(input.analysis.meaningful, pkg));
  const torchArgs = [
    "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--no-cache-dir",
    "--index-url", indexUrl,
    ...(current.torchInstalled ? ["--force-reinstall"] : []),
    ...torchSpecs,
  ];
  const result = await runProcess({
    command: input.pythonCommand,
    args: torchArgs,
    cwd: input.workspacePath,
    timeoutMs: input.timeoutMs,
    env: input.env,
    signal: input.signal,
    progress: input.progress,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    const relaxable = !result.timedOut
      && VERSION_UNAVAILABLE.test(result.stderr || result.stdout)
      && torchSpecs.some(hasVersionPin);
    if (relaxable) {
      const relaxedArgs = [
        "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "--no-cache-dir",
        "--index-url", indexUrl,
        ...(current.torchInstalled ? ["--force-reinstall"] : []),
        ...input.analysis.torchPackages, // bare names: let pip pick the newest mutually-compatible set on the index
      ];
      const retry = await runProcess({
        command: input.pythonCommand,
        args: relaxedArgs,
        cwd: input.workspacePath,
        timeoutMs: input.timeoutMs,
        env: input.env,
        signal: input.signal,
        progress: input.progress,
      });
      if (retry.exitCode === 0 && !retry.timedOut) {
        const resolved = await installedTorchVersions(input.pythonCommand, input.analysis.torchPackages, input.workspacePath, input.env, input.signal);
        await reconcileRequirementsTorch(input.workspacePath, resolved);
        logProcess("warn", "ml.cuda_torch.version_relaxed", {
          requested: torchSpecs.join(" "),
          resolved: [...resolved.entries()].map(([name, ver]) => `${name}==${ver}`).join(" "),
          index: indexUrl,
        });
        return {
          extraIndexArgs,
          command: `python ${relaxedArgs.join(" ")}`,
          stdout: retry.stdout,
          stderr: retry.stderr,
          cpuFallback: false,
        };
      }
    }
    return await installCpuTorchFallback({
      workspacePath: input.workspacePath,
      pythonCommand: input.pythonCommand,
      analysis: input.analysis,
      env: input.env,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      progress: input.progress,
      forceReinstall: current.torchInstalled,
      reason: result.timedOut ? "cuda-install-timeout" : "cuda-install-failed",
    });
  }
  return {
    extraIndexArgs,
    command: `python ${torchArgs.join(" ")}`,
    stdout: result.stdout,
    stderr: result.stderr,
    cpuFallback: false,
  };
}

export async function verifyVenvTorchInstall(input: {
  workspacePath: string;
  analysis: RequirementsAnalysis;
  signal?: AbortSignal;
  repair?: { pythonCommand: string; env: ProcessEnvironment; timeoutMs: number; progress?: ProcessProgressHandlers };
  cpuFallback?: boolean;
}): Promise<VenvCapability | null> {
  if (!input.analysis.torchRequested) {
    return null;
  }
  const config = getConfig();
  let cpuFallback = input.cpuFallback ?? false;
  let capability = await probeVenvCapability(input.workspacePath, { force: true, signal: input.signal });
  if (config.mlAllowGpu && capability.torchInstalled && !capability.cudaAvailable && input.repair !== undefined) {
    const repaired = await ensureCudaTorch({
      workspacePath: input.workspacePath,
      pythonCommand: input.repair.pythonCommand,
      analysis: input.analysis,
      env: input.repair.env,
      timeoutMs: input.repair.timeoutMs,
      signal: input.signal,
      progress: input.repair.progress,
    });
    cpuFallback = cpuFallback || repaired.cpuFallback;
    capability = await probeVenvCapability(input.workspacePath, { force: true, signal: input.signal });
  }
  await writeVenvCapabilityArtifact(input.workspacePath, capability).catch(() => undefined);
  if (!capability.torchInstalled) {
    throw new MlInstallError(
      `torch is required by this project but cannot be imported in the project environment` +
        `${capability.torchVersion !== null ? ` (installed torch=${capability.torchVersion})` : ""}. ` +
        `This usually means a broken or platform-incompatible torch wheel or missing system libraries; ` +
        `the model cannot train or run inference until torch imports. Verify the project venv and that a ` +
        `torch wheel compatible with this OS/Python is available (ML_DEFAULT_CUDA_TAG for GPU builds).`,
    );
  }
  if (config.mlAllowGpu && config.mlRequireVenvCudaVerify && capability.torchInstalled && !capability.cudaAvailable) {
    if (cpuFallback) {
      logProcess("warn", "ml.torch.cpu_only_after_fallback", {
        workspacePath: input.workspacePath,
        torchVersion: capability.torchVersion,
        reason: "A CUDA torch wheel could not be installed; the run proceeds on a CPU-only torch build.",
      });
      return capability;
    }
    throw new MlInstallError(
      `GPU was requested but the torch installed in the project venv cannot use CUDA (torch=${capability.torchVersion ?? "unknown"}, cuda_build=${capability.cudaBuild ?? "none"}, is_available=false). The venv likely holds a CPU-only wheel. Ensure a CUDA driver is present and ML_DEFAULT_CUDA_TAG matches it, set ML_ALLOW_GPU=false to run on CPU, or set ML_REQUIRE_VENV_CUDA_VERIFY=false to proceed anyway.`,
    );
  }
  return capability;
}

export interface MlInstallResult {
  installed: boolean;
  command: string;
  heavy: boolean;
  cudaVerified: boolean;
  capability: VenvCapability | null;
}

export async function installMlRequirements(input: {
  workspacePath: string;
  signal: AbortSignal;
}): Promise<MlInstallResult> {
  const config = getConfig();

  let requirements = "";
  try {
    requirements = await readFile(path.join(input.workspacePath, "requirements.txt"), "utf8");
  } catch {
    requirements = "";
  }

  const python = await ensurePythonWorkspaceEnvironment({
    workspacePath: input.workspacePath,
    timeoutMs: Math.max(config.shellTimeoutMs, 180000),
    signal: input.signal,
  });
  if (python.setupResult !== null && (python.setupResult.exitCode !== 0 || python.setupResult.timedOut)) {
    throw new MlInstallError(
      `Python virtual environment setup failed.\n${python.setupResult.stderr || python.setupResult.stdout}`,
    );
  }

  const analysis = analyzeRequirements(requirements);
  if (analysis.meaningful.length === 0) {
    return { installed: false, command: "", heavy: false, cudaVerified: false, capability: null };
  }

  const doctor = await runMlDoctor().catch(() => null);
  if (analysis.heavy) {
    const freeMb = doctor?.diskFreeMb ?? await freeDiskMb(input.workspacePath);
    if (freeMb !== null && freeMb < config.mlDiskBudgetMb) {
      throw new MlInstallError(
        `Heavy ML dependencies require at least ${config.mlDiskBudgetMb}MB free disk, but only ${freeMb}MB is available (ML_DISK_BUDGET_MB). Free space or lower the budget.`,
      );
    }
  }

  const env = createMlJobProcessEnv({ ...mlCacheEnv(), CI: "true" }, { allowSecrets: config.mlAllowSecrets });
  const timeoutMs = Math.max(config.mlJobTimeoutMs, 600000);
  const commands: string[] = [];

  const cuda = await ensureCudaTorch({
    workspacePath: input.workspacePath,
    pythonCommand: python.command,
    analysis,
    env,
    timeoutMs,
    signal: input.signal,
  });
  if (cuda.command !== null) {
    commands.push(cuda.command);
  }

  const noCacheArg = analysis.heavy ? ["--no-cache-dir"] : [];
  const args = ["-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", ...noCacheArg, "-r", "requirements.txt", ...cuda.extraIndexArgs];
  const result = await runProcess({
    command: python.command,
    args,
    cwd: input.workspacePath,
    timeoutMs,
    env,
    signal: input.signal,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    const detail = (result.stderr || result.stdout).trim();
    throw new MlInstallError(
      detail.length > 0
        ? `Dependency install failed.\n${detail}`
        : `Dependency install failed (exit ${result.exitCode ?? "killed"}${result.timedOut ? ", timed out" : ""}) with no captured output. This usually means the disk filled up mid-install or the process was killed. Check free disk space (ML_DISK_BUDGET_MB) and retry.`,
    );
  }
  commands.push(`python ${args.join(" ")}`);

  if (analysis.torchRequested && !analysis.meaningful.some((line) => requirementName(line) === "numpy")) {
    const numpyArgs = ["-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location", "numpy"];
    const numpyResult = await runProcess({
      command: python.command,
      args: numpyArgs,
      cwd: input.workspacePath,
      timeoutMs,
      env,
      signal: input.signal,
    });
    if (numpyResult.exitCode === 0 && !numpyResult.timedOut) {
      commands.push(`python ${numpyArgs.join(" ")}`);
    } else {
      logProcess("warn", "ml.numpy.autoinstall_failed", { detail: (numpyResult.stderr || numpyResult.stdout).slice(-500) });
    }
  }

  const capability = await verifyVenvTorchInstall({
    workspacePath: input.workspacePath,
    analysis,
    signal: input.signal,
    repair: { pythonCommand: python.command, env, timeoutMs },
    cpuFallback: cuda.cpuFallback,
  });

  return {
    installed: true,
    command: commands.join(" && "),
    heavy: analysis.heavy,
    cudaVerified: capability?.cudaAvailable ?? false,
    capability,
  };
}
