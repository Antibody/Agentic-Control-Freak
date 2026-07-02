import { getConfig } from "@/lib/server/config";
import { saveArtifact } from "@/lib/server/artifacts";
import { createMlJobProcessEnv } from "@/lib/server/runtime/env";
import { runMlDoctor } from "@/lib/server/runtime/ml-doctor";
import { resolvePythonCommand } from "@/lib/server/runtime/python-resolver";
import { runProcess } from "@/lib/server/runtime/process-runner";
import type { VenvCapability } from "@/lib/server/runtime/ml-doctor";
import type { ArtifactRecord, Identifier, MlDevice, MlRunConfig } from "@/lib/shared/types";

export async function writeProvenanceArtifact(input: {
  workSessionId: Identifier;
  workspacePath: string;
  config: MlRunConfig;
  stamp: number;
  signal?: AbortSignal;
  capability?: VenvCapability | null;
  intendedDevice?: MlDevice;
  effectiveDevice?: MlDevice | null;
  deviceMismatch?: boolean;
}): Promise<ArtifactRecord | null> {
  const appConfig = getConfig();
  let pipFreeze = "";
  try {
    const python = await resolvePythonCommand(input.workspacePath);
    const result = await runProcess({
      command: python.command,
      args: ["-m", "pip", "freeze", "--disable-pip-version-check"],
      cwd: input.workspacePath,
      timeoutMs: 60_000,
      env: createMlJobProcessEnv({ CI: "true" }),
      signal: input.signal,
    });
    if (result.exitCode === 0 && !result.timedOut) {
      pipFreeze = result.stdout.trim();
    }
  } catch {
    pipFreeze = "";
  }

  let hardware: Record<string, unknown> = {};
  let libraries: Record<string, string | null> = {};
  try {
    const doctor = await runMlDoctor();
    hardware = {
      accelerator: doctor.accelerator,
      cpuCount: doctor.cpuCount,
      ramTotalMb: doctor.ramTotalMb,
      cuda: doctor.cuda,
      mpsAvailable: doctor.mpsAvailable,
      torch: doctor.torch,
      pythonVersion: doctor.python.version,
      hostScope: "host interpreter (advisory only)",
      venv: input.capability ?? null,
    };
    libraries = doctor.libraries;
  } catch {
    hardware = { venv: input.capability ?? null };
    libraries = {};
  }

  const intendedDevice = input.intendedDevice ?? input.config.device;
  const effectiveDevice = input.effectiveDevice ?? null;
  const deviceMismatch = input.deviceMismatch ?? false;

  const onGpu = input.config.device === "cuda" || input.config.device === "mps"
    || (input.config.device === "auto" && hardware.accelerator !== undefined && hardware.accelerator !== "cpu");

  const policy = {
    determinism: onGpu
      ? "recorded-only (some accelerator kernels have no deterministic implementation)"
      : "hard-gate (two independent CPU launches with the same seed must match)",
    trustRemoteCode: appConfig.mlTrustRemoteCode,
    trustRemoteCodeNote: appConfig.mlTrustRemoteCode
      ? "ENABLED: remote model code is permitted to execute (ML_TRUST_REMOTE_CODE=true)."
      : "disabled: safetensors and weights-only loads are preferred; pin model revision and hash before enabling.",
    allowNetworkDownloads: appConfig.mlAllowNetworkDownloads,
    allowGpu: appConfig.mlAllowGpu,
    allowSecrets: appConfig.mlAllowSecrets,
    weightsLoad: "safetensors by default; weights_only checkpoint load where the framework supports it",
  };

  const provenance = {
    capturedAt: new Date().toISOString(),
    seed: input.config.seed,
    intendedDevice,
    effectiveDevice,
    deviceMismatch,
    config: input.config,
    policy,
    hardware,
    libraries,
    packages: pipFreeze.length > 0 ? pipFreeze.split(/\r?\n/).filter((line) => line.trim().length > 0) : [],
  };

  const deviceSummary = deviceMismatch
    ? `intended ${intendedDevice} / effective ${effectiveDevice ?? "unknown"} (MISMATCH)`
    : `device ${effectiveDevice ?? intendedDevice}`;

  try {
    return await saveArtifact({
      workSessionId: input.workSessionId,
      kind: "report",
      fileName: `ml-provenance-${input.stamp}.json`,
      content: JSON.stringify(provenance, null, 2),
      metadata: {
        reportType: "ml_provenance",
        summary: `seed ${input.config.seed}, ${deviceSummary}, ${provenance.packages.length} pinned packages, determinism ${onGpu ? "recorded" : "gated"}`,
      },
    });
  } catch {
    return null;
  }
}
