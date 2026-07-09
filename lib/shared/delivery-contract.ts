import { classifyProductIntent, isBrowserGameRequest, isSingleFileHtmlRequest } from "@/lib/shared/request-intent";
import type { DeliveryContract, PlanJson, StackDecision } from "@/lib/shared/types";

function quotedTerms(text: string): string[] {
  const terms = [...text.matchAll(/["'“”‘’]([^"'“”‘’]{2,80})["'“”‘’]/g)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((term) => term.length > 0);
  return Array.from(new Set(terms)).slice(0, 12);
}

function mentionsThreeJs(text: string): boolean {
  return /\bthree(?:\.js|js)?\b|\bwebgl\b|\bglsl\b|\bshader\b/i.test(text);
}

function requiredConceptsForRequest(text: string): string[] {
  const concepts: string[] = [];
  if (isBrowserGameRequest(text)) concepts.push("browser game");
  if (mentionsThreeJs(text)) concepts.push("webgl rendering");
  if (/\bcanvas\b/i.test(text)) concepts.push("canvas");
  return concepts;
}

export function deriveDeliveryContract(input: {
  userRequest: string;
  planJson?: PlanJson | null;
  stackDecision?: StackDecision | null;
}): DeliveryContract {
  const request = input.userRequest;
  const productIntent = classifyProductIntent(request);
  const stack = input.planJson?.targetStack ?? input.stackDecision?.stack ?? "unknown";
  const browserGame = isBrowserGameRequest(request);
  const singleFileHtml = isSingleFileHtmlRequest(request);
  const browserVisual = browserGame || mentionsThreeJs(request);
  const isStaticHtml = stack === "static-html";
  const isBrowserBundle = stack === "vite-react" || stack === "next";
  const isServer = stack === "node-express" || stack === "python-flask" || stack === "python-django" || stack === "r-shiny" || stack === "csharp" || stack === "php" || stack === "ruby" || stack === "java" || stack === "go" || stack === "rust";
  const isScript = stack === "python-script" || stack === "r-script" || stack === "node-cli";
  const isMl = stack === "python-ml";
  const artifactShape: DeliveryContract["artifactShape"] = singleFileHtml
    ? "single-file-html"
    : isStaticHtml
      ? "root-html-css-js"
      : isBrowserBundle
        ? "bundled-browser-app"
        : isServer
          ? "server-app"
          : isScript
            ? "script-or-report"
            : isMl
              ? "ml-training-bundle"
              : "unknown";
  const entrypoints = artifactShape === "single-file-html" || artifactShape === "root-html-css-js"
    ? ["index.html"]
    : artifactShape === "bundled-browser-app"
      ? ["package.json"]
      : artifactShape === "script-or-report"
        ? stack === "r-script" ? ["main.R"] : ["main.py"]
        : [];
  const requiredFiles = artifactShape === "single-file-html"
    ? ["index.html"]
    : artifactShape === "root-html-css-js"
      ? ["index.html", "styles.css"]
      : entrypoints;
  const forbiddenFiles = artifactShape === "single-file-html"
    ? ["styles.css", "script.js", "package.json"]
    : [];
  const css = artifactShape === "single-file-html" ? "inline" : artifactShape === "root-html-css-js" ? "local-file" : artifactShape === "bundled-browser-app" ? "bundled" : "unknown";
  const js = artifactShape === "single-file-html" ? "inline" : artifactShape === "root-html-css-js" ? "local-file" : artifactShape === "bundled-browser-app" ? "bundled" : "unknown";
  const sameOriginSnapshot = artifactShape === "single-file-html" || artifactShape === "root-html-css-js" || browserVisual;
  const externalRuntimeNetwork = sameOriginSnapshot ? "forbidden" : "unknown";
  const packageInstall = artifactShape === "single-file-html" || artifactShape === "root-html-css-js" ? "forbidden" : isBrowserBundle ? "allowed" : "unknown";

  return {
    schemaVersion: 1,
    stack,
    productShape: browserGame ? "browser-game" : productIntent.productShape,
    artifactShape,
    entrypoints,
    requiredFiles,
    forbiddenFiles,
    assetPolicy: {
      css,
      js,
      images: artifactShape === "single-file-html" ? "inline" : "unknown",
    },
    dependencyPolicy: {
      externalRuntimeNetwork,
      cdnRuntimeImports: externalRuntimeNetwork,
      packageInstall,
      vendoredLibraries: artifactShape === "root-html-css-js" || artifactShape === "bundled-browser-app" ? "allowed" : "unknown",
    },
    renderPolicy: {
      snapshotNetwork: sameOriginSnapshot ? "same-origin-only" : "unknown",
      requiresCanvasNonBlank: browserVisual,
      requiresWebGLFallback: browserVisual,
    },
    acceptanceAnchors: {
      quotedTerms: quotedTerms(request),
      requiredConcepts: requiredConceptsForRequest(request),
    },
    rationale: singleFileHtml
      ? "The request explicitly asks for a single HTML file, so scaffold-style split assets are forbidden."
      : isStaticHtml
        ? "The selected stack is static HTML without a bundler, so root static asset files are the default contract."
        : "Derived from the selected stack and request intent.",
  };
}

export function effectiveDeliveryContract(input: {
  planContract?: DeliveryContract | null;
  userRequest: string;
  planJson?: PlanJson | null;
  stackDecision?: StackDecision | null;
}): DeliveryContract {
  return input.planContract ?? deriveDeliveryContract({
    userRequest: input.userRequest,
    planJson: input.planJson,
    stackDecision: input.stackDecision,
  });
}

export function renderDeliveryContractForPrompt(contract: DeliveryContract): string {
  return [
    "Delivery contract:",
    `- Stack: ${contract.stack}.`,
    `- Product shape: ${contract.productShape}.`,
    `- Artifact shape: ${contract.artifactShape}.`,
    `- Required files: ${contract.requiredFiles.length > 0 ? contract.requiredFiles.join(", ") : "(none declared)"}.`,
    `- Forbidden files: ${contract.forbiddenFiles.length > 0 ? contract.forbiddenFiles.join(", ") : "(none declared)"}.`,
    `- CSS mode: ${contract.assetPolicy.css}.`,
    `- JavaScript mode: ${contract.assetPolicy.js}.`,
    `- Runtime network during verification: ${contract.dependencyPolicy.externalRuntimeNetwork}.`,
    `- CDN runtime imports: ${contract.dependencyPolicy.cdnRuntimeImports}.`,
    `- Snapshot network policy: ${contract.renderPolicy.snapshotNetwork}.`,
    `- Canvas/nonblank render required: ${contract.renderPolicy.requiresCanvasNonBlank ? "yes" : "no"}.`,
    `- WebGL/canvas fallback required: ${contract.renderPolicy.requiresWebGLFallback ? "yes" : "no"}.`,
    `- Rationale: ${contract.rationale}`,
  ].join("\n");
}
