import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { selectMlScaffold } from "../lib/server/ml/scaffold-sources.ts";
import { planVramFit, estimateVramMb } from "../lib/server/ml/vram-preflight.ts";
import { predictHarnessSource, PREDICT_HARNESS_FILENAME } from "../lib/server/ml/inference/predict-harness-source.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const scratch = path.join(root, ".workspace", ".ml-validate");
const pythonCommand = process.platform === "win32" ? "python" : "python3";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log("  PASS", name, detail ? "(" + detail + ")" : "");
  } else {
    failed += 1;
    failures.push(name + (detail ? " - " + detail : ""));
    console.log("  FAIL", name, detail ? "(" + detail + ")" : "");
  }
}

function runPython(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(pythonCommand, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: stderr + String(error) }));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function runHarness(args, cwd, env, stdinText) {
  return new Promise((resolve) => {
    const child = spawn(pythonCommand, args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr: stderr + String(error) }));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function parseNdjson(text) {
  const messages = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
    }
  }
  return messages;
}

async function validateInference(entry, scaffold, dir) {
  if (scaffold.predict === null || scaffold.predict === undefined) {
    return;
  }
  const sandbox = path.join(dir, ".orchestrator", "inference");
  await mkdir(path.join(sandbox, "inputs"), { recursive: true });
  await mkdir(path.join(sandbox, "outputs"), { recursive: true });
  const harnessPath = path.join(sandbox, PREDICT_HARNESS_FILENAME);
  await writeFile(harnessPath, predictHarnessSource, "utf8");

  const example = scaffold.predict.contract.examples[0] ?? { inputs: {} };
  const request = JSON.stringify({ type: "predict", id: "v1", inputs: example.inputs, options: {} });
  const shutdown = JSON.stringify({ type: "shutdown" });
  const result = await runHarness(
    [harnessPath],
    dir,
    {
      ACF_INFERENCE_DIR: sandbox,
      ACF_PREDICT_ENTRYPOINT: scaffold.predict.entrypoint,
      ACF_DEVICE: "cpu",
      ACF_INFERENCE_TIMEOUT_S: "60",
      PYTHONUNBUFFERED: "1",
    },
    request + "\n" + shutdown + "\n",
  );

  const messages = parseNdjson(result.stdout);
  const ready = messages.find((message) => message.type === "ready");
  const prediction = messages.find((message) => message.type === "result" && message.id === "v1");
  const errorMessage = messages.find((message) => message.type === "error");
  check(
    entry.kind + ": inference ready handshake",
    ready !== undefined && typeof ready.contract === "object" && ready.contract !== null,
    ready === undefined ? (errorMessage ? errorMessage.message : result.stderr.slice(-200)) : "",
  );
  check(
    entry.kind + ": inference result well-formed",
    prediction !== undefined && typeof prediction.outputs === "object" && prediction.outputs !== null,
    prediction === undefined ? (errorMessage ? errorMessage.message : result.stderr.slice(-200)) : JSON.stringify(prediction.outputs).slice(0, 120),
  );
}

async function detectTorch() {
  const result = await runPython(["-c", "import torch"], root);
  return result.code === 0;
}

function beatsBaseline(summary) {
  const primary = summary.primary;
  const baseline = summary.baseline;
  if (primary === undefined || baseline === undefined || baseline === null) {
    return null;
  }
  return primary.goal === "min" ? primary.value < baseline.value : primary.value > baseline.value;
}

