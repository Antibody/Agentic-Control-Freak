import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/server/config";
import { saveArtifact, saveBinaryArtifact } from "@/lib/server/artifacts";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { logProcess } from "@/lib/server/logging";
import { inspectPreview, type BrowserInspectionResult } from "@/lib/server/runtime/browser-harness";
import { registerWorkSessionOperation } from "@/lib/server/runtime/operation-registry";
import type { ArtifactRecord, Identifier, JsonObject, JsonValue, PreviewServerRecord, WorkSessionRecord } from "@/lib/shared/types";

export type SnapshotReason = "post_verification" | "manual_preview" | "repair_evidence";

export interface CapturePreviewSnapshotInput {
  workSessionId: Identifier;
  previewId: Identifier;
  verificationRunId?: Identifier | null;
  reason: SnapshotReason;
  signal?: AbortSignal;
}

export interface CapturePreviewSnapshotResult {
  snapshotId: Identifier;
  status: "captured" | "failed";
  preview: PreviewServerRecord | null;
  screenshotArtifact: ArtifactRecord | null;
  domArtifact: ArtifactRecord | null;
  reportArtifact: ArtifactRecord | null;
  inspection: BrowserInspectionResult | null;
  failureSummary: string | null;
}

const maxSnapshotJsonBytes = 256 * 1024;

function asJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trimEnd()}...` : normalized;
}

function redact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted-api-key>")
    .replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*["']?[^"'\s]+/gi, (match) => {
      const key = match.split(/[:=]/)[0] ?? "secret";
      return `${key}=<redacted>`;
    });
}

function sanitizeJsonValue(value: unknown, depth = 0): JsonValue {
  if (depth > 12) {
    return "[truncated-depth]";
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncate(redact(value), 4000);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 250).map((entry) => sanitizeJsonValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 250)
        .map(([key, entry]) => [key, sanitizeJsonValue(entry, depth + 1)])
    );
  }
  return truncate(String(value), 1000);
}

function sanitizeJsonObject(value: JsonObject): JsonObject {
  const sanitized = sanitizeJsonValue(value);
  return typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized) ? sanitized : {};
}

function stringifyBounded(value: JsonObject): string {
  const text = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, "utf8") <= maxSnapshotJsonBytes) {
    return text;
  }
  return JSON.stringify({
    schemaVersion: value.schemaVersion ?? 1,
    snapshotId: value.snapshotId ?? null,
    truncated: true,
    truncationReason: `Snapshot report exceeded ${maxSnapshotJsonBytes} bytes.`,
    page: value.page ?? null,
    browserSignals: value.browserSignals ?? null,
    artifacts: value.artifacts ?? null,
  }, null, 2);
}

function validatePreviewUrl(preview: PreviewServerRecord): void {
  const config = getConfig();
  if (preview.url.trim().length === 0) {
    throw new Error("Preview URL is empty.");
  }
  const url = new URL(preview.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Preview URL protocol is not allowed: ${url.protocol}`);
  }
  if (url.hostname !== config.previewHost) {
    throw new Error(`Preview URL host ${url.hostname} does not match configured preview host ${config.previewHost}.`);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < config.previewPortStart || port > config.previewPortEnd) {
    throw new Error(`Preview URL port ${url.port} is outside configured preview range ${config.previewPortStart}-${config.previewPortEnd}.`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  throw new Error("Operation aborted by user.");
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const removers: Array<() => void> = [];
  const abort = (source: AbortSignal): void => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };
  for (const signal of signals) {
    if (signal === undefined) {
      continue;
    }
    if (signal.aborted) {
      abort(signal);
      continue;
    }
    const listener = (): void => abort(signal);
    signal.addEventListener("abort", listener, { once: true });
    removers.push(() => signal.removeEventListener("abort", listener));
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const remove of removers) {
        remove();
      }
    },
  };
}

async function resolveCaptureTarget(input: CapturePreviewSnapshotInput): Promise<{ workSession: WorkSessionRecord; preview: PreviewServerRecord }> {
  const db = await getDatabaseSnapshot();
  const workSession = db.workSessions.find((candidate) => candidate.id === input.workSessionId);
  if (workSession === undefined) {
    throw new Error("Work session was not found for snapshot capture.");
  }
  const preview = db.previewServers.find((candidate) => candidate.id === input.previewId);
  if (preview === undefined) {
    throw new Error("Preview was not found for snapshot capture.");
  }
  if (preview.workSessionId !== workSession.id) {
    throw new Error("Preview does not belong to the requested work session.");
  }
  if (preview.status !== "ready") {
    throw new Error(`Preview is ${preview.status}; snapshot capture requires a ready preview.`);
  }
  validatePreviewUrl(preview);
  return { workSession, preview };
}

