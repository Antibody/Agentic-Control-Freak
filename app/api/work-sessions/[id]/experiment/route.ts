import path from "node:path";
import { readdir } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { getConfig } from "@/lib/server/config";
import { logProcess } from "@/lib/server/logging";
import { getDatabaseSnapshot, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import {
  completeCommandReceipt,
  failCommandReceipt,
  idempotencyKeyFromRequest,
  startCommandReceipt,
} from "@/lib/server/command-receipts";
import { stackCapabilities } from "@/lib/shared/stack-capabilities";
import { readExperimentManifest } from "@/lib/server/ml/experiment-manifest";
import { runMlDoctor } from "@/lib/server/runtime/ml-doctor";
import { readVenvCapabilityArtifact } from "@/lib/server/ml/ml-env";
import { startExperimentRun, ExperimentRuntimeError } from "@/lib/server/ml/experiment-runtime";
import { emptyMlRunConfig, inspectMlRunConfigInput, normalizeMlRunConfig } from "@/lib/server/ml/run-config";
import { abortWorkSessionOperationsByKind } from "@/lib/server/runtime/operation-registry";
import type { ExperimentRunRecord, MlRunConfig, MlRunRegime } from "@/lib/shared/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DataEntry {
  path: string;
  kind: "dir" | "file";
}

function resolveWorkspacePath(workspacePath: string, rel: string): string | null {
  const base = path.resolve(workspacePath);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return null;
  }
  return target;
}

const MAX_DATA_ENTRY_OPTIONS = 1000;
const MAX_DATA_ENTRY_DEPTH = 4;