async function validateScaffold(entry, torchAvailable) {
  console.log("\n[" + entry.kind + "] " + entry.request);
  const scaffold = selectMlScaffold(entry.request, { torchAvailable: entry.torch });
  check(entry.kind + ": selection", scaffold.kind === entry.kind, "got " + scaffold.kind);

  const knownModes = ["builtin", "single_corpus", "train_test", "train_val_test", "jsonl_finetune", "custom"];
  const knownFormats = ["auto", "text", "jsonl", "csv", "image_folder", "other"];
  const data = scaffold.data;
  const dataOk = data != null
    && knownModes.includes(data.recommendedMode)
    && knownFormats.includes(data.format)
    && Array.isArray(data.supportedModes) && data.supportedModes.length > 0
    && typeof data.guidance === "string" && data.guidance.length > 0;
  check(entry.kind + ": data contract", dataOk, data == null ? "missing" : data.recommendedMode + "/" + data.format);

  if (entry.selectionOnly) {
    console.log("  selection-only case; run skipped.");
    return;
  }

  if (entry.torch && !torchAvailable) {
    console.log("  SKIP run (torch not importable in this interpreter); selection asserted only.");
    return;
  }

  const dir = path.join(scratch, entry.kind);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of scaffold.files) {
    await writeFile(path.join(dir, file.path), file.content, "utf8");
  }
  await writeFile(path.join(dir, "requirements.txt"), scaffold.requirements, "utf8");

  const smoke = await runPython([scaffold.entrypoint, "--smoke"], dir);
  let smokePassed = false;
  try {
    const report = JSON.parse(await readFile(path.join(dir, "smoke_report.json"), "utf8"));
    smokePassed = report.passed === true;
  } catch {
    smokePassed = false;
  }
  check(entry.kind + ": smoke exit 0", smoke.code === 0, "exit " + smoke.code + (smoke.code !== 0 ? " :: " + smoke.stderr.slice(-300) : ""));
  check(entry.kind + ": smoke_report passed", smokePassed, "");

  const full = await runPython([scaffold.entrypoint], dir);
  check(entry.kind + ": full run exit 0", full.code === 0, "exit " + full.code + (full.code !== 0 ? " :: " + full.stderr.slice(-300) : ""));

  let summary = null;
  try {
    summary = JSON.parse(await readFile(path.join(dir, scaffold.summary ?? "metrics.json"), "utf8"));
  } catch {
    summary = null;
  }
  check(entry.kind + ": metrics.json primary", summary !== null && summary.primary !== undefined && typeof summary.primary.value === "number", "");

  if (scaffold.metrics !== null) {
    let lineCount = 0;
    try {
      const stream = await readFile(path.join(dir, scaffold.metrics), "utf8");
      lineCount = stream.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    } catch {
      lineCount = 0;
    }
    check(entry.kind + ": metrics.jsonl streamed", lineCount > 0, lineCount + " lines");
  }

  if (entry.checkBaseline && summary !== null) {
    const result = beatsBaseline(summary);
    check(entry.kind + ": primary beats baseline", result === true, JSON.stringify(summary.primary) + " vs " + JSON.stringify(summary.baseline));
  }

  if (full.code === 0) {
    await validateInference(entry, scaffold, dir);
  }
}

function validateDegradation(entry) {
  console.log("\n[degradation] " + entry.request + " (torch=" + entry.torch + ")");
  const scaffold = selectMlScaffold(entry.request, { torchAvailable: entry.torch });
  check("degrade: kind", scaffold.kind === entry.kind, "got " + scaffold.kind);
  check("degrade: degradedFrom", scaffold.degradedFrom === entry.degradedFrom, "got " + String(scaffold.degradedFrom));
}

function validateVram(entry) {
  console.log("\n[vram] " + entry.name);
  const input = {
    paramsMillions: entry.paramsMillions,
    precision: entry.precision,
    batchSize: entry.batchSize,
    seqLen: entry.seqLen,
    gradAccum: 1,
    optimizer: entry.optimizer,
    training: entry.training,
    trainableFraction: entry.trainableFraction,
    hiddenSize: 2048,
    layers: 24,
    gradientCheckpointing: false,
  };
  const estimate = estimateVramMb(input);
  const plan = planVramFit(input, entry.budgetMb);
  check("vram: " + entry.name, plan.decision === entry.expect, "decision " + plan.decision + ", est " + estimate + "MB");
}

async function main() {
  const corpus = JSON.parse(await readFile(path.join(here, "ml-corpus.json"), "utf8"));
  const torchAvailable = await detectTorch();
  console.log("torch importable:", torchAvailable);

  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });

  for (const entry of corpus.scaffolds) {
    await validateScaffold(entry, torchAvailable);
  }
  for (const entry of corpus.degradation) {
    validateDegradation(entry);
  }
  for (const entry of corpus.vram) {
    validateVram(entry);
  }

  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);

  console.log("\n=== ml validation: " + passed + " passed, " + failed + " failed ===");
  if (failed > 0) {
    console.log("failures:\n - " + failures.join("\n - "));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
