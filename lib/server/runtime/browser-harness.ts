import type { JsonObject, JsonValue } from "@/lib/shared/types";
import { logProcess } from "@/lib/server/logging";

export interface RenderedElementSummary {
  role: string;
  name: string;
  text: string;
  href?: string;
  visible: boolean;
  box: { x: number; y: number; width: number; height: number } | null;
}

export interface BrowserInspectionResult {
  url: string;
  title: string;
  bodyText: string;
  axTree: JsonValue;
  semanticDom: JsonObject;
  interactionProbes: JsonObject[];
  preProbeSignals: { consoleErrors: number; pageErrors: number; networkErrors: number; badResponses: number };
  geometry: JsonObject;
  consoleErrors: string[];
  consoleWarnings: string[];
  pageErrors: string[];
  networkErrors: string[];
  abortedRequests: string[];
  badResponses: string[];
  timing: JsonObject;
  screenshot: Buffer | null;
}

interface BrowserRequest {
  method(): string;
  url(): string;
  resourceType(): string;
  failure(): { errorText: string } | null;
}

interface BrowserRoute {
  request(): BrowserRequest;
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

interface BrowserConsoleMessage {
  type(): string;
  text(): string;
}

interface BrowserResponse {
  status(): number;
  url(): string;
  request(): BrowserRequest;
}

interface BrowserPage {
  route(pattern: string, handler: (route: BrowserRoute) => void): Promise<void>;
  on(event: "console", handler: (message: BrowserConsoleMessage) => void): void;
  on(event: "pageerror", handler: (error: Error) => void): void;
  on(event: "requestfailed", handler: (request: BrowserRequest) => void): void;
  on(event: "response", handler: (response: BrowserResponse) => void): void;
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  waitForLoadState(state: "networkidle", options: { timeout: number }): Promise<void>;
  waitForTimeout(timeoutMs: number): Promise<void>;
  evaluate<T>(callback: () => T): Promise<T>;
  evaluate<T, A>(callback: (arg: A) => T, arg: A): Promise<T>;
  screenshot(options: { fullPage: false; type: "png" }): Promise<Buffer>;
  locator(selector: string): { ariaSnapshot?: () => Promise<unknown> };
}

interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

interface Browser {
  newContext(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
    ignoreHTTPSErrors: boolean;
  }): Promise<BrowserContext>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: {
    launch(options: { headless: boolean }): Promise<Browser>;
  };
}

async function loadPlaywright(): Promise<PlaywrightModule> {
  const packageName = "playwright";
  try {
    logProcess("info", "browser_harness.playwright.load.start");
    const playwrightModule = await import(packageName) as PlaywrightModule;
    logProcess("info", "browser_harness.playwright.load.completed");
    return playwrightModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown module load error";
    throw new Error(`Playwright is required for snapshot capture but is not installed or could not be loaded: ${message}`);
  }
}

function assertLocalPreviewUrl(url: string): void {
  const parsed = new URL(url);
  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error(`Browser harness only accepts localhost preview URLs; got ${parsed.hostname}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Browser harness only accepts http(s) preview URLs; got ${parsed.protocol}.`);
  }
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, jsonValue(entry)]));
  }
  return String(value);
}

function signalDelta(values: string[], startIndex: number): string[] {
  return values.slice(startIndex).slice(0, 20);
}

