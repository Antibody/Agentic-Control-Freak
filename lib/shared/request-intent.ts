import { resolveStackSuggestion } from "@/lib/shared/stack-intent";

export type RequestIntentCoverageMode = "plan" | "source";
export type ProductShape =
  | "script"
  | "data-visualization"
  | "generated-report"
  | "backend-api"
  | "server-rendered-web"
  | "fullstack-web"
  | "static-frontend"
  | "cli"
  | "library"
  | "unknown";

interface IntentTermDefinition {
  label: string;
  requestPattern: RegExp;
  candidatePattern: RegExp;
  sourceRequired: boolean;
}

export interface RequestIntentProfile {
  quotedAnchors: string[];
  termAnchors: string[];
  sourceTermAnchors: string[];
  singleFileHtml: boolean;
  browserGame: boolean;
  productShape: ProductShape;
  pythonMode: "script" | "web" | "unknown";
  highSignal: boolean;
}

export interface ProductIntentProfile {
  productShape: ProductShape;
  pythonMode: "script" | "web" | "unknown";
  reasons: string[];
}

export interface RequestIntentCoverage {
  applicable: boolean;
  passed: boolean;
  profile: RequestIntentProfile;
  matchedQuotedAnchors: string[];
  missingQuotedAnchors: string[];
  matchedTerms: string[];
  missingTerms: string[];
  messages: string[];
}

