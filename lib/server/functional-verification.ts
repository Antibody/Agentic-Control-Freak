import { readdir } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { analyzeWorkspace } from "@/lib/server/workspace-analysis";
import { capturePreviewSnapshot, type CapturePreviewSnapshotResult } from "@/lib/server/snapshot-capture";
import { stackCapabilities } from "@/lib/shared/stack-capabilities";
import type { VerificationCheck } from "@/lib/server/verification";
import type {
  CheckSpec,
  FunctionalCheckResult,
  Identifier,
  JsonObject,
  PreviewServerRecord,
  WorkSessionRecord,
} from "@/lib/shared/types";

export interface FunctionalVerificationResult {
  status: "passed" | "failed" | "skipped";
  failureKind: "none" | "functional_failure" | "environment_failure";
  summary: string;
  rawOutput: string;
  checks: VerificationCheck[];
  results: FunctionalCheckResult[];
}

function isRuntimeWebStack(appType: PreviewServerRecord["appType"]): boolean {
  return stackCapabilities(appType).supportsBrowserSnapshot;
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

function routeDisplayName(route: string): string {
  if (route === "/") return "home";
  return route.replace(/^\//, "").replace(/[-_/]+/g, " ").trim() || route;
}

function normalizeHref(value: string): string {
  try {
    return new URL(value, "http://localhost").pathname.replace(/\/+$/, "") || "/";
  } catch {
    return value.replace(/\/+$/, "") || "/";
  }
}

function routePatternRegex(route: string): RegExp | null {
  if (!route.includes("[")) {
    return null;
  }
  const pattern = route
    .split("/")
    .map((segment) => {
      if (/^\[\[?\.\.\..*\]\]?$/.test(segment)) {
        return ".+";
      }
      if (segment.startsWith("[") && segment.endsWith("]")) {
        return "[^/]+";
      }
      return segment.replace(/[.*+?^=!:${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return new RegExp(`^${pattern}$`);
}

function detectedAncestorRoutes(route: string, routes: string[]): string[] {
  const segments = route.split("/").filter((segment) => segment.length > 0);
  const ancestors: string[] = [];
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const ancestor = `/${segments.slice(0, depth).join("/")}`;
    if (routes.includes(ancestor)) {
      ancestors.push(ancestor);
    }
  }
  return ancestors;
}

function structuralSpecs(routes: string[]): CheckSpec[] {
  return [
    ...routes.map((route) => ({
      id: `runtime-route:${route}`,
      criterion: `Route ${route} renders non-empty visible content.`,
      kind: "structural" as const,
      locator: { text: route },
      expect: { exists: true, visible: true },
      createdBy: "orchestrator" as const,
      locked: true,
    })),
    ...routes
      .filter((route) => route !== "/")
      .map((route) => {
        const ancestors = detectedAncestorRoutes(route, routes);
        const ancestorClause = ancestors.length > 0 ? ` or to its section page (${ancestors.join(", ")})` : "";
        return {
          id: `runtime-nav-link:${route}`,
          criterion: route.includes("[")
            ? `Root page renders at least one navigable link matching the route pattern ${route}${ancestorClause} (any concrete instance counts).`
            : `Root page renders a navigable link to ${route}${ancestorClause}.`,
          kind: "structural" as const,
          locator: { role: "link", name: routeDisplayName(route) },
          expect: { exists: true, visible: true },
          createdBy: "orchestrator" as const,
          locked: true,
        };
      }),
  ];
}

const templateExtensions = new Set([".ejs", ".pug", ".hbs", ".njk", ".mustache", ".liquid", ".erb", ".cshtml", ".jinja", ".j2"]);
const templateDirNames = new Set(["views", "templates", "partials"]);
const skippedScanDirs = new Set(["node_modules", ".git", ".next", ".orchestrator", "dist", "build", "out", "coverage", "vendor", "storage", "tmp"]);

async function countServerViewTemplates(workspacePath: string): Promise<number> {
  let count = 0;
  async function walk(dirAbs: string, underTemplateDir: boolean, depth: number): Promise<void> {
    if (depth > 6 || count > 50) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skippedScanDirs.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(path.join(dirAbs, entry.name), underTemplateDir || templateDirNames.has(entry.name.toLowerCase()), depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (templateExtensions.has(ext) || entry.name.toLowerCase().endsWith(".blade.php") || (underTemplateDir && ext === ".html")) {
          count += 1;
        }
      }
    }
  }
  await walk(workspacePath, false, 0);
  return count;
}

const interactiveRoles = new Set(["link", "button", "textbox", "combobox", "checkbox", "radio", "searchbox", "menuitem", "tab"]);
const interactiveTags = new Set(["a", "form", "button", "input", "select", "textarea"]);

function controls(dom: JsonObject): Array<Record<string, unknown>> {
  const entries = dom.controls;
  if (!Array.isArray(entries)) {
    return [];
  }
  return (entries as unknown[]).filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function linkMatchesRoute(link: Record<string, unknown>, route: string): boolean {
  const href = typeof link.href === "string" ? normalizeHref(link.href) : "";
  const patternRegex = routePatternRegex(route);
  if (patternRegex !== null) {
    return href.length > 0 && patternRegex.test(href);
  }
  const text = `${typeof link.label === "string" ? link.label : ""} ${typeof link.text === "string" ? link.text : ""}`.toLowerCase();
  const routeLabel = routeDisplayName(route).toLowerCase();
  return href === normalizeHref(route) || (route !== "/" && text.includes(routeLabel));
}

function checkForResult(result: FunctionalCheckResult): VerificationCheck {
  return {
    phase: "structural",
    status: result.status,
    failureKind: result.status === "failed" ? "functional_failure" : "none",
    message: result.note,
  };
}

function interactionProbeChecks(input: {
  probes: JsonObject[];
  domArtifactId?: Identifier;
  screenshotArtifactId?: Identifier;
}): { specs: CheckSpec[]; results: FunctionalCheckResult[] } {
  const specs: CheckSpec[] = [];
  const results: FunctionalCheckResult[] = [];
  input.probes.forEach((probe, index) => {
    const kind = typeof probe.kind === "string" ? probe.kind : "interaction";
    const route = typeof probe.route === "string" && probe.route.length > 0 ? probe.route : "/";
    const status = probe.status === "passed" || probe.status === "failed" || probe.status === "skipped"
      ? probe.status
      : "skipped";
    const label = typeof probe.label === "string" ? probe.label : "";
    const note = typeof probe.note === "string" ? probe.note : "";
    const criterion = kind === "form-submit-empty"
      ? `Submitting the ${label.length > 0 ? `"${label}" ` : ""}form on ${route} with empty fields is handled gracefully (no uncaught errors, no 5xx).`
      : kind === "form-submit"
        ? `Submitting the filled ${label.length > 0 ? `"${label}" ` : ""}form on ${route} completes without browser failures.`
        : kind === "link-navigation"
          ? `The link to ${route} rendered by the app resolves to a working page (no 404, no server error).`
          : kind === "hydration"
            ? `The client framework hydrates the page at ${route} so interactive handlers actually run.`
            : `A safe interaction on ${route} completes without browser failures.`;
    const spec: CheckSpec = {
      id: `runtime-interaction:${route}:${kind}:${index}`,
      criterion,
      kind: "interaction",
      locator: { text: label.length > 0 ? label : route },
      action: { type: "click" },
      expect: { domDelta: true },
      createdBy: "orchestrator",
      locked: true,
    };
    specs.push(spec);
    results.push({
      specId: spec.id,
      status,
      observed: probe,
      domArtifactId: input.domArtifactId,
      screenshotArtifactId: input.screenshotArtifactId,
      consoleErrors: [],
      note: note.length > 0 ? note : criterion,
    });
  });
  return { specs, results };
}

interface FrameBlockingHeaders {
  xFrameOptions: string | null;
  frameAncestors: string | null;
  blocked: boolean;
}

async function fetchFrameBlockingHeaders(url: string): Promise<FrameBlockingHeaders | null> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const xFrameOptions = response.headers.get("x-frame-options");
    const csp = response.headers.get("content-security-policy") ?? "";
    const frameAncestors = /frame-ancestors\s+([^;]+)/i.exec(csp)?.[1]?.trim() ?? null;
    const cspBlocks = frameAncestors !== null && !/(^|\s)(\*|http:\/\/127\.0\.0\.1\S*|http:\/\/localhost\S*)(\s|$)/i.test(frameAncestors);
    return { xFrameOptions, frameAncestors, blocked: xFrameOptions !== null || cspBlocks };
  } catch {
    return null;
  }
}

const seededDataRequestPattern = /\bseed(?:ed|ing|s)?\b|\bsample data\b|\bdemo data\b|\bstarter data\b|\bpre-?populat|\bfixtures?\b/i;

const frameworkTablePrefixes = ["django_", "auth_", "sqlite_", "alembic_", "spatial_", "knex_", "sequelize"];

const sqliteScanSkipDirs = new Set([".venv", "node_modules", ".orchestrator", ".git", "__pycache__", ".next", "dist", "build"]);

interface SqliteSeedScan {
  databaseFiles: string[];
  userTables: Array<{ table: string; rows: number }>;
}

async function scanSqliteSeedState(workspacePath: string): Promise<SqliteSeedScan | null> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return null;
  }
  const candidates: string[] = [];
  try {
    const rootEntries = await readdir(workspacePath, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile() && /\.(?:sqlite3?|db)$/i.test(entry.name)) {
        candidates.push(path.join(workspacePath, entry.name));
      } else if (entry.isDirectory() && !sqliteScanSkipDirs.has(entry.name) && !entry.name.startsWith(".")) {
        const nested = await readdir(path.join(workspacePath, entry.name), { withFileTypes: true }).catch(() => []);
        for (const child of nested) {
          if (child.isFile() && /\.(?:sqlite3?|db)$/i.test(child.name)) {
            candidates.push(path.join(workspacePath, entry.name, child.name));
          }
        }
      }
    }
  } catch {
    return null;
  }
  const databaseFiles: string[] = [];
  const userTables: Array<{ table: string; rows: number }> = [];
  for (const file of candidates) {
    try {
      const db = new sqlite.DatabaseSync(file, { readOnly: true });
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
        const appTables = tables
          .map((row) => row.name)
          .filter((name) => !frameworkTablePrefixes.some((prefix) => name.toLowerCase().startsWith(prefix)));
        if (appTables.length > 0) {
          databaseFiles.push(path.basename(file));
        }
        for (const table of appTables) {
          const counted = db.prepare(`SELECT COUNT(*) AS count FROM "${table.replace(/"/g, '""')}"`).get() as { count: number };
          userTables.push({ table, rows: Number(counted.count) });
        }
      } finally {
        db.close();
      }
    } catch {
      continue;
    }
  }
  return userTables.length > 0 ? { databaseFiles, userTables } : null;
}