function bundle(input: {
  snapshotId: Identifier;
  workSession: WorkSessionRecord;
  preview: PreviewServerRecord;
  verificationRunId: Identifier | null;
  inspection: BrowserInspectionResult;
  screenshotArtifactId: Identifier | null;
  domArtifactId: Identifier | null;
  reportArtifactId: Identifier | null;
}): JsonObject {
  const bodyTextLength = typeof input.inspection.semanticDom.bodyTextLength === "number"
    ? input.inspection.semanticDom.bodyTextLength
    : input.inspection.bodyText.length;
  return asJsonObject({
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    workSessionId: input.workSession.id,
    previewId: input.preview.id,
    verificationRunId: input.verificationRunId,
    capturedAt: new Date().toISOString(),
    captureUrl: input.preview.url,
    previewStartedAt: input.preview.startedAt,
    viewport: {
      width: 1365,
      height: 768,
      deviceScaleFactor: 1,
      isMobile: false,
    },
    page: {
      title: truncate(redact(input.inspection.title), 300),
      href: input.inspection.url,
      documentWidth: input.inspection.semanticDom.documentWidth ?? null,
      documentHeight: input.inspection.semanticDom.documentHeight ?? null,
      bodyTextLength,
      bodyTextExcerpt: truncate(redact(input.inspection.bodyText), 4000),
    },
    dom: input.inspection.semanticDom,
    accessibility: input.inspection.axTree,
    browserSignals: {
      consoleErrors: input.inspection.consoleErrors.map((entry) => truncate(redact(entry), 1000)),
      consoleWarnings: input.inspection.consoleWarnings.map((entry) => truncate(redact(entry), 1000)),
      pageErrors: input.inspection.pageErrors.map((entry) => truncate(redact(entry), 1000)),
      requestFailures: input.inspection.networkErrors.map((entry) => truncate(redact(entry), 1000)),
      abortedRequests: input.inspection.abortedRequests.map((entry) => truncate(redact(entry), 1000)),
      badResponses: input.inspection.badResponses.map((entry) => truncate(redact(entry), 1000)),
      interactionProbes: input.inspection.interactionProbes,
      timing: input.inspection.timing,
    },
    artifacts: {
      screenshotArtifactId: input.screenshotArtifactId,
      domArtifactId: input.domArtifactId,
      reportArtifactId: input.reportArtifactId,
    },
  });
}