async function runBasicInteractionProbe(input: {
  page: BrowserPage;
  url: string;
  timeoutMs: number;
  badResponses: string[];
  networkErrors: string[];
  pageErrors: string[];
  signal?: AbortSignal;
}): Promise<JsonObject> {
  const beforeSignals = {
    badResponses: input.badResponses.length,
    networkErrors: input.networkErrors.length,
    pageErrors: input.pageErrors.length,
  };
  let candidate: JsonObject | null = null;

  try {
    throwIfAborted(input.signal);
    await input.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
    await input.page.waitForLoadState("networkidle", { timeout: Math.min(5000, input.timeoutMs) }).catch(() => undefined);
    await input.page.waitForTimeout(150);
    throwIfAborted(input.signal);

    candidate = await input.page.evaluate<JsonObject | null>(() => {
      const marker = "data-orchestrator-interaction-probe";
      const unsafeLabel = /\b(delete|remove|reset|clear|logout|sign\s*out|drop|destroy)\b/i;
      const directActionLabel = /\b(click|increment|counter|toggle|calculate|start|next|submit|send|save|feedback|contact|message)\b/i;
      const fieldActionLabel = /\b(calculate|search|filter|go|submit|send|save|feedback|contact|message)\b/i;
      const buttonActionLabel = /\b(click|increment|counter|add|toggle|calculate|search|go|start|next|submit|send|save)\b/i;

      function textOf(element: Element): string {
        return (element.textContent ?? element.getAttribute("value") ?? element.getAttribute("aria-label") ?? "")
          .replace(/\s+/g, " ")
          .trim();
      }

      function visible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity || "1") > 0
          && rect.width > 0
          && rect.height > 0;
      }

      function controlValue(control: Element): string {
        if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
          return control.checked ? control.value || "on" : "";
        }
        if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
          return control.value;
        }
        return "";
      }

      function isTextField(control: Element): boolean {
        if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) && control.disabled) {
          return false;
        }
        if (control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
          return true;
        }
        if (!(control instanceof HTMLInputElement)) {
          return false;
        }
        return !["hidden", "submit", "button", "reset", "image"].includes(control.type);
      }

      function isUnsupportedField(control: Element): boolean {
        return control instanceof HTMLInputElement && ["file", "password"].includes(control.type);
      }

      function dispatchControlEvents(control: Element): void {
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }

      function numericValueFor(input: HTMLInputElement): string {
        const min = Number(input.min);
        const max = Number(input.max);
        let value = 5;
        if (Number.isFinite(min) && value < min) {
          value = min;
        }
        if (Number.isFinite(max) && value > max) {
          value = max;
        }
        return String(value);
      }

      function probeValueFor(input: HTMLInputElement): string {
        switch (input.type.toLowerCase()) {
          case "email":
            return "tester@example.com";
          case "url":
            return "https://example.com";
          case "tel":
            return "555-0100";
          case "number":
          case "range":
            return numericValueFor(input);
          case "date":
            return "2026-01-01";
          case "datetime-local":
            return "2026-01-01T12:00";
          case "month":
            return "2026-01";
          case "week":
            return "2026-W01";
          case "time":
            return "12:00";
          case "color":
            return "#3366ff";
          default:
            return "Verification test";
        }
      }

      function fillControl(control: Element): boolean {
        if (control instanceof HTMLTextAreaElement) {
          if (control.value.trim().length > 0 || control.readOnly || control.disabled) {
            return false;
          }
          control.value = "This is a browser verification test message.";
          dispatchControlEvents(control);
          return true;
        }
        if (control instanceof HTMLSelectElement) {
          if (control.value.trim().length > 0 || control.disabled) {
            return false;
          }
          const option = Array.from(control.options).find((entry) => !entry.disabled && entry.value.trim().length > 0)
            ?? Array.from(control.options).find((entry) => !entry.disabled);
          if (option === undefined) {
            return false;
          }
          control.value = option.value;
          dispatchControlEvents(control);
          return true;
        }
        if (!(control instanceof HTMLInputElement) || control.readOnly || control.disabled || isUnsupportedField(control)) {
          return false;
        }
        const type = control.type.toLowerCase();
        if (type === "radio") {
          if (control.checked) {
            return false;
          }
          const group = control.name.trim().length > 0 && control.form !== null
            ? Array.from(control.form.querySelectorAll(`input[type="radio"][name="${CSS.escape(control.name)}"]`))
            : [control];
          const option = group.find((entry): entry is HTMLInputElement => entry instanceof HTMLInputElement && !entry.disabled) ?? control;
          option.checked = true;
          dispatchControlEvents(option);
          return true;
        }
        if (type === "checkbox") {
          if (control.checked) {
            return false;
          }
          control.checked = true;
          dispatchControlEvents(control);
          return true;
        }
        if (control.value.trim().length > 0) {
          return false;
        }
        control.value = probeValueFor(control);
        dispatchControlEvents(control);
        return true;
      }

      function submitterFor(form: HTMLFormElement): HTMLElement | null {
        const controls = Array.from(form.querySelectorAll("button, input[type='submit'], input[type='button']"));
        return controls.find((control): control is HTMLElement => control instanceof HTMLElement && visible(control) && !("disabled" in control && control.disabled === true)) ?? null;
      }

      document.querySelectorAll(`[${marker}]`).forEach((element) => element.removeAttribute(marker));

      for (const form of Array.from(document.querySelectorAll("form"))) {
        if (!visible(form)) {
          continue;
        }
        const submitter = submitterFor(form);
        if (submitter === null) {
          continue;
        }
        const method = (form.getAttribute("method") ?? "get").toLowerCase();
        const label = `${textOf(submitter)} ${textOf(form)}`.trim();
        if (unsafeLabel.test(label)) {
          continue;
        }
        const fields = Array.from(form.querySelectorAll("input, textarea, select")).filter(isTextField);
        if (fields.some(isUnsupportedField)) {
          continue;
        }
        if (fields.length > 8 && !fieldActionLabel.test(label)) {
          continue;
        }
        if (fields.length > 0 && !directActionLabel.test(label) && !fieldActionLabel.test(label)) {
          continue;
        }
        const filledCount = fields.reduce((count, field) => count + (fillControl(field) ? 1 : 0), 0);
        if (fields.some((field) => field.hasAttribute("required") && controlValue(field).trim().length === 0)) {
          continue;
        }
        submitter.setAttribute(marker, "target");
        return {
          kind: "form-submit",
          label: label.slice(0, 160),
          method,
          action: form.getAttribute("action") ?? "",
          fieldCount: fields.length,
          filledCount,
        };
      }

      for (const button of Array.from(document.querySelectorAll("button, input[type='button']"))) {
        if (!(button instanceof HTMLElement) || button.closest("form") !== null || !visible(button)) {
          continue;
        }
        if ("disabled" in button && button.disabled === true) {
          continue;
        }
        const label = textOf(button);
        if (!buttonActionLabel.test(label) || unsafeLabel.test(label)) {
          continue;
        }
        button.setAttribute(marker, "target");
        return {
          kind: "button",
          label: label.slice(0, 160),
          method: "client",
          action: "",
          fieldCount: 0,
          filledCount: 0,
        };
      }

      return null;
    });

    if (candidate === null) {
      return { status: "skipped", note: "No simple safe interaction candidate was found." };
    }

    const before = await input.page.evaluate<JsonObject>(() => ({
      url: location.href,
      bodyTextLength: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().length,
    }));
    const clicked = await input.page.evaluate<boolean>(() => {
      const target = document.querySelector("[data-orchestrator-interaction-probe='target']");
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      target.click();
      return true;
    });

    if (!clicked) {
      return { status: "failed", note: "The selected interaction target disappeared before it could be clicked.", action: candidate };
    }

    await input.page.waitForLoadState("networkidle", { timeout: Math.min(5000, input.timeoutMs) }).catch(() => undefined);
    await input.page.waitForTimeout(350);
    throwIfAborted(input.signal);
    const after = await input.page.evaluate<JsonObject>(() => ({
      url: location.href,
      bodyTextLength: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().length,
      title: document.title,
    }));

    const newBadResponses = signalDelta(input.badResponses, beforeSignals.badResponses);
    const newNetworkErrors = signalDelta(input.networkErrors, beforeSignals.networkErrors);
    const newPageErrors = signalDelta(input.pageErrors, beforeSignals.pageErrors);
    const failureCount = newBadResponses.length + newNetworkErrors.length + newPageErrors.length;
    return {
      status: failureCount === 0 ? "passed" : "failed",
      note: failureCount === 0
        ? "A simple browser interaction completed without new browser failures."
        : "A simple browser interaction produced browser failures.",
      action: candidate,
      before,
      after,
      badResponses: newBadResponses,
      networkErrors: newNetworkErrors,
      pageErrors: newPageErrors,
    };
  } catch (error) {
    throwIfAborted(input.signal);
    const newBadResponses = signalDelta(input.badResponses, beforeSignals.badResponses);
    const newNetworkErrors = signalDelta(input.networkErrors, beforeSignals.networkErrors);
    const newPageErrors = signalDelta(input.pageErrors, beforeSignals.pageErrors);
    if (candidate === null) {
      return {
        status: "skipped",
        note: `Interaction probe could not select a simple candidate: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000),
      };
    }
    return {
      status: "failed",
      note: `Interaction probe failed after selecting a target: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000),
      action: candidate,
      badResponses: newBadResponses,
      networkErrors: newNetworkErrors,
      pageErrors: newPageErrors,
    };
  }
}


