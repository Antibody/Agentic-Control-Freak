import { readFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const dbPath = args.find((arg) => !arg.startsWith("--")) ?? path.join(".data", "closed-dev-loop.json");
const db = JSON.parse(readFileSync(dbPath, "utf8"));

const manifestOnlyFiles = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

function repairKind(task) {
  if (typeof task.metadata?.repairForPreviewId === "string") return "preview";
  if (typeof task.metadata?.repairForVerificationRunId === "string") return "verification";
  if (typeof task.metadata?.repairForTaskId === "string") return "execution";
  return null;
}

function isManifestOnly(task) {
  const targetFiles = Array.isArray(task.metadata?.targetFiles) ? task.metadata.targetFiles : [];
  const normalized = targetFiles.map((file) => String(file).replace(/\\/g, "/"));
  return normalized.includes("package.json") && normalized.every((file) => manifestOnlyFiles.has(file.split("/").pop() ?? file));
}

function probeCounts(rawOutput) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  if (typeof rawOutput !== "string" || !rawOutput.includes("runtime-interaction:")) {
    return counts;
  }
  try {
    const parsed = JSON.parse(rawOutput.slice(rawOutput.indexOf("{")));
    for (const result of parsed.results ?? []) {
      if (typeof result.specId === "string" && result.specId.startsWith("runtime-interaction:") && counts[result.status] !== undefined) {
        counts[result.status] += 1;
      }
    }
  } catch {
  }
  return counts;
}

const sessions = (db.workSessions ?? []).map((workSession) => {
  const planIds = new Set((db.plans ?? []).filter((plan) => plan.workSessionId === workSession.id).map((plan) => plan.id));
  const tasks = (db.tasks ?? []).filter((task) => planIds.has(task.planId));
  const repairs = { verification: 0, preview: 0, execution: 0 };
  const fingerprints = new Map();
  let zeroAttemptNonManifestDone = 0;
  let totalAttempts = 0;
  for (const task of tasks) {
    totalAttempts += task.attemptCount ?? 0;
    const kind = repairKind(task);
    if (kind !== null) {
      repairs[kind] += 1;
    }
    const fingerprint = task.lastFailureFingerprint ?? task.metadata?.failureFingerprint;
    if (typeof fingerprint === "string" && fingerprint.length > 0) {
      fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + Math.max(1, task.attemptCount ?? 1));
    }
    if (task.status === "done" && (task.attemptCount ?? 0) === 0 && !isManifestOnly(task)) {
      zeroAttemptNonManifestDone += 1;
    }
  }
  const verifications = (db.verificationRuns ?? []).filter((run) => run.workSessionId === workSession.id);
  const verificationByKind = {};
  const probes = { passed: 0, failed: 0, skipped: 0 };
  for (const run of verifications) {
    if (run.status === "failed") {
      verificationByKind[run.failureKind] = (verificationByKind[run.failureKind] ?? 0) + 1;
    }
    const counts = probeCounts(run.rawOutput);
    probes.passed += counts.passed;
    probes.failed += counts.failed;
    probes.skipped += counts.skipped;
  }
  const agentStarted = (db.eventLog ?? []).filter((event) => event.workSessionId === workSession.id && event.eventName === "agent.started");
  const retryContextRuns = agentStarted.filter((event) => event.payload?.dispatchRetryContext === true).length;
  const continuityRuns = agentStarted.filter((event) => event.payload?.dispatchContinuityContext === true).length;
  const durationMs = new Date(workSession.updatedAt).getTime() - new Date(workSession.startedAt).getTime();
  return {
    id: workSession.id,
    goal: String(workSession.lastUserMessage ?? "").replace(/\s+/g, " ").slice(0, 60),
    state: workSession.currentState,
    durationMin: Math.round(durationMs / 60000),
    tasks: tasks.length,
    done: tasks.filter((task) => task.status === "done").length,
    totalAttempts,
    repairs,
    repairTotal: repairs.verification + repairs.preview + repairs.execution,
    maxAttemptsPerFingerprint: Math.max(0, ...fingerprints.values()),
    verificationRuns: verifications.length,
    verificationFailuresByKind: verificationByKind,
    interactionProbes: probes,
    agentRuns: agentStarted.length,
    retryContextRuns,
    continuityRuns,
    zeroAttemptNonManifestDone,
  };
});

if (asJson) {
  console.log(JSON.stringify(sessions, null, 2));
} else {
  for (const session of sessions) {
    console.log(`\n${session.id}  [${session.state}]  ${session.goal}`);
    console.log(`  duration=${session.durationMin}min  tasks=${session.done}/${session.tasks}  attempts=${session.totalAttempts}  agentRuns=${session.agentRuns}`);
    console.log(`  repairs=${session.repairTotal} (verification=${session.repairs.verification} preview=${session.repairs.preview} execution=${session.repairs.execution})  maxAttemptsPerFingerprint=${session.maxAttemptsPerFingerprint}`);
    console.log(`  verifications=${session.verificationRuns}  failuresByKind=${JSON.stringify(session.verificationFailuresByKind)}`);
    console.log(`  probes passed=${session.interactionProbes.passed} failed=${session.interactionProbes.failed} skipped=${session.interactionProbes.skipped}`);
    console.log(`  dispatchContext retry=${session.retryContextRuns}/${session.agentRuns} continuity=${session.continuityRuns}/${session.agentRuns}`);
    if (session.zeroAttemptNonManifestDone > 0) {
      console.log(`  !! zero-attempt non-manifest tasks marked done: ${session.zeroAttemptNonManifestDone}`);
    }
  }
  console.log(`\n${sessions.length} session(s).`);
}