const intentTerms: IntentTermDefinition[] = [
  {
    label: "game",
    requestPattern: /\bgame(?:play)?\b/i,
    candidatePattern: /\bgame(?:play)?\b/i,
    sourceRequired: false,
  },
  {
    label: "single-file",
    requestPattern: /\bsingle[-\s]?file\b|\bsingle\s+html\s+file\b/i,
    candidatePattern: /\bsingle[-\s]?file\b|\bsingle\s+html\s+file\b|\binline\b/i,
    sourceRequired: false,
  },
  {
    label: "html",
    requestPattern: /\bhtml\b/i,
    candidatePattern: /\bhtml\b|<!doctype html|<html\b/i,
    sourceRequired: true,
  },
  {
    label: "canvas",
    requestPattern: /\bcanvas\b/i,
    candidatePattern: /\bcanvas\b|<canvas\b|getcontext\(/i,
    sourceRequired: true,
  },
  {
    label: "webgl",
    requestPattern: /\bwebgl\b/i,
    candidatePattern: /\bwebgl\b|getcontext\(["']webgl2?["']\)/i,
    sourceRequired: true,
  },
  {
    label: "shader",
    requestPattern: /\bshader\b|\bfragment shader\b|\bvertex shader\b/i,
    candidatePattern: /\bshader\b|\bfragment shader\b|\bvertex shader\b|gl_fragcolor|gl_position/i,
    sourceRequired: true,
  },
  {
    label: "glsl",
    requestPattern: /\bglsl\b/i,
    candidatePattern: /\bglsl\b|precision\s+(?:lowp|mediump|highp)\s+float|vec[234]\b/i,
    sourceRequired: true,
  },
  {
    label: "raymarch",
    requestPattern: /\bray[-\s]?march(?:ed|er|ing)?\b/i,
    candidatePattern: /\bray[-\s]?march(?:ed|er|ing)?\b/i,
    sourceRequired: true,
  },
  {
    label: "sdf",
    requestPattern: /\bsdf\b|\bsigned[-\s]?distance\b/i,
    candidatePattern: /\bsdf\b|\bsigned[-\s]?distance\b|map\s*\(\s*vec3|distance\s+field/i,
    sourceRequired: true,
  },
  {
    label: "audio",
    requestPattern: /\bweb audio\b|\bprocedural audio\b|\baudio\b/i,
    candidatePattern: /\bweb audio\b|\bprocedural audio\b|\baudio\b|audiocontext|oscillator/i,
    sourceRequired: true,
  },
];

const trivialQuotedAnchors = new Set([
  "html",
  "css",
  "js",
  "javascript",
  "typescript",
  "node",
  "next",
  "vite",
  "react",
  "python",
]);

export function intentRelevantRequestText(userRequest: string): string {
  const normalizedNewlines = userRequest.slice(0, 50_000).replace(/\r\n/g, "\n");
  const marker = normalizedNewlines.search(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:(?:frontend|ui|design|implementation)\s+)?(?:design\s+)?skill\s*:\s*(?:\n|$)/i);
  if (marker > 0) {
    const prefix = normalizedNewlines.slice(0, marker).trim();
    if (/\b(?:consider|use|apply|create|build|make|update|change|modify|implement|design|style|restyle|revamp)\b/i.test(prefix)) {
      return prefix;
    }
  }
  const skillFrontmatterMarker = normalizedNewlines.search(
    /(?:^|\n)\s*---\s*\n\s*name\s*:\s*[^\n]+\n\s*description\s*:[\s\S]{0,2000}?\n\s*---\s*(?:\n|$)/i,
  );
  if (skillFrontmatterMarker > 0) {
    const prefix = normalizedNewlines.slice(0, skillFrontmatterMarker).trim();
    if (/\b(?:consider|use|apply|create|build|make|update|change|modify|implement|design|style|restyle|revamp)\b/i.test(prefix)) {
      return prefix;
    }
  }
  return normalizedNewlines;
}

export function isSingleFileHtmlRequest(userRequest: string): boolean {
  const requestText = intentRelevantRequestText(userRequest);
  return /\bsingle[-\s]?file\s+html\b|\bsingle\s+html\s+file\b|\bone\s+html\s+file\b|\bstandalone\s+html\b/i.test(requestText);
}

export function isBrowserGameRequest(userRequest: string): boolean {
  const requestText = intentRelevantRequestText(userRequest);
  return /\bgame(?:play)?\b/i.test(requestText) && /\b(html|canvas|webgl|glsl|shader|browser|single[-\s]?file)\b/i.test(requestText);
}

export function isPlainStaticWebPageRequest(userRequest: string): boolean {
  return resolveStackSuggestion(userRequest).stack === "static-html";
}

export function classifyProductIntent(userRequest: string): ProductIntentProfile {
  const requestText = intentRelevantRequestText(userRequest);
  const normalized = requestText.toLowerCase().replace(/\s+/g, " ").trim();
  const mentionsPython = /\bpython\b|\bflask\b|\bdjango\b|\bfastapi\b/.test(normalized);
  const explicitPythonWeb = /\bflask\b|\bdjango\b|\bfastapi\b|\bpython\s+(?:web|backend|server|api|site|website)\b/.test(normalized);
  const webSignals = /\b(web app|website|site|frontend|front-end|html|css|javascript|js|browser ui|page|pages|dashboard|form|login|route|routes|server|backend|api|full[-\s]?stack)\b/.test(normalized);
  const fullstackSignals = /\bfull[-\s]?stack\b|\bbackend\b.*\bfrontend\b|\bfrontend\b.*\bbackend\b|\bfrontend\b|\bfront-end\b|\bhtml\/css(?:\/js)?\b|\bhtml\s+css(?:\s+js)?\b|\bcss\b|\bjavascript\b|\bjs\b|\bclient-side\b/.test(normalized);
  const apiSignals = /\b(api|endpoint|rest|json api|backend service)\b/.test(normalized);
  const scriptSignals = /\b(script|scripting|automation|cli|command line|terminal|calculate|calculation|parse|convert|transform|scrape)\b/.test(normalized);
  const visualizationSignals = /\b(plot|chart|graph|visuali[sz]ation|matplotlib|pyplot|seaborn|histogram|scatter|line chart|bar chart|figure|savefig)\b/.test(normalized);
  const reportSignals = /\b(report|analysis|analy[sz]e data|summary|csv|spreadsheet)\b/.test(normalized);
  const staticSignals = isPlainStaticWebPageRequest(requestText);
  const reasons: string[] = [];

  let productShape: ProductShape = "unknown";
  if (staticSignals) {
    productShape = "static-frontend";
    reasons.push("Request asks for static or no-framework browser output.");
  } else if (fullstackSignals) {
    productShape = "fullstack-web";
    reasons.push("Request asks for a web product with both backend/runtime and frontend/browser surface.");
  } else if (mentionsPython && visualizationSignals) {
    productShape = "data-visualization";
    reasons.push("Request asks for Python plotting or visualization output.");
  } else if (visualizationSignals) {
    productShape = "data-visualization";
    reasons.push("Request asks for plotting or visualization output.");
  } else if (mentionsPython && reportSignals && !webSignals) {
    productShape = "generated-report";
    reasons.push("Request asks for Python report/data output rather than a web product.");
  } else if (apiSignals && !webSignals) {
    productShape = "backend-api";
    reasons.push("Request asks primarily for an API/backend service.");
  } else if (webSignals) {
    productShape = "server-rendered-web";
    reasons.push("Request asks for a browser-visible web surface.");
  } else if (scriptSignals) {
    productShape = /\bcli|command line|terminal\b/.test(normalized) ? "cli" : "script";
    reasons.push("Request asks for script or command-line behavior.");
  }

  const pythonMode = !mentionsPython
    ? "unknown"
    : explicitPythonWeb || productShape === "fullstack-web" || productShape === "server-rendered-web" || productShape === "backend-api"
      ? "web"
      : "script";
  if (mentionsPython) {
    reasons.push(`Python mode classified as ${pythonMode}.`);
  }
  return { productShape, pythonMode, reasons };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesPhrase(candidateText: string, phrase: string): boolean {
  const normalizedCandidate = ` ${normalize(candidateText)} `;
  const normalizedPhrase = normalize(phrase);
  return normalizedPhrase.length > 0 && normalizedCandidate.includes(` ${normalizedPhrase} `);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function quotedAnchorLooksLikeNegativeGuidance(source: string, start: number, end: number): boolean {
  const before = source.slice(Math.max(0, start - 120), start).toLowerCase();
  const after = source.slice(end, Math.min(source.length, end + 90)).toLowerCase();
  return (
    /\b(?:no|not|never|avoid|ban|banned|hard no|red flags?|screams?|instead of|not like|shortcut to|used to doing|generic ai)\b/.test(before) ||
    /\b(?:not allowed|unless explicitly requested|cosplay|as a shortcut)\b/.test(after)
  );
}

function extractQuotedAnchors(userRequest: string): string[] {
  const requestText = intentRelevantRequestText(userRequest);
  const anchors: string[] = [];
  const titled = requestText.match(/\btitled\s+["'\u201c\u201d\u2018\u2019]([^"'\u201c\u201d\u2018\u2019]{3,80})["'\u201c\u201d\u2018\u2019]/i);
  if (titled?.[1] !== undefined) {
    anchors.push(titled[1].replace(/\s+/g, " ").trim().replace(/[.!?]+$/, ""));
  }

  const quotedPatterns = [
    /["\u201c\u201d]([^"\u201c\u201d]{3,96})["\u201c\u201d]/g,
    /(^|[^A-Za-z0-9])['\u2018\u2019]([^'\u2018\u2019]{3,96})['\u2018\u2019](?=$|[^A-Za-z0-9])/g,
  ];
  for (const pattern of quotedPatterns) {
    for (const match of requestText.matchAll(pattern)) {
      const raw = pattern === quotedPatterns[0] ? match[1] : match[2];
      const value = (raw ?? "").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
      const start = pattern === quotedPatterns[0]
        ? match.index + 1
        : match.index + (match[1]?.length ?? 0) + 1;
      const end = start + (raw?.length ?? 0);
      if (quotedAnchorLooksLikeNegativeGuidance(requestText, start, end)) {
        continue;
      }
      const normalized = normalize(value);
      if (normalized.length < 3 || trivialQuotedAnchors.has(normalized)) {
        continue;
      }
      const wordCount = normalized.split(" ").filter((word) => word.length > 0).length;
      if (wordCount > 8 || /\*|`|\n|\bact\s+as\b/i.test(value)) {
        continue;
      }
      if (!/[a-z]/i.test(value)) {
        continue;
      }
      anchors.push(value);
    }
  }
  return unique(anchors).slice(0, 4);
}

export function analyzeRequestIntent(userRequest: string): RequestIntentProfile {
  const requestText = intentRelevantRequestText(userRequest);
  const termAnchors = intentTerms
    .filter((term) => term.requestPattern.test(requestText))
    .map((term) => term.label);
  const sourceTermAnchors = intentTerms
    .filter((term) => term.sourceRequired && term.requestPattern.test(requestText))
    .map((term) => term.label);
  const singleFileHtml = isSingleFileHtmlRequest(requestText);
  const browserGame = isBrowserGameRequest(requestText);
  const quotedAnchors = extractQuotedAnchors(requestText);
  const productIntent = classifyProductIntent(requestText);
  return {
    quotedAnchors,
    termAnchors,
    sourceTermAnchors,
    singleFileHtml,
    browserGame,
    productShape: productIntent.productShape,
    pythonMode: productIntent.pythonMode,
    highSignal: quotedAnchors.length > 0 || termAnchors.length >= 3 || singleFileHtml || browserGame || productIntent.productShape !== "unknown",
  };
}

function minimumTermMatches(termCount: number, mode: RequestIntentCoverageMode): number {
  if (termCount === 0) {
    return 0;
  }
  if (mode === "source") {
    return Math.min(termCount, Math.min(3, Math.max(1, Math.ceil(termCount * 0.45))));
  }
  return Math.min(termCount, Math.min(4, Math.max(2, Math.ceil(termCount * 0.5))));
}

function nonRootPageRoutes(candidateText: string): string[] {
  const routes = new Set<string>();
  const addRoute = (value: string | undefined): void => {
    if (value === undefined) {
      return;
    }
    const normalized = value.startsWith("/") ? value.toLowerCase() : `/${value.toLowerCase()}`;
    if (normalized !== "/" && normalized !== "/index" && !normalized.startsWith("/api/")) {
      routes.add(normalized);
    }
  };

  const patterns = [
    /\bapp\.get\(\s*["'](\/[a-z0-9_-]+)["']/gi,
    /\b(?:get|route)\s+(\/[a-z0-9_-]+)\b/gi,
    /href=["'](\/[a-z0-9_-]+)["']/gi,
    /\bpublic\/([a-z0-9_-]+)\.html\b/gi,
    /\bapp\/([a-z0-9_-]+)\/page\.(?:tsx|ts|jsx|js)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of candidateText.matchAll(pattern)) {
      addRoute(match[1]);
    }
  }

  return [...routes];
}

function genericRouteMismatch(profile: RequestIntentProfile, candidateText: string): boolean {
  if (!profile.browserGame && !profile.singleFileHtml) {
    return false;
  }
  if (/\bvanilla node app\b/i.test(candidateText)) {
    return true;
  }
  const routes = nonRootPageRoutes(candidateText);
  const scaffoldLanguage = /\b(?:navigation|nav|shared layout|multi[-\s]?page|pages?|routes?|informational site|website scaffold)\b/i.test(candidateText);
  return routes.length >= 2 && scaffoldLanguage;
}

export function validateRequestIntentCoverage(
  userRequest: string,
  candidateText: string,
  options: { mode?: RequestIntentCoverageMode } = {},
): RequestIntentCoverage {
  const mode = options.mode ?? "source";
  const profile = analyzeRequestIntent(userRequest);
  if (!profile.highSignal) {
    return {
      applicable: false,
      passed: true,
      profile,
      matchedQuotedAnchors: [],
      missingQuotedAnchors: [],
      matchedTerms: [],
      missingTerms: [],
      messages: [],
    };
  }

  const termLabels = mode === "source" ? profile.sourceTermAnchors : profile.termAnchors;
  const matchedTerms = intentTerms
    .filter((term) => termLabels.includes(term.label) && term.candidatePattern.test(candidateText))
    .map((term) => term.label);
  const missingTerms = termLabels.filter((term) => !matchedTerms.includes(term));
  const matchedQuotedAnchors = profile.quotedAnchors.filter((anchor) => includesPhrase(candidateText, anchor));
  const missingQuotedAnchors = profile.quotedAnchors.filter((anchor) => !matchedQuotedAnchors.includes(anchor));
  const messages: string[] = [];

  if (profile.quotedAnchors.length > 0 && matchedQuotedAnchors.length === 0) {
    messages.push(`Missing quoted request anchor: ${profile.quotedAnchors.join(", ")}.`);
  }

  const minTerms = minimumTermMatches(termLabels.length, mode);
  if (termLabels.length > 0 && matchedTerms.length < minTerms) {
    messages.push(`Only matched ${matchedTerms.length}/${termLabels.length} request terms (${matchedTerms.join(", ") || "none"}); missing ${missingTerms.join(", ")}.`);
  }

  if (genericRouteMismatch(profile, candidateText)) {
    messages.push("Candidate appears to describe a generic informational site scaffold while the request asks for a specific browser experience.");
  }

  return {
    applicable: true,
    passed: messages.length === 0,
    profile,
    matchedQuotedAnchors,
    missingQuotedAnchors,
    matchedTerms,
    missingTerms,
    messages,
  };
}