interface ExtendedFormCandidate {
  label: string;
  method: string;
  action: string;
  fieldCount: number;
  mutating: boolean;
  eligibleFormCount: number;
}

async function settlePage(page: BrowserPage, timeoutMs: number, extraMs = 400): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: Math.min(5000, timeoutMs) }).catch(() => undefined);
  await page.waitForTimeout(extraMs);
}

async function selectExtendedFormCandidate(page: BrowserPage, eligibleIndex: number): Promise<ExtendedFormCandidate | null> {
  return page.evaluate<ExtendedFormCandidate | null, number>((targetIndex) => {
    const marker = "data-orchestrator-interaction-probe";
    const unsafeLabel = /\b(delete|remove|reset|clear|logout|sign\s*out|drop|destroy)\b/i;

    function textOf(element: Element): string {
      return (element.textContent ?? element.getAttribute("value") ?? element.getAttribute("aria-label") ?? "")
        .replace(/\s+/g, " ")
        .trim();
    }

    function visible(element: Element): boolean {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") > 0
        && rect.width > 0
        && rect.height > 0;
    }

    function isTextField(control: Element): boolean {
      if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) && control.disabled) {
        return false;
      }
      if (control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
        return true;
      }
      if (!(control instanceof HTMLInputElement)) {
        return false;
      }
      return !["hidden", "submit", "button", "reset", "image"].includes(control.type);
    }

    function isUnsupportedField(control: Element): boolean {
      return control instanceof HTMLInputElement && ["file", "password"].includes(control.type);
    }

    function submitterFor(form: HTMLFormElement): HTMLElement | null {
      const controls = Array.from(form.querySelectorAll("button, input[type='submit']"));
      return controls.find((control): control is HTMLElement => {
        if (!(control instanceof HTMLElement) || !visible(control)) {
          return false;
        }
        if ("disabled" in control && (control as HTMLButtonElement).disabled === true) {
          return false;
        }
        if (control instanceof HTMLButtonElement && control.type !== "submit") {
          return false;
        }
        return true;
      }) ?? null;
    }

    document.querySelectorAll(`[${marker}]`).forEach((element) => element.removeAttribute(marker));

    const eligible: Array<{ form: HTMLFormElement; submitter: HTMLElement; label: string; fields: Element[] }> = [];
    for (const form of Array.from(document.querySelectorAll("form"))) {
      if (!(form instanceof HTMLFormElement) || !visible(form)) {
        continue;
      }
      const submitter = submitterFor(form);
      if (submitter === null) {
        continue;
      }
      if (unsafeLabel.test(textOf(submitter))) {
        continue;
      }
      const label = `${textOf(submitter)} ${textOf(form)}`.trim();
      const fields = Array.from(form.querySelectorAll("input, textarea, select")).filter(isTextField);
      if (fields.some(isUnsupportedField)) {
        continue;
      }
      if (fields.length > 12) {
        continue;
      }
      eligible.push({ form, submitter, label, fields });
    }

    const entry = eligible[targetIndex];
    if (entry === undefined) {
      return null;
    }
    const method = (entry.form.getAttribute("method") ?? "get").toLowerCase();
    const mutating = method !== "get"
      || entry.form.hasAttribute("novalidate")
      || entry.form.querySelector("textarea") !== null
      || entry.fields.some((field) => field.hasAttribute("required"));
    entry.submitter.setAttribute(marker, "target");
    entry.form.setAttribute(marker, "form");
    return {
      label: entry.label.slice(0, 160),
      method,
      action: entry.form.getAttribute("action") ?? "",
      fieldCount: entry.fields.length,
      mutating,
      eligibleFormCount: eligible.length,
    };
  }, eligibleIndex);
}