function result(input: {
  spec: CheckSpec;
  passed: boolean;
  note: string;
  observed: JsonObject;
  domArtifactId?: Identifier;
  screenshotArtifactId?: Identifier;
  consoleErrors: string[];
}): FunctionalCheckResult {
  return {
    specId: input.spec.id,
    status: input.passed ? "passed" : "failed",
    observed: input.observed,
    domArtifactId: input.domArtifactId,
    screenshotArtifactId: input.screenshotArtifactId,
    consoleErrors: input.consoleErrors,
    note: input.note,
  };
}

export async function runFunctionalVerification(input: {
  workSession: WorkSessionRecord;
  preview: PreviewServerRecord | null;
  verificationRunId: Identifier;
  capture?: CapturePreviewSnapshotResult | null;
  forceEnabled?: boolean;
  signal?: AbortSignal;
}): Promise<FunctionalVerificationResult> {
  throwIfAborted(input.signal);
  const config = getConfig();
  if (!config.functionalVerificationEnabled && input.forceEnabled !== true) {
    return {
      status: "skipped",
      failureKind: "none",
      summary: "Runtime DOM/AX structural verification is disabled.",
      rawOutput: "Runtime DOM/AX structural verification is disabled by FUNCTIONAL_VERIFICATION_ENABLED=false.",
      checks: [{
        phase: "structural",
        status: "skipped",
        failureKind: "none",
        message: "Runtime DOM/AX structural verification is disabled.",
      }],
      results: [],
    };
  }

  const preview = input.preview;
  if (preview === null || preview.status !== "ready" || preview.url.trim().length === 0) {
    return {
      status: "failed",
      failureKind: "environment_failure",
      summary: "Runtime DOM/AX structural verification could not run because no ready preview was available.",
      rawOutput: "No ready preview was available for Playwright inspection.",
      checks: [{
        phase: "structural",
        status: "failed",
        failureKind: "environment_failure",
        message: "No ready preview was available for runtime DOM/AX structural verification.",
      }],
      results: [],
    };
  }

  if (!isRuntimeWebStack(preview.appType)) {
    return {
      status: "skipped",
      failureKind: "none",
      summary: `Runtime DOM/AX structural verification is not applicable to ${preview.appType}.`,
      rawOutput: `Preview app type ${preview.appType} is not a web DOM target.`,
      checks: [{
        phase: "structural",
        status: "skipped",
        failureKind: "none",
        message: `Runtime DOM/AX structural verification is not applicable to ${preview.appType}.`,
      }],
      results: [],
    };
  }

  throwIfAborted(input.signal);
  const capture = input.capture ?? await capturePreviewSnapshot({
    workSessionId: input.workSession.id,
    previewId: preview.id,
    verificationRunId: input.verificationRunId,
    reason: "post_verification",
    signal: input.signal,
  });
  throwIfAborted(input.signal);
  if (capture.status === "failed" || capture.inspection === null) {
    return {
      status: "failed",
      failureKind: "environment_failure",
      summary: capture.failureSummary ?? "Runtime DOM/AX snapshot capture failed.",
      rawOutput: capture.failureSummary ?? "Runtime DOM/AX snapshot capture failed.",
      checks: [{
        phase: "structural",
        status: "failed",
        failureKind: "environment_failure",
        message: capture.failureSummary ?? "Runtime DOM/AX snapshot capture failed.",
      }],
      results: [],
    };
  }

  throwIfAborted(input.signal);
  const analysis = await analyzeWorkspace(input.workSession.activeWorktreePath, config.verifyCommands);
  throwIfAborted(input.signal);
  const routes = analysis.detectedRoutes.length > 0 ? analysis.detectedRoutes : ["/"];
  const specs = structuralSpecs(routes);
  const inspection = capture.inspection;
  const dom = inspection.semanticDom;
  const textLength = typeof dom.bodyTextLength === "number" ? dom.bodyTextLength : inspection.bodyText.length;
  const signalCounts = config.interactionProbeLevel === "extended"
    ? inspection.preProbeSignals
    : {
        consoleErrors: inspection.consoleErrors.length,
        pageErrors: inspection.pageErrors.length,
        networkErrors: inspection.networkErrors.length,
        badResponses: inspection.badResponses.length,
      };
  const signalFailures = signalCounts.consoleErrors + signalCounts.pageErrors + signalCounts.networkErrors + signalCounts.badResponses;
  const routeSpec = specs.find((spec) => spec.id === "runtime-route:/") ?? specs[0];
  const routeResult = result({
    spec: routeSpec,
    passed: textLength > 0 && signalFailures === 0,
    note: textLength > 0 && signalFailures === 0
      ? `Runtime root route rendered ${textLength} visible text characters without browser errors.`
      : `Runtime root route had rendered-output issues. textLength=${textLength}; browserSignalFailures=${signalFailures}.`,
    observed: {
      route: "/",
      textLength,
      title: inspection.title,
      consoleErrors: inspection.consoleErrors,
      pageErrors: inspection.pageErrors,
      networkErrors: inspection.networkErrors,
      badResponses: inspection.badResponses,
      interactionProbes: inspection.interactionProbes,
    },
    domArtifactId: capture.domArtifact?.id,
    screenshotArtifactId: capture.screenshotArtifact?.id,
    consoleErrors: inspection.consoleErrors,
  });

  const rootLinks = controls(dom).filter((control) => control.role === "link" || control.tag === "a");
  const navResults = routes
    .filter((route) => route !== "/")
    .map((route) => {
      const spec = specs.find((candidate) => candidate.id === `runtime-nav-link:${route}`)!;
      const matching = rootLinks.find((link) => linkMatchesRoute(link, route));
      const ancestors = detectedAncestorRoutes(route, routes);
      const linkedAncestor = matching === undefined
        ? ancestors.find((ancestor) => rootLinks.some((link) => linkMatchesRoute(link, ancestor)))
        : undefined;
      return result({
        spec,
        passed: matching !== undefined || linkedAncestor !== undefined,
        note: matching !== undefined
          ? `Root page rendered a navigable link to ${route}.`
          : linkedAncestor !== undefined
            ? `Root page links to section page ${linkedAncestor}, which owns navigation to ${route}.`
            : ancestors.length > 0
              ? `Root page did not render a navigable link to ${route} or to its section page (${ancestors.join(", ")}). Link the section entry page from the root; do not add deep post-action pages to the global nav.`
              : `Root page did not render a navigable link to ${route}.`,
        observed: {
          route,
          renderedLinks: rootLinks.map((link) => ({
            label: typeof link.label === "string" ? link.label : "",
            href: typeof link.href === "string" ? link.href : "",
            visible: link.visible === true,
          })),
        },
        domArtifactId: capture.domArtifact?.id,
        screenshotArtifactId: capture.screenshotArtifact?.id,
        consoleErrors: inspection.consoleErrors,
      });
    });

  const allControls = controls(dom);
  const interactiveControls = allControls.filter((control) => {
    const role = typeof control.role === "string" ? control.role.toLowerCase() : "";
    const tag = typeof control.tag === "string" ? control.tag.toLowerCase() : "";
    return interactiveRoles.has(role) || interactiveTags.has(tag);
  });
  const templateCount = await countServerViewTemplates(input.workSession.activeWorktreePath);
  const interactivityResults: FunctionalCheckResult[] = [];
  if (templateCount >= 2) {
    const interactivitySpec: CheckSpec = {
      id: "runtime-home-interactivity",
      criterion: `The app declares ${templateCount} server view templates, so the rendered home page must expose at least one link, form, or control.`,
      kind: "structural",
      locator: { text: "home page interactive controls" },
      expect: { exists: true, visible: true },
      createdBy: "orchestrator",
      locked: true,
    };
    specs.push(interactivitySpec);
    interactivityResults.push(result({
      spec: interactivitySpec,
      passed: interactiveControls.length > 0,
      note: interactiveControls.length > 0
        ? `Home page exposes ${interactiveControls.length} interactive control(s) for an app with ${templateCount} view templates.`
        : `Home page renders no links, forms, or controls although the app declares ${templateCount} server view templates. The home route is likely stubbed or shadowed (check for a leftover root index.html served by static middleware mounted before the routers).`,
      observed: {
        templateCount,
        interactiveControlCount: interactiveControls.length,
        totalControlCount: allControls.length,
        title: inspection.title,
        textLength,
      },
      domArtifactId: capture.domArtifact?.id,
      screenshotArtifactId: capture.screenshotArtifact?.id,
      consoleErrors: inspection.consoleErrors,
    }));
  }

  const embedResults: FunctionalCheckResult[] = [];
  const frameHeaders = await fetchFrameBlockingHeaders(preview.url);
  if (frameHeaders !== null) {
    const embedSpec: CheckSpec = {
      id: "runtime-embeddable",
      criterion: "Root response sends no frame-blocking headers (X-Frame-Options or a CSP frame-ancestors that excludes loopback); the orchestrator preview embeds the app in a cross-origin loopback iframe.",
      kind: "structural",
      locator: { text: "root response headers" },
      expect: { exists: true, visible: true },
      createdBy: "orchestrator",
      locked: true,
    };
    specs.push(embedSpec);
    embedResults.push(result({
      spec: embedSpec,
      passed: !frameHeaders.blocked,
      note: frameHeaders.blocked
        ? `Root response sends ${frameHeaders.xFrameOptions !== null ? `X-Frame-Options: ${frameHeaders.xFrameOptions}` : `Content-Security-Policy frame-ancestors ${frameHeaders.frameAncestors}`}, which blanks the embedded preview iframe (the preview pane loads the app from a different loopback origin, so even SAMEORIGIN blocks it). Remove the frame-blocking header from this local app: in Django remove django.middleware.clickjacking.XFrameOptionsMiddleware from MIDDLEWARE; with Express/helmet disable frameguard and any frame-ancestors directive; otherwise drop the header where the response middleware adds it.`
        : "Root response sends no frame-blocking headers.",
      observed: { xFrameOptions: frameHeaders.xFrameOptions, frameAncestors: frameHeaders.frameAncestors },
      domArtifactId: capture.domArtifact?.id,
      screenshotArtifactId: capture.screenshotArtifact?.id,
      consoleErrors: inspection.consoleErrors,
    }));
  }

  const seedResults: FunctionalCheckResult[] = [];
  if (seededDataRequestPattern.test(input.workSession.lastUserMessage ?? "")) {
    const seedScan = await scanSqliteSeedState(input.workSession.activeWorktreePath);
    if (seedScan !== null) {
      const totalRows = seedScan.userTables.reduce((sum, entry) => sum + entry.rows, 0);
      const seedSpec: CheckSpec = {
        id: "runtime-seeded-data",
        criterion: "The request demands seeded/sample data, so the app's user tables must contain rows after first boot — data loads automatically and idempotently during startup, not via a separately documented manual command.",
        kind: "structural",
        locator: { text: "persistence layer row counts" },
        expect: { exists: true, visible: true },
        createdBy: "orchestrator",
        locked: true,
      };
      specs.push(seedSpec);
      seedResults.push(result({
        spec: seedSpec,
        passed: totalRows > 0,
        note: totalRows > 0
          ? `Seed data present after boot: ${totalRows} row(s) across ${seedScan.userTables.length} user table(s) in ${seedScan.databaseFiles.join(", ")}.`
          : `The request demands seeded data but every user table is empty after the preview booted (${seedScan.userTables.map((entry) => entry.table).join(", ")} in ${seedScan.databaseFiles.join(", ")}). Wire seeding into a mechanism that provably runs during the boot command — an AppConfig.ready guard or post_migrate signal, not a manual command. Beware dead wiring: a custom Django runserver command is overridden by any app listed earlier in INSTALLED_APPS (django.contrib.staticfiles also overrides runserver). Boot the server once and confirm the data exists before completing.`,
        observed: { databaseFiles: seedScan.databaseFiles, tables: seedScan.userTables },
        domArtifactId: capture.domArtifact?.id,
        screenshotArtifactId: capture.screenshotArtifact?.id,
        consoleErrors: inspection.consoleErrors,
      }));
    }
  }

  const probePromotion = config.interactionProbeLevel === "extended"
    ? interactionProbeChecks({
        probes: inspection.interactionProbes.filter((probe): probe is JsonObject => typeof probe === "object" && probe !== null && !Array.isArray(probe)),
        domArtifactId: capture.domArtifact?.id,
        screenshotArtifactId: capture.screenshotArtifact?.id,
      })
    : { specs: [], results: [] };
  const results = [routeResult, ...navResults, ...interactivityResults, ...embedResults, ...seedResults, ...probePromotion.results];
  const checks = results.map(checkForResult);
  const failed = results.some((entry) => entry.status === "failed");
  const failedProbeCount = probePromotion.results.filter((entry) => entry.status === "failed").length;
  const skippedProbeCount = probePromotion.results.filter((entry) => entry.status === "skipped").length;
  const failedStructuralCount = results.filter((entry) => entry.status === "failed").length - failedProbeCount;
  const probeSummary = failedProbeCount > 0
    ? ` ${failedProbeCount} interaction probe${failedProbeCount === 1 ? "" : "s"} failed (see probe records in the raw output).`
    : skippedProbeCount > 0
      ? ` ${skippedProbeCount} interaction probe${skippedProbeCount === 1 ? " was" : "s were"} skipped.`
      : "";
  const failureDigest = results
    .filter((entry) => entry.status === "failed")
    .map((entry) => {
      const observed = (entry.observed ?? {}) as Record<string, unknown>;
      const extras: string[] = [];
      if (typeof observed.kind === "string") extras.push(`kind=${observed.kind}`);
      if (typeof observed.route === "string") extras.push(`route=${observed.route}`);
      if (typeof observed.httpStatus === "number") extras.push(`http=${observed.httpStatus}`);
      if (typeof observed.label === "string" && observed.label.length > 0) extras.push(`form="${String(observed.label).slice(0, 80)}"`);
      for (const key of ["networkErrors", "serverErrorResponses", "pageErrors", "badResponses"]) {
        const value = observed[key];
        if (Array.isArray(value) && value.length > 0) {
          extras.push(`${key}=${JSON.stringify(value).slice(0, 300)}`);
        }
      }
      return `- ${entry.specId}${extras.length > 0 ? ` (${extras.join(" ")})` : ""}: ${entry.note}`;
    })
    .join("\n");
  return {
    status: failed ? "failed" : "passed",
    failureKind: failed ? "functional_failure" : "none",
    summary: failed
      ? `${failedStructuralCount > 0
          ? `Runtime DOM/AX structural verification found ${failedStructuralCount} rendered-output issue${failedStructuralCount === 1 ? "" : "s"}. See snapshot artifacts.`
          : "Runtime DOM/AX structural verification passed."}${probeSummary}`
      : `Runtime DOM/AX structural verification passed.${probeSummary}`,
    rawOutput: JSON.stringify({
      snapshotId: capture.snapshotId,
      reportArtifactId: capture.reportArtifact?.id ?? null,
      screenshotArtifactId: capture.screenshotArtifact?.id ?? null,
      domArtifactId: capture.domArtifact?.id ?? null,
      specs: [...specs, ...probePromotion.specs],
      results,
    }, null, 2) + (failureDigest.length > 0 ? `\n\nFAILED CHECKS (repair digest; full records in the JSON above):\n${failureDigest}` : ""),
    checks,
    results,
  };
}