async function scanDataEntries(workspacePath: string): Promise<DataEntry[]> {
  const dataDir = path.join(workspacePath, "data");
  try {
    const out: DataEntry[] = [];
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

function validateDatasetPaths(workspacePath: string, config: MlRunConfig): string | null {
  const ds = config.dataset;
  const roles: Array<[string, string | null]> = [
    ["training", ds.trainPath],
    ["validation", ds.valPath],
    ["test", ds.testPath],
    ["corpus", ds.corpusPath],
  ];
  for (const [role, rel] of roles) {
    if (rel !== null && resolveWorkspacePath(workspacePath, rel) === null) {
      return `Dataset ${role} path is outside the workspace and was refused: ${rel}`;
    }
  }
  return null;
}

type ExperimentAction = "run-smoke" | "run-short" | "run-full" | "abort";

interface ExperimentPostRequest {
  action: ExperimentAction;
  runConfig?: unknown;
}

const regimeForAction: Record<Exclude<ExperimentAction, "abort">, MlRunRegime> = {
  "run-smoke": "smoke",
  "run-short": "short",
  "run-full": "full",
};

function latestRunFor(runs: ExperimentRunRecord[], workSessionId: string): ExperimentRunRecord | null {
  const owned = runs
    .filter((run) => run.workSessionId === workSessionId && run.regime !== "calibration")
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  return owned[0] ?? null;
}

function isExperimentPostRequest(value: unknown): value is ExperimentPostRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const action = (value as Record<string, unknown>).action;
  return action === "run-smoke" || action === "run-short" || action === "run-full" || action === "abort";
}

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const config = getConfig();
    const snapshot = await getDatabaseSnapshot();
    const workSession = snapshot.workSessions.find((session) => session.id === id);
    if (workSession === undefined) {
      return NextResponse.json({ ok: false, error: "Work session was not found." }, { status: 404 });
    }
    const manifest = await readExperimentManifest(workSession.activeWorktreePath);
    const stackEnabled = config.mlPipelineEnabled
      && (manifest !== null || (workSession.stackDecision?.stack === "python-ml")
        || (stackCapabilities(workSession.stackDecision?.stack ?? "unknown").supportsExperimentRuntime === true));
    let gpu: { accelerator: "cpu" | "cuda" | "mps"; deviceName: string | null; allowGpu: boolean; warning: string | null } | null = null;
    if (stackEnabled) {
      const capability = await readVenvCapabilityArtifact(workSession.activeWorktreePath);
      if (capability !== null) {
        const accelerator: "cpu" | "cuda" | "mps" = config.mlAllowGpu && capability.cudaAvailable
          ? "cuda"
          : config.mlAllowGpu && capability.mpsAvailable
            ? "mps"
            : "cpu";
        gpu = {
          accelerator,
          deviceName: capability.deviceName,
          allowGpu: config.mlAllowGpu,
          warning: (!config.mlAllowGpu && (capability.cudaAvailable || capability.mpsAvailable))
            ? "CUDA is available in the project venv but ML_ALLOW_GPU is false; runs use CPU."
            : null,
        };
      } else {
        const doctor = await runMlDoctor().catch(() => null);
        gpu = doctor === null
          ? null
          : {
              accelerator: doctor.accelerator,
              deviceName: doctor.cuda.deviceName,
              allowGpu: config.mlAllowGpu,
              warning: doctor.warnings.find((entry) => entry.includes("ML_ALLOW_GPU")) ?? null,
            };
      }
    }
    const dataEntries = stackEnabled ? await scanDataEntries(workSession.activeWorktreePath) : [];
    return NextResponse.json({
      ok: true,
      data: {
        enabled: stackEnabled,
        manifest,
        runConfig: workSession.mlRunConfig ?? emptyMlRunConfig(),
        latestRun: latestRunFor(snapshot.experimentRuns, id),
        gpu,
        dataEntries,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown experiment metadata error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  let receiptId = "";
  try {
    const { id } = await context.params;
    const config = getConfig();
    if (!config.mlPipelineEnabled) {
      return NextResponse.json({ ok: false, error: "The ML pipeline is disabled." }, { status: 400 });
    }
    const body = (await request.json().catch(() => ({}))) as unknown;
    if (!isExperimentPostRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid experiment request." }, { status: 400 });
    }

    const snapshot = await getDatabaseSnapshot();
    const workSession = snapshot.workSessions.find((session) => session.id === id);
    if (workSession === undefined) {
      return NextResponse.json({ ok: false, error: "Work session was not found." }, { status: 404 });
    }

    if (body.action === "abort") {
      const aborted = abortWorkSessionOperationsByKind(id, "experiment", "User aborted the experiment.");
      return NextResponse.json({ ok: true, data: { aborted } });
    }

    const receipt = await startCommandReceipt({
      workSessionId: id,
      commandType: "experiment",
      idempotencyKey: idempotencyKeyFromRequest(request.headers, body),
      requestBody: body,
    });
    if (receipt.mode === "replay") {
      return NextResponse.json(receipt.response, { status: receipt.response.ok ? 200 : 409 });
    }
    receiptId = receipt.receiptId;

    const warnings: string[] = [];
    if (body.runConfig !== undefined) {
      const inspection = inspectMlRunConfigInput(body.runConfig);
      if (inspection.unknownKeys.length > 0) {
        warnings.push(`Ignored unknown runConfig field(s): ${inspection.unknownKeys.join(", ")}.`);
      }
      if (inspection.coerced.length > 0) {
        warnings.push(`Reset invalid runConfig value(s) to default: ${inspection.coerced.join(", ")}.`);
      }
      if (warnings.length > 0) {
        logProcess("warn", "experiment.runconfig.coerced", {
          workSessionId: id,
          unknownKeys: inspection.unknownKeys,
          coerced: inspection.coerced,
        });
      }
      const normalized = normalizeMlRunConfig(body.runConfig);
      const datasetPathError = validateDatasetPaths(workSession.activeWorktreePath, normalized);
      if (datasetPathError !== null) {
        await failCommandReceipt(receiptId, new Error(datasetPathError));
        return NextResponse.json({ ok: false, error: datasetPathError }, { status: 400 });
      }
      await mutateDatabase((db) => {
        const record = db.workSessions.find((candidate) => candidate.id === id);
        if (record === undefined) {
          throw new Error("Work session was not found.");
        }
        record.mlRunConfig = normalized;
        updateWorkSessionTimestamp(record);
      });
    }

    const run = await startExperimentRun({ workSessionId: id, regime: regimeForAction[body.action] });
    await completeCommandReceipt(receiptId, run);
    return NextResponse.json(warnings.length > 0 ? { ok: true, data: run, warnings } : { ok: true, data: run });
  } catch (error) {
    if (receiptId.length > 0) {
      await failCommandReceipt(receiptId, error);
    }
    const message = error instanceof Error ? error.message : "Unknown experiment API error.";
    const status = error instanceof ExperimentRuntimeError ? 400 : 500;
    logProcess("warn", "experiment.api.failed", { status, message });
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