async function fillMarkedForm(page: BrowserPage): Promise<{ filledCount: number; requiredEmpty: boolean } | null> {
  return page.evaluate<{ filledCount: number; requiredEmpty: boolean } | null>(() => {
    const marker = "data-orchestrator-interaction-probe";
    const form = document.querySelector(`form[${marker}='form']`);
    if (!(form instanceof HTMLFormElement)) {
      return null;
    }

    function isTextField(control: Element): boolean {
      if ((control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) && control.disabled) {
        return false;
      }
      if (control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
        return true;
      }
      if (!(control instanceof HTMLInputElement)) {
        return false;
      }
      return !["hidden", "submit", "button", "reset", "image"].includes(control.type);
    }

    function isUnsupportedField(control: Element): boolean {
      return control instanceof HTMLInputElement && ["file", "password"].includes(control.type);
    }

    function dispatchControlEvents(control: Element): void {
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function numericValueFor(input: HTMLInputElement): string {
      const min = Number(input.min);
      const max = Number(input.max);
      let value = 5;
      if (Number.isFinite(min) && value < min) {
        value = min;
      }
      if (Number.isFinite(max) && value > max) {
        value = max;
      }
      return String(value);
    }

    function probeValueFor(input: HTMLInputElement): string {
      switch (input.type.toLowerCase()) {
        case "email":
          return "tester@example.com";
        case "url":
          return "https://example.com";
        case "tel":
          return "555-0100";
        case "number":
        case "range":
          return numericValueFor(input);
        case "date":
          return "2026-01-01";
        case "datetime-local":
          return "2026-01-01T12:00";
        case "month":
          return "2026-01";
        case "week":
          return "2026-W01";
        case "time":
          return "12:00";
        case "color":
          return "#3366ff";
        default: {
          const hint = `${input.name} ${input.id} ${input.placeholder ?? ""}`.toLowerCase();
          if (/\b(url|link|website|homepage|href)\b/.test(hint) || /url|link/.test(input.name.toLowerCase())) {
            return "https://example.com/verification-test";
          }
          if (/\b(e-?mail)\b/.test(hint) || /email|mail/.test(input.name.toLowerCase())) {
            return "tester@example.com";
          }
          if (/\b(phone|tel(ephone)?)\b/.test(hint)) {
            return "555-0100";
          }
          return "Verification test";
        }
      }
    }

    function controlValue(control: Element): string {
      if (control instanceof HTMLInputElement && ["checkbox", "radio"].includes(control.type)) {
        return control.checked ? control.value || "on" : "";
      }
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
        return control.value;
      }
      return "";
    }

    function fillControl(control: Element): boolean {
      if (control instanceof HTMLTextAreaElement) {
        if (control.value.trim().length > 0 || control.readOnly || control.disabled) {
          return false;
        }
        control.value = "This is a browser verification test message.";
        dispatchControlEvents(control);
        return true;
      }
      if (control instanceof HTMLSelectElement) {
        if (control.value.trim().length > 0 || control.disabled) {
          return false;
        }
        const option = Array.from(control.options).find((entry) => !entry.disabled && entry.value.trim().length > 0)
          ?? Array.from(control.options).find((entry) => !entry.disabled);
        if (option === undefined) {
          return false;
        }
        control.value = option.value;
        dispatchControlEvents(control);
        return true;
      }
      if (!(control instanceof HTMLInputElement) || control.readOnly || control.disabled || isUnsupportedField(control)) {
        return false;
      }
      const type = control.type.toLowerCase();
      if (type === "radio") {
        if (control.checked) {
          return false;
        }
        const group = control.name.trim().length > 0 && control.form !== null
          ? Array.from(control.form.querySelectorAll(`input[type="radio"][name="${CSS.escape(control.name)}"]`))
          : [control];
        const option = group.find((entry): entry is HTMLInputElement => entry instanceof HTMLInputElement && !entry.disabled) ?? control;
        option.checked = true;
        dispatchControlEvents(option);
        return true;
      }
      if (type === "checkbox") {
        if (control.checked) {
          return false;
        }
        control.checked = true;
        dispatchControlEvents(control);
        return true;
      }
      if (control.value.trim().length > 0) {
        return false;
      }
      control.value = probeValueFor(control);
      dispatchControlEvents(control);
      return true;
    }

    const fields = Array.from(form.querySelectorAll("input, textarea, select")).filter(isTextField);
    const filledCount = fields.reduce((count, field) => count + (fillControl(field) ? 1 : 0), 0);
    const requiredEmpty = fields.some((field) => field.hasAttribute("required") && controlValue(field).trim().length === 0);
    return { filledCount, requiredEmpty };
  });
}

async function clickMarkedTarget(page: BrowserPage): Promise<boolean> {
  return page.evaluate<boolean>(() => {
    const target = document.querySelector("[data-orchestrator-interaction-probe='target']");
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    target.click();
    return true;
  });
}

async function detectHydrationState(page: BrowserPage): Promise<"hydrated" | "not-hydrated" | "not-applicable"> {
  return page.evaluate<"hydrated" | "not-hydrated" | "not-applicable">(() => {
    if (document.querySelector('script[src*="/_next/"]') === null) {
      return "not-applicable";
    }
    const candidates: Element[] = [
      document.documentElement,
      document.body,
      ...Array.from(document.querySelectorAll("button, a, input, select, textarea, form, main, nav, section, div")).slice(0, 80),
    ];
    for (const element of candidates) {
      if (element !== null && Object.keys(element).some((key) => key.startsWith("__react"))) {
        return "hydrated";
      }
    }
    return "not-hydrated";
  });
}

async function discoverInternalRoutes(page: BrowserPage): Promise<string[]> {
  return page.evaluate<string[]>(() => {
    const current = location.pathname;
    const paths = new Set<string>();
    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//")) {
        continue;
      }
      const path = href.split("#")[0].split("?")[0];
      if (path.length === 0 || path === current) {
        continue;
      }
      paths.add(path);
    }
    return Array.from(paths).slice(0, 6);
  });
}

interface ProbeSignalState {
  badResponses: string[];
  networkErrors: string[];
  pageErrors: string[];
}

function captureSignalCounts(signals: ProbeSignalState): { badResponses: number; networkErrors: number; pageErrors: number } {
  return {
    badResponses: signals.badResponses.length,
    networkErrors: signals.networkErrors.length,
    pageErrors: signals.pageErrors.length,
  };
}