export async function capturePreviewSnapshot(input: CapturePreviewSnapshotInput): Promise<CapturePreviewSnapshotResult> {
  const snapshotId = randomUUID();
  let preview: PreviewServerRecord | null = null;
  const operation = registerWorkSessionOperation({
    workSessionId: input.workSessionId,
    kind: "snapshot",
    label: "Preview snapshot capture",
  });
  const combinedSignal = combineAbortSignals([input.signal, operation.signal]);
  const signal = combinedSignal.signal;
  logProcess("info", "snapshot.capture.requested", {
    snapshotId,
    workSessionId: input.workSessionId,
    previewId: input.previewId,
    verificationRunId: input.verificationRunId ?? null,
    reason: input.reason,
  });
  try {
    throwIfAborted(signal);
    const target = await resolveCaptureTarget(input);
    throwIfAborted(signal);
    preview = target.preview;
    logProcess("info", "snapshot.capture.target_resolved", {
      snapshotId,
      workSessionId: input.workSessionId,
      previewId: preview.id,
      url: preview.url,
      status: preview.status,
      appType: preview.appType,
    });
    await emitEvent({
      workSessionId: input.workSessionId,
      eventName: "snapshot.started",
      aggregateType: "preview_snapshot",
      aggregateId: snapshotId,
      payload: {
        previewId: preview.id,
        reason: input.reason,
        verificationRunId: input.verificationRunId ?? "",
      },
      producer: { module: "snapshot-capture" },
      context: { previewId: preview.id, snapshotId, verificationRunId: input.verificationRunId ?? undefined },
    });

    const config = getConfig();
    logProcess("info", "snapshot.browser.inspect.start", {
      snapshotId,
      previewId: preview.id,
      url: preview.url,
      timeoutMs: config.functionalCheckTimeoutMs,
      headless: config.browserHeadless,
      viewport: "1365x768",
    });
    const rawInspection = await inspectPreview({
      url: preview.url,
      timeoutMs: config.functionalCheckTimeoutMs,
      headless: config.browserHeadless,
      captureScreenshot: true,
      interactionProbeLevel: config.interactionProbeLevel,
      signal,
    });
    throwIfAborted(signal);
    logProcess("info", "snapshot.browser.inspect.completed", {
      snapshotId,
      previewId: preview.id,
      title: rawInspection.title,
      bodyTextLength: rawInspection.bodyText.length,
      consoleErrorCount: rawInspection.consoleErrors.length,
      consoleWarningCount: rawInspection.consoleWarnings.length,
      pageErrorCount: rawInspection.pageErrors.length,
      networkErrorCount: rawInspection.networkErrors.length,
      badResponseCount: rawInspection.badResponses.length,
      screenshotBytes: rawInspection.screenshot?.byteLength ?? 0,
    });
    const inspection: BrowserInspectionResult = {
      ...rawInspection,
      title: truncate(redact(rawInspection.title), 300),
      bodyText: truncate(redact(rawInspection.bodyText), 4000),
      axTree: sanitizeJsonValue(rawInspection.axTree),
      semanticDom: sanitizeJsonObject(rawInspection.semanticDom),
      consoleErrors: rawInspection.consoleErrors.map((entry) => truncate(redact(entry), 1000)),
      consoleWarnings: rawInspection.consoleWarnings.map((entry) => truncate(redact(entry), 1000)),
      pageErrors: rawInspection.pageErrors.map((entry) => truncate(redact(entry), 1000)),
      networkErrors: rawInspection.networkErrors.map((entry) => truncate(redact(entry), 1000)),
      badResponses: rawInspection.badResponses.map((entry) => truncate(redact(entry), 1000)),
      interactionProbes: rawInspection.interactionProbes.map(sanitizeJsonObject),
    };

    throwIfAborted(signal);
    const screenshotArtifact = inspection.screenshot === null
      ? null
      : await saveBinaryArtifact({
          workSessionId: input.workSessionId,
          kind: "screenshot",
          fileName: `snapshot-${snapshotId}.png`,
          bytes: inspection.screenshot,
          metadata: {
            contentType: "image/png",
            snapshotId,
            previewId: preview.id,
            verificationRunId: input.verificationRunId ?? null,
            reason: input.reason,
          },
        });
    logProcess(screenshotArtifact === null ? "warn" : "info", "snapshot.screenshot.persisted", {
      snapshotId,
      previewId: preview.id,
      artifactId: screenshotArtifact?.id ?? null,
      bytes: inspection.screenshot?.byteLength ?? 0,
    });
    throwIfAborted(signal);
    if (screenshotArtifact !== null) {
      await emitEvent({
        workSessionId: input.workSessionId,
        eventName: "snapshot.screenshot.captured",
        aggregateType: "preview_snapshot",
        aggregateId: snapshotId,
        payload: {
          previewId: preview.id,
          screenshotArtifactId: screenshotArtifact.id,
        },
        producer: { module: "snapshot-capture" },
        context: { previewId: preview.id, snapshotId, verificationRunId: input.verificationRunId ?? undefined },
      });
    }

    throwIfAborted(signal);
    const domArtifact = await saveArtifact({
      workSessionId: input.workSessionId,
      kind: "report",
      fileName: `snapshot-dom-${snapshotId}.json`,
      content: stringifyBounded(asJsonObject({
        schemaVersion: 1,
        snapshotId,
        semanticDom: inspection.semanticDom,
        accessibility: inspection.axTree,
      })),
      metadata: {
        contentType: "application/json; charset=utf-8",
        snapshotId,
        previewId: preview.id,
        verificationRunId: input.verificationRunId ?? null,
        artifactRole: "semantic-dom-snapshot",
      },
    });
    throwIfAborted(signal);
    logProcess("info", "snapshot.dom.persisted", {
      snapshotId,
      previewId: preview.id,
      artifactId: domArtifact.id,
    });
    await emitEvent({
      workSessionId: input.workSessionId,
      eventName: "snapshot.dom.captured",
      aggregateType: "preview_snapshot",
      aggregateId: snapshotId,
      payload: {
        previewId: preview.id,
        domArtifactId: domArtifact.id,
      },
      producer: { module: "snapshot-capture" },
      context: { previewId: preview.id, snapshotId, verificationRunId: input.verificationRunId ?? undefined },
    });

    const provisionalBundle = bundle({
      snapshotId,
      workSession: target.workSession,
      preview,
      verificationRunId: input.verificationRunId ?? null,
      inspection,
      screenshotArtifactId: screenshotArtifact?.id ?? null,
      domArtifactId: domArtifact.id,
      reportArtifactId: null,
    });
    const reportArtifact = await saveArtifact({
      workSessionId: input.workSessionId,
      kind: "report",
      fileName: `snapshot-report-${snapshotId}.json`,
      content: stringifyBounded(provisionalBundle),
      metadata: {
        contentType: "application/json; charset=utf-8",
        snapshotId,
        previewId: preview.id,
        verificationRunId: input.verificationRunId ?? null,
        artifactRole: "snapshot-bundle",
      },
    });
    throwIfAborted(signal);
    logProcess("info", "snapshot.report.persisted", {
      snapshotId,
      previewId: preview.id,
      artifactId: reportArtifact.id,
    });

    await emitEvent({
      workSessionId: input.workSessionId,
      eventName: "snapshot.completed",
      aggregateType: "preview_snapshot",
      aggregateId: snapshotId,
      payload: {
        previewId: preview.id,
        status: "captured",
        screenshotArtifactId: screenshotArtifact?.id ?? "",
        domArtifactId: domArtifact.id,
        reportArtifactId: reportArtifact.id,
        viewport: "1365x768",
        consoleErrorCount: inspection.consoleErrors.length,
        pageErrorCount: inspection.pageErrors.length,
        networkFailureCount: inspection.networkErrors.length,
      },
      producer: { module: "snapshot-capture" },
      context: { previewId: preview.id, snapshotId, verificationRunId: input.verificationRunId ?? undefined },
    });
    if (input.verificationRunId !== undefined && input.verificationRunId !== null) {
      await emitEvent({
        workSessionId: input.workSessionId,
        eventName: "snapshot.attached_to_verification",
        aggregateType: "verification_run",
        aggregateId: input.verificationRunId,
        payload: {
          previewId: preview.id,
          snapshotId,
          reportArtifactId: reportArtifact.id,
          screenshotArtifactId: screenshotArtifact?.id ?? "",
          domArtifactId: domArtifact.id,
        },
        producer: { module: "snapshot-capture" },
        context: { previewId: preview.id, snapshotId, verificationRunId: input.verificationRunId },
      });
    }

    logProcess("info", "snapshot.capture.completed", {
      snapshotId,
      previewId: preview.id,
      screenshotArtifactId: screenshotArtifact?.id ?? null,
      domArtifactId: domArtifact.id,
      reportArtifactId: reportArtifact.id,
      consoleErrorCount: inspection.consoleErrors.length,
      pageErrorCount: inspection.pageErrors.length,
      networkFailureCount: inspection.networkErrors.length,
    });
    return {
      snapshotId,
      status: "captured",
      preview,
      screenshotArtifact,
      domArtifact,
      reportArtifact,
      inspection,
      failureSummary: null,
    };
  } catch (error) {
    throwIfAborted(signal);
    const message = error instanceof Error ? error.message : "Unknown snapshot capture failure.";
    logProcess("error", "snapshot.capture.failed", {
      snapshotId,
      workSessionId: input.workSessionId,
      previewId: preview?.id ?? input.previewId,
      reason: input.reason,
      message,
    });
    await emitEvent({
      workSessionId: input.workSessionId,
      eventName: "snapshot.failed",
      aggregateType: "preview_snapshot",
      aggregateId: snapshotId,
      payload: {
        previewId: preview?.id ?? input.previewId,
        status: "failed",
        reason: input.reason,
        failureSummary: message,
      },
      priority: "high",
      producer: { module: "snapshot-capture" },
      context: { previewId: preview?.id ?? input.previewId, snapshotId, verificationRunId: input.verificationRunId ?? undefined },
    });
    return {
      snapshotId,
      status: "failed",
      preview,
      screenshotArtifact: null,
      domArtifact: null,
      reportArtifact: null,
      inspection: null,
      failureSummary: message,
    };
  } finally {
    combinedSignal.cleanup();
    operation.unregister();
  }
}