function probeSignalEvidence(signals: ProbeSignalState, before: { badResponses: number; networkErrors: number; pageErrors: number }): {
  newBadResponses: string[];
  newNetworkErrors: string[];
  newPageErrors: string[];
  serverErrorResponses: string[];
} {
  const newBadResponses = signalDelta(signals.badResponses, before.badResponses);
  return {
    newBadResponses,
    newNetworkErrors: signalDelta(signals.networkErrors, before.networkErrors),
    newPageErrors: signalDelta(signals.pageErrors, before.pageErrors),
    serverErrorResponses: newBadResponses.filter((entry) => {
      const status = Number(entry.split(" ")[0]);
      return Number.isFinite(status) && status >= 500;
    }),
  };
}

async function runExtendedFormProbesOnPage(input: {
  page: BrowserPage;
  url: string;
  route: string;
  timeoutMs: number;
  signals: ProbeSignalState;
  requireForm: boolean;
  signal?: AbortSignal;
}): Promise<JsonObject[]> {
  const maxFormsPerPage = 3;
  const records: JsonObject[] = [];
  throwIfAborted(input.signal);
  await input.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
  await settlePage(input.page, input.timeoutMs);
  throwIfAborted(input.signal);

  const firstCandidate = await selectExtendedFormCandidate(input.page, 0);
  if (firstCandidate === null) {
    return input.requireForm
      ? []
      : [{ kind: "form-probe", route: input.route, status: "skipped", note: "No eligible safe form was found on this route." }];
  }

  const formCount = Math.min(firstCandidate.eligibleFormCount, maxFormsPerPage);
  for (let formIndex = 0; formIndex < formCount; formIndex += 1) {
    throwIfAborted(input.signal);
    if (formIndex > 0) {
      await input.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
      await settlePage(input.page, input.timeoutMs);
    }
    let candidate = formIndex === 0 ? firstCandidate : await selectExtendedFormCandidate(input.page, formIndex);
    if (candidate === null) {
      continue;
    }

    if (candidate.mutating) {
      const before = captureSignalCounts(input.signals);
      const clicked = await clickMarkedTarget(input.page);
      await settlePage(input.page, input.timeoutMs, 500);
      throwIfAborted(input.signal);
      const evidence = probeSignalEvidence(input.signals, before);
      const failed = evidence.newPageErrors.length > 0 || evidence.serverErrorResponses.length > 0;
      records.push({
        kind: "form-submit-empty",
        route: input.route,
        formIndex,
        label: candidate.label,
        method: candidate.method,
        fieldCount: candidate.fieldCount,
        status: !clicked ? "skipped" : failed ? "failed" : "passed",
        note: !clicked
          ? "The form submitter disappeared before the empty-submit probe could click it."
          : failed
            ? "Submitting the form with empty fields produced an uncaught page error or a 5xx response instead of graceful validation."
            : "Submitting the form with empty fields was handled gracefully (no uncaught errors, no 5xx).",
        pageErrors: evidence.newPageErrors,
        serverErrorResponses: evidence.serverErrorResponses,
        badResponses: evidence.newBadResponses,
      });
      await input.page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
      await settlePage(input.page, input.timeoutMs);
      throwIfAborted(input.signal);
      candidate = await selectExtendedFormCandidate(input.page, formIndex);
      if (candidate === null) {
        continue;
      }
    }

    const fillResult = await fillMarkedForm(input.page);
    if (fillResult === null) {
      records.push({
        kind: "form-submit",
        route: input.route,
        formIndex,
        label: candidate.label,
        status: "skipped",
        note: "The marked form disappeared before the happy-path probe could fill it.",
      });
      continue;
    }
    if (fillResult.requiredEmpty) {
      records.push({
        kind: "form-submit",
        route: input.route,
        formIndex,
        label: candidate.label,
        status: "skipped",
        note: "Required fields could not be filled with probe values, so the happy-path submit was skipped.",
        filledCount: fillResult.filledCount,
        fieldCount: candidate.fieldCount,
      });
      continue;
    }
    const before = captureSignalCounts(input.signals);
    const clicked = await clickMarkedTarget(input.page);
    await settlePage(input.page, input.timeoutMs, 500);
    throwIfAborted(input.signal);
    const evidence = probeSignalEvidence(input.signals, before);
    const failed = evidence.newPageErrors.length > 0
      || evidence.serverErrorResponses.length > 0
      || evidence.newNetworkErrors.length > 0;
    records.push({
      kind: "form-submit",
      route: input.route,
      formIndex,
      label: candidate.label,
      method: candidate.method,
      fieldCount: candidate.fieldCount,
      filledCount: fillResult.filledCount,
      status: !clicked ? "skipped" : failed ? "failed" : "passed",
      note: !clicked
        ? "The form submitter disappeared before the happy-path probe could click it."
        : failed
          ? "Submitting the filled form produced an uncaught page error, a 5xx response, or a network failure."
          : "Submitting the filled form was handled without crashes (4xx rejections of arbitrary probe values count as graceful).",
      badResponses: evidence.newBadResponses,
      serverErrorResponses: evidence.serverErrorResponses,
      networkErrors: evidence.newNetworkErrors,
      pageErrors: evidence.newPageErrors,
    });
  }
  return records;
}

async function runExtendedInteractionProbes(input: {
  newProbePage: () => Promise<BrowserPage>;
  url: string;
  timeoutMs: number;
  signals: ProbeSignalState;
  signal?: AbortSignal;
}): Promise<JsonObject[]> {
  const probes: JsonObject[] = [];
  const rootUrl = new URL(input.url);
  const rootPage = await input.newProbePage();
  throwIfAborted(input.signal);
  await rootPage.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
  await settlePage(rootPage, input.timeoutMs);

  let hydration = await detectHydrationState(rootPage).catch(() => "not-applicable" as const);
  if (hydration === "not-hydrated") {
    await rootPage.waitForTimeout(3000);
    hydration = await detectHydrationState(rootPage).catch(() => "not-applicable" as const);
  }
  if (hydration !== "not-applicable") {
    probes.push({
      kind: "hydration",
      route: rootUrl.pathname,
      status: hydration === "hydrated" ? "passed" : "failed",
      note: hydration === "hydrated"
        ? "The client framework attached to the rendered page (hydration succeeded)."
        : "The page ships client framework bundles but the framework never attached to the DOM: interactive handlers are dead and JS-driven flows cannot work. Common causes: a hydration error, or the dev server rejecting this origin for dev resources.",
    });
  }

  const routes = await discoverInternalRoutes(rootPage).catch(() => []);
  probes.push(...await runExtendedFormProbesOnPage({
    page: rootPage,
    url: input.url,
    route: rootUrl.pathname,
    timeoutMs: input.timeoutMs,
    signals: input.signals,
    requireForm: false,
    signal: input.signal,
  }));

  let probedRoutes = 0;
  for (const route of routes) {
    throwIfAborted(input.signal);
    try {
      const page = await input.newProbePage();
      const navigation = await page.goto(`${rootUrl.origin}${route}`, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
      const statusOf = (navigation as { status?: () => number } | null)?.status;
      const httpStatus = typeof statusOf === "function" ? (navigation as { status(): number }).status() : 0;
      const broken = httpStatus === 404 || httpStatus >= 500;
      probes.push({
        kind: "link-navigation",
        route,
        status: broken ? "failed" : "passed",
        httpStatus,
        note: broken
          ? `The app renders a link to ${route}, but navigating there returned HTTP ${httpStatus}.`
          : `The app-rendered link to ${route} resolved without a 404 or server error.`,
      });
      if (broken || probedRoutes >= 2) {
        continue;
      }
      const records = await runExtendedFormProbesOnPage({
        page,
        url: `${rootUrl.origin}${route}`,
        route,
        timeoutMs: input.timeoutMs,
        signals: input.signals,
        requireForm: true,
        signal: input.signal,
      });
      if (records.length > 0) {
        probes.push(...records);
        probedRoutes += 1;
      }
    } catch (error) {
      throwIfAborted(input.signal);
      logProcess("warn", "browser_harness.interaction_probe.route_failed", {
        route,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  }
  return probes;
}

export async function inspectPreview(input: {
  url: string;
  timeoutMs: number;
  headless: boolean;
  captureScreenshot?: boolean;
  interactionProbeLevel?: "basic" | "extended";
  signal?: AbortSignal;
}): Promise<BrowserInspectionResult> {
  throwIfAborted(input.signal);
  assertLocalPreviewUrl(input.url);
  const initialUrl = new URL(input.url);
  logProcess("info", "browser_harness.inspect.start", {
    url: input.url,
    timeoutMs: input.timeoutMs,
    headless: input.headless,
    captureScreenshot: input.captureScreenshot !== false,
    viewport: "1365x768",
  });

  const playwright = await loadPlaywright();
  throwIfAborted(input.signal);
  logProcess("info", "browser_harness.browser.launch.start", { headless: input.headless });
  let browser: Browser | null = await playwright.chromium.launch({ headless: input.headless });
  logProcess("info", "browser_harness.browser.launch.completed");
  let context: BrowserContext | null = await browser.newContext({
    viewport: { width: 1365, height: 768 },
    deviceScaleFactor: 1,
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  const onAbort = (): void => {
    void context?.close().catch(() => undefined);
    void browser?.close().catch(() => undefined);
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const pageErrors: string[] = [];
  const networkErrors: string[] = [];
  const abortedRequests: string[] = [];
  const badResponses: string[] = [];
  const blockedRequests: string[] = [];
  const startedAt = Date.now();
  const trackPageSignals = (trackedPage: BrowserPage): void => {
    trackedPage.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text().slice(0, 1000));
      }
      if (message.type() === "warning") {
        consoleWarnings.push(message.text().slice(0, 1000));
      }
    });
    trackedPage.on("pageerror", (error) => {
      pageErrors.push(error.message.slice(0, 1000));
    });
    trackedPage.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "failed";
      const line = `${request.method()} ${request.url()} ${errorText}`.slice(0, 1000);
      if (/\bERR_ABORTED\b|\bNS_BINDING_ABORTED\b/i.test(errorText)) {
        abortedRequests.push(line);
        return;
      }
      networkErrors.push(line);
    });
    trackedPage.on("response", (response) => {
      if (response.status() >= 400) {
        badResponses.push(`${response.status()} ${response.request().method()} ${response.url()} ${response.request().resourceType()}`.slice(0, 1000));
      }
    });
  };
  const installNetworkPolicy = async (trackedPage: BrowserPage): Promise<void> => {
    await trackedPage.route("**/*", (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const sameOrigin = url.protocol === initialUrl.protocol && url.hostname === initialUrl.hostname && url.port === initialUrl.port;
      if (sameOrigin) {
        void route.continue();
        return;
      }
      blockedRequests.push(`${request.method()} ${request.url()} blocked by snapshot network policy`.slice(0, 1000));
      void route.abort("blockedbyclient");
    });
  };

  await installNetworkPolicy(page);

  trackPageSignals(page);

  try {
    throwIfAborted(input.signal);
    logProcess("info", "browser_harness.navigation.start", { url: input.url });
    await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs });
    throwIfAborted(input.signal);
    const domContentLoadedAt = Date.now();
    logProcess("info", "browser_harness.navigation.domcontentloaded", {
      url: input.url,
      elapsedMs: domContentLoadedAt - startedAt,
    });
    await page.waitForLoadState("networkidle", { timeout: Math.min(8000, input.timeoutMs) }).catch(() => undefined);
    await page.waitForTimeout(350);
    throwIfAborted(input.signal);

    logProcess("info", "browser_harness.dom.capture.start", { url: input.url });
    const semanticDom = await page.evaluate(() => {
      const maxText = 300;
      const maxBodyText = 4000;

      function clampText(value: string, maxLength = maxText): string {
        const normalized = value.replace(/\s+/g, " ").trim();
        return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trimEnd()}...` : normalized;
      }

      function textOf(element: Element): string {
        return clampText(element.textContent ?? "");
      }

      function roleOf(element: Element): string {
        const explicit = element.getAttribute("role");
        if (explicit !== null && explicit.trim().length > 0) return explicit.trim();
        const tag = element.tagName.toLowerCase();
        if (tag === "a") return "link";
        if (tag === "button") return "button";
        if (/^h[1-6]$/.test(tag)) return "heading";
        if (tag === "nav") return "navigation";
        if (tag === "main") return "main";
        if (tag === "form") return "form";
        if (tag === "input" || tag === "textarea" || tag === "select") return "control";
        return tag;
      }

      function boxOf(element: Element): { x: number; y: number; width: number; height: number } | null {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      }

      function visible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || "1") > 0 &&
          rect.width > 0 &&
          rect.height > 0
        );
      }

      function labelOf(element: Element): string {
        const aria = element.getAttribute("aria-label");
        if (aria !== null && aria.trim().length > 0) return clampText(aria);
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy !== null) {
          const label = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
          if (label.trim().length > 0) return clampText(label);
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
          const id = element.id;
          if (id.length > 0) {
            const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? "";
            if (label.trim().length > 0) return clampText(label);
          }
          const wrappingLabel = element.closest("label")?.textContent ?? "";
          if (wrappingLabel.trim().length > 0) return clampText(wrappingLabel);
          const placeholder = element.getAttribute("placeholder");
          if (placeholder !== null && placeholder.trim().length > 0) return clampText(placeholder);
        }
        if (element instanceof HTMLImageElement) {
          return clampText(element.alt);
        }
        return textOf(element);
      }

      const elements = Array.from(document.querySelectorAll("main, nav, h1, h2, h3, a, button, form, input, textarea, select"))
        .slice(0, 160)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          role: roleOf(element),
          name: element.getAttribute("aria-label") || textOf(element),
          text: textOf(element),
          href: element instanceof HTMLAnchorElement ? element.getAttribute("href") ?? "" : "",
          visible: visible(element),
          box: boxOf(element),
        }));

      const bodyText = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
      return {
        url: location.href,
        title: document.title,
        lang: document.documentElement.lang || null,
        bodyText: clampText(bodyText, maxBodyText),
        bodyTextLength: bodyText.length,
        documentWidth: Math.round(document.documentElement.scrollWidth),
        documentHeight: Math.round(document.documentElement.scrollHeight),
        headings: Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).slice(0, 80).map((element) => ({
          level: Number(element.tagName.slice(1)),
          text: textOf(element),
          visible: visible(element),
          box: boxOf(element),
        })),
        landmarks: Array.from(document.querySelectorAll("main, nav, header, footer, aside, section, [role]")).slice(0, 80).map((element) => ({
          role: roleOf(element),
          label: labelOf(element),
          box: boxOf(element),
        })),
        controls: Array.from(document.querySelectorAll("button, a, input, select, textarea")).slice(0, 150).map((element) => ({
          tag: element.tagName.toLowerCase(),
          role: roleOf(element),
          label: labelOf(element),
          text: textOf(element),
          href: element instanceof HTMLAnchorElement ? element.getAttribute("href") : null,
          type: element instanceof HTMLInputElement ? element.type : element.getAttribute("type"),
          disabled: element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element.disabled : false,
          visible: visible(element),
          box: boxOf(element),
        })),
        forms: Array.from(document.querySelectorAll("form")).slice(0, 40).map((form) => ({
          label: labelOf(form),
          action: form.getAttribute("action"),
          method: form.getAttribute("method"),
          controls: Array.from(form.querySelectorAll("button, input, select, textarea")).slice(0, 40).map(labelOf),
        })),
        media: {
          images: Array.from(document.images).slice(0, 80).map((image) => {
            let srcHost: string | null = null;
            try {
              srcHost = image.currentSrc ? new URL(image.currentSrc, location.href).host : null;
            } catch {
              srcHost = null;
            }
            return { alt: clampText(image.alt), srcHost, visible: visible(image), box: boxOf(image) };
          }),
          canvasCount: document.querySelectorAll("canvas").length,
          videoCount: document.querySelectorAll("video").length,
          svgCount: document.querySelectorAll("svg").length,
        },
        visibleTextBlocks: Array.from(document.querySelectorAll("main p, main li, main div, section p, article p, h1, h2, h3"))
          .filter(visible)
          .map((element) => ({ text: textOf(element), box: boxOf(element) }))
          .filter((entry) => entry.text.length > 0)
          .slice(0, 120),
        elements,
      };
    }) as JsonObject;
    logProcess("info", "browser_harness.dom.capture.completed", {
      url: input.url,
      title: typeof semanticDom.title === "string" ? semanticDom.title : "",
      bodyTextLength: typeof semanticDom.bodyTextLength === "number" ? semanticDom.bodyTextLength : null,
      headingCount: Array.isArray(semanticDom.headings) ? semanticDom.headings.length : 0,
      controlCount: Array.isArray(semanticDom.controls) ? semanticDom.controls.length : 0,
    });

    let axTree: JsonValue = null;
    try {
      throwIfAborted(input.signal);
      logProcess("info", "browser_harness.accessibility.capture.start", { url: input.url });
      const pageAny = page as unknown as {
        accessibility?: { snapshot: (options?: { interestingOnly?: boolean }) => Promise<unknown> };
        locator: (selector: string) => { ariaSnapshot?: () => Promise<unknown> };
      };
      if (pageAny.accessibility?.snapshot !== undefined) {
        axTree = jsonValue(await pageAny.accessibility.snapshot({ interestingOnly: true }));
      } else if (pageAny.locator("body").ariaSnapshot !== undefined) {
        axTree = jsonValue(await pageAny.locator("body").ariaSnapshot?.());
      }
      logProcess("info", "browser_harness.accessibility.capture.completed", { url: input.url, captured: axTree !== null });
    } catch {
      throwIfAborted(input.signal);
      axTree = null;
      logProcess("warn", "browser_harness.accessibility.capture.failed", { url: input.url });
    }

    const bodyText = typeof semanticDom.bodyText === "string" ? semanticDom.bodyText : "";
    const elements = Array.isArray(semanticDom.elements) ? semanticDom.elements : [];
    const hiddenCount = elements.filter((entry) => typeof entry === "object" && entry !== null && (entry as { visible?: unknown }).visible === false).length;
    const zeroSizeCount = elements.filter((entry) => typeof entry === "object" && entry !== null && (entry as { box?: unknown }).box === null).length;
    throwIfAborted(input.signal);
    logProcess("info", "browser_harness.screenshot.start", { url: input.url, enabled: input.captureScreenshot !== false });
    const screenshot = input.captureScreenshot === false ? null : await page.screenshot({ fullPage: false, type: "png" });
    const capturedAt = Date.now();
    logProcess("info", "browser_harness.screenshot.completed", {
      url: input.url,
      bytes: screenshot?.byteLength ?? 0,
      elapsedMs: capturedAt - startedAt,
    });

    const preProbeSignals = {
      consoleErrors: consoleErrors.length,
      pageErrors: pageErrors.length,
      networkErrors: networkErrors.length + blockedRequests.length,
      badResponses: badResponses.length,
    };
    let interactionProbes: JsonObject[] = [];
    try {
      throwIfAborted(input.signal);
      const probeLevel = input.interactionProbeLevel ?? "basic";
      logProcess("info", "browser_harness.interaction_probe.start", { url: input.url, probeLevel });
      if (probeLevel === "extended") {
        const probeContext = context;
        interactionProbes = await runExtendedInteractionProbes({
          newProbePage: async () => {
            if (probeContext === null) {
              throw new Error("Browser context was closed before the interaction probe could run.");
            }
            const probePage = await probeContext.newPage();
            await installNetworkPolicy(probePage);
            trackPageSignals(probePage);
            return probePage;
          },
          url: input.url,
          timeoutMs: input.timeoutMs,
          signals: { badResponses, networkErrors, pageErrors },
          signal: input.signal,
        });
      } else {
        const probePage = await context.newPage();
        await installNetworkPolicy(probePage);
        trackPageSignals(probePage);
        interactionProbes = [await runBasicInteractionProbe({
          page: probePage,
          url: input.url,
          timeoutMs: input.timeoutMs,
          badResponses,
          networkErrors,
          pageErrors,
          signal: input.signal,
        })];
      }
      logProcess("info", "browser_harness.interaction_probe.completed", {
        url: input.url,
        probeLevel,
        probeCount: interactionProbes.length,
        status: typeof interactionProbes[0]?.status === "string" ? interactionProbes[0].status : "unknown",
      });
    } catch (error) {
      throwIfAborted(input.signal);
      interactionProbes = [{
        status: "skipped",
        note: `Interaction probe was skipped after a browser harness error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000),
      }];
      logProcess("warn", "browser_harness.interaction_probe.failed", { url: input.url, error: interactionProbes[0].note });
    }

    logProcess("info", "browser_harness.inspect.completed", {
      url: input.url,
      consoleErrorCount: consoleErrors.length,
      consoleWarningCount: consoleWarnings.length,
      pageErrorCount: pageErrors.length,
      networkErrorCount: networkErrors.length + blockedRequests.length,
      badResponseCount: badResponses.length,
      durationMs: capturedAt - startedAt,
    });
    return {
      url: typeof semanticDom.url === "string" ? semanticDom.url : input.url,
      title: typeof semanticDom.title === "string" ? semanticDom.title : "",
      bodyText,
      axTree,
      semanticDom,
      interactionProbes,
      preProbeSignals,
      geometry: {
        summarizedElementCount: elements.length,
        hiddenElementCount: hiddenCount,
        zeroSizeElementCount: zeroSizeCount,
      },
      consoleErrors: consoleErrors.slice(0, 50),
      consoleWarnings: consoleWarnings.slice(0, 50),
      pageErrors: pageErrors.slice(0, 50),
      networkErrors: [...networkErrors, ...blockedRequests].slice(0, 50),
      abortedRequests: abortedRequests.slice(0, 50),
      badResponses: badResponses.slice(0, 50),
      timing: {
        navigationStartedAt: new Date(startedAt).toISOString(),
        domContentLoadedMs: domContentLoadedAt - startedAt,
        captureDurationMs: capturedAt - startedAt,
      },
      screenshot,
    };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    logProcess("info", "browser_harness.cleanup.start", { url: input.url });
    await context?.close().catch(() => undefined);
    context = null;
    await browser?.close().catch(() => undefined);
    browser = null;
    logProcess("info", "browser_harness.cleanup.completed", { url: input.url });
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
