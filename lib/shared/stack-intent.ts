import type { ProjectStack } from "@/lib/shared/types";
import { intentRelevantRequestText } from "@/lib/shared/request-intent";

export interface StackSuggestion {
  stack: ProjectStack;
  confidence: "high" | "medium" | "low";
  signals: string[];
  alternatives: ProjectStack[];
}

function stripStaticNegations(normalized: string): string {
  return normalized
    .replace(/\bno\s+(?:backend|back[-\s]?end|server(?:[-\s]side)?|apis?|endpoints?|database|db)\b/g, "")
    .replace(/\bwithout\s+(?:a\s+)?(?:backend|back[-\s]?end|server(?:[-\s]side)?|apis?|endpoints?|database|db)\b/g, "")
    .replace(/\bserverless\b/g, "");
}

const negatableStackNames =
  "next(?:\\.js|js)?|react|vite|vue|svelte|angular|remix|astro|django|flask|fastapi|express|fastify|node(?:\\.js|js)?|python|php|laravel|ruby|rails|java|spring boot|go|rust|c#|csharp|dotnet|asp\\.?net|(?:client[-\\s]?side\\s+)?frameworks?";

function stripNegatedStackMentions(normalized: string): string {
  return normalized.replace(
    new RegExp(`\\b(?:not|no|without|avoid(?:ing)?|don'?t use|do not use|instead of)\\s+(?:a\\s+|any\\s+)?(?:${negatableStackNames})\\b`, "g"),
    " ",
  );
}

function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map((token) => token.replace(/^[^a-z0-9#+./]+|[^a-z0-9#+./]+$/g, "").replace(/\.+$/, ""))
    .filter((token) => token.length > 0);
}

const techContextTokens = new Set([
  "server", "servers", "backend", "api", "apis", "app", "apps", "application", "applications",
  "framework", "runtime", "service", "cli", "web", "route", "routes", "endpoint", "endpoints",
  "middleware", "typescript", "javascript", "stack",
]);
const buildVerbs = new Set([
  "build", "built", "write", "written", "writing", "implement", "implemented", "create", "created",
  "make", "made", "develop", "developed", "code", "coded", "use", "used", "using", "rewrite",
  "port", "ported",
]);

function anyOccurrenceAnchored(tokens: string[], name: string): boolean {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== name) {
      continue;
    }
    for (let delta = -2; delta <= 2; delta += 1) {
      if (delta !== 0 && techContextTokens.has(tokens[index + delta] ?? "")) {
        return true;
      }
    }
    const prev = tokens[index - 1] ?? "";
    const prev2 = tokens[index - 2] ?? "";
    if (buildVerbs.has(prev)) {
      return true;
    }
    if ((prev === "in" || prev === "with" || prev === "on") && buildVerbs.has(prev2)) {
      return true;
    }
  }
  return false;
}

const componentNouns = new Set([
  "form", "forms", "button", "buttons", "template", "templates", "markup", "styling", "styles",
  "snippet", "snippets", "widget", "widgets", "element", "elements", "input", "inputs",
  "validation", "interaction", "interactions",
]);
const productNouns = new Set([
  "page", "pages", "webpage", "site", "sites", "website", "websites", "app", "application",
  "game", "mockup", "mockups", "prototype", "prototypes", "version", "frontend",
]);

function staticPhraseWeight(normalized: string, match: RegExpMatchArray): { weight: number; kind: string } {
  const tail = normalized.slice((match.index ?? 0) + match[0].length);
  const nextWords = tokenize(tail).slice(0, 2);
  if (nextWords.some((word) => componentNouns.has(word))) {
    return { weight: 1, kind: "component-level" };
  }
  if (nextWords.some((word) => productNouns.has(word))) {
    return { weight: 6, kind: "product-level" };
  }
  return { weight: 4, kind: "standalone" };
}

export function resolveStackSuggestion(userRequest: string): StackSuggestion {
  const requestText = intentRelevantRequestText(userRequest);
  const normalized = requestText.toLowerCase().replace(/\s+/g, " ").trim();
  const positive = stripNegatedStackMentions(stripStaticNegations(normalized));
  const tokens = tokenize(positive);

  const signals: string[] = [];
  let staticScore = 0;
  let serverScore = 0;
  const stackScores = new Map<ProjectStack, number>();

  const addStatic = (weight: number, signal: string): void => {
    staticScore += weight;
    signals.push(`${signal} (+${weight} static)`);
  };
  const addServer = (weight: number, signal: string): void => {
    serverScore += weight;
    signals.push(`${signal} (+${weight} non-static)`);
  };
  const addStack = (stack: ProjectStack, weight: number, signal: string): void => {
    stackScores.set(stack, (stackScores.get(stack) ?? 0) + weight);
    signals.push(`${signal} (+${weight} ${stack})`);
  };

  if (/\bnext(?:\.js|js)?\b/.test(positive)) addStack("next", 10, "Next.js named");
  if (/\bvite\b/.test(positive)) addStack("vite-react", 10, "Vite named");
  else if (/\breact\b/.test(positive)) addStack("vite-react", 8, "React named");
  if (/\b(vue|svelte|angular|remix|astro)\b/.test(positive)) addStack("unknown", 8, "frontend framework named (no scaffold target)");
  if (/\bdjango\b/.test(positive)) addStack("python-django", 10, "Django named");
  if (/\bflask\b/.test(positive)) addStack("python-flask", 10, "Flask named");
  if (/\bfastapi\b/.test(positive)) addStack("unknown", 10, "FastAPI named (no scaffold target)");
  if (/\bfastify\b/.test(positive)) addStack("node-express", 10, "Fastify named");
  if (/\bexpress[.\s]?js\b/.test(positive) || anyOccurrenceAnchored(tokens, "express")) {
    addStack("node-express", 10, "Express named (anchored)");
  }
  const nodeCanonical = /\bnode\.?js\b/.test(positive);
  if (nodeCanonical || anyOccurrenceAnchored(tokens, "node")) {
    const cliIntent = /\b(cli|command[-\s]?line|terminal)\b/.test(positive);
    addStack(cliIntent ? "node-cli" : "node-express", 8, `Node.js named${cliIntent ? " with CLI intent" : ""}`);
  }
  if (/\blaravel\b/.test(positive)) addStack("php", 10, "Laravel named");
  else if (/\bphp\b/.test(positive)) addStack("php", 10, "PHP named");
  if (/\bruby on rails\b|\brails\b/.test(positive)) addStack("ruby", 10, "Rails named");
  else if (anyOccurrenceAnchored(tokens, "ruby")) addStack("ruby", 8, "Ruby named (anchored)");
  if (/\bjava\b|\bspring boot\b/.test(positive)) addStack("java", 10, "Java named");
  if (/(?:^|\s)c#(?=$|[\s.,;:!?)])|\bcsharp\b|\bdotnet\b|\basp\.?net\b/.test(positive)) addStack("csharp", 10, "C#/.NET named");
  if (/\bgolang\b/.test(positive) || anyOccurrenceAnchored(tokens, "go")) addStack("go", 8, "Go named (anchored)");
  if (anyOccurrenceAnchored(tokens, "rust")) addStack("rust", 8, "Rust named (anchored)");
  if (/\bpython\b/.test(positive)) {
    const webCompanion = /\b(web|website|site|server|api|backend)\b/.test(positive);
    addStack(webCompanion ? "python-flask" : "python-script", 8, `Python named${webCompanion ? " with web intent" : ""}`);
  }
  if (/\b(matplotlib|pyplot|seaborn|pandas|numpy)\b/.test(positive)) addStack("python-script", 6, "Python data tooling named");
  if (/\bshiny\b/.test(positive)) addStack("r-shiny", 10, "Shiny named");
  if (
    /\br\s+(?:script|plot|chart|graph|visuali[sz]ation|markdown|analysis|programming|language)\b/.test(positive)
    || /\b(?:in|using|with|via)\s+r\b/.test(positive)
  ) {
    addStack("r-script", 8, "R named (anchored)");
  }
  if (/\b(ggplot2?|tidyverse|dplyr|rscript|cran)\b/.test(positive)) addStack("r-script", 6, "R data tooling named");

  const strongStaticPhrase = normalized.match(
    /\b(plain html|html\/css(?:\/js)?|html css(?: js)?|vanilla js|vanilla javascript|static html|single html|single[-\s]?file html|standalone html|no framework|front[-\s]?end[-\s]?only|frontend only|client[-\s]?side only|browser[-\s]?only|no backend|no back[-\s]?end|no server)\b/,
  );
  if (strongStaticPhrase !== null) {
    const { weight, kind } = staticPhraseWeight(normalized, strongStaticPhrase);
    addStatic(weight, `static phrase "${strongStaticPhrase[0]}" (${kind})`);
  }
  if (/\bstatic\s+(?:site|page|version|files?)\b/.test(normalized)) addStatic(5, "static site/page asked");
  if (/\b(localstorage|local storage|indexeddb|sessionstorage)\b/.test(normalized)) addStatic(3, "browser storage named");
  if (/\b(mockups?|wireframes?|prototypes?)\b/.test(normalized)) addStatic(4, "mockup/prototype ask");
  if (/\b(canvas|webgl|glsl|shader)\b/.test(normalized)) addStatic(3, "browser rendering tech named");
  if (/\bsimple\s+(?:web\s*)?page\b|\bsimple\s+webpage\b|\bsimple\s+(?:website|site)\b|\bone[-\s]?page(?:\s+(?:site|website|page))?\b|\bsingle[-\s]?page(?:\s+(?:site|website|page))?\b|\blanding\s+page\b/.test(normalized)) {
    addStatic(3, "simple/landing page phrasing");
  }
  if (/\b(?:create|build|make|generate)\b.*\b(?:web\s*page|webpage|page|site|website)\b.*\b(?:says?|shows?|displays?|contains?)\b/.test(normalized)) {
    addStatic(2, "page-that-displays phrasing");
  }
  if (/\b(?:create|build|make|generate|design)\b[^.!?]*\b(?:web\s?page|html\s+page)\b/.test(normalized)) {
    addStatic(2, "web page artifact ask");
  }

  if (/\bserver[-\s]?(?:rendered|side)\b/.test(positive)) addServer(6, "server-rendered/side asked");
  if (/\b(backend|back[-\s]?end)\b/.test(positive)) addServer(6, "backend asked");
  if (/\bfull[-\s]?stack\b/.test(positive)) addServer(6, "full-stack asked");
  if (/\b(database|sqlite|postgres(?:ql)?|mysql|mongo(?:db)?)\b/.test(positive)) addServer(6, "database named");
  else if (/\bdb\b/.test(positive)) addServer(4, "db named");
  if (/\b(ejs|pug|handlebars|hbs|nunjucks|jinja2?|twig|blade|erb)\b/.test(positive)) {
    addServer(6, "server templating engine named");
    if (/\bjinja2?\b/.test(positive)) addStack("python-flask", 4, "Jinja templating implies Python web");
  }
  if (/\b(?:rest|json|http|web|backend)\s+api\b|\bapi\s+(?:endpoint|route|server)s?\b|\b(?:build|create|implement|expose|add)\s+(?:an?\s+)?api\b/.test(positive)) {
    addServer(6, "API authoring asked");
  } else if (/\bendpoints?\b/.test(positive)) {
    addServer(4, "endpoint named");
  }
  if (/\bform\s+posts?\b|\bhttp\s+(?:post|put|delete)\b|\b(?:post|put|delete)\s+requests?\b|\b(?:posts?|submits?|sends?)\s+(?:data\s+)?to\s+(?:a\s+|the\s+)?(?:server|backend)\b/.test(positive)) {
    addServer(5, "server-handled form submission asked");
  }
  if (/\b(?:save|store|persist)\w*\b[^.!?]{0,40}\b(?:json file|file|disk|database|db)\b/.test(positive)) {
    addServer(4, "persistence to file/database asked");
  }
  if (/\buser accounts?\b/.test(positive)) addServer(5, "user accounts asked");
  if (/\bauth(?:entication)?\b/.test(positive)) addServer(4, "auth asked");
  if (/\blogin\b(?!\s+(?:page|screen|form|ui|mockup|design))/.test(positive)) addServer(4, "login capability asked");
  if (/\b(checkout|cart|payments?)\b/.test(positive)) addServer(4, "commerce flow named");
  if (/\b(web\s+app|app|dashboard|admin|tracker|todo|to-do|kanban|notes?|editor|chat|crm|shop|e[-\s]?commerce)\b/.test(positive)) {
    addServer(2, "app-surface phrasing");
  }
  const routeMentions = positive.match(/(?:^|[\s("'`])\/[a-z][^\s)"'`]*/g);
  if (routeMentions !== null && routeMentions.length >= 2) addServer(3, "multiple URL routes enumerated");
  const numberedItems = positive.match(/(?:^|\s)\d{1,2}[.)]\s/g);
  if (numberedItems !== null && numberedItems.length >= 3) addServer(2, "multi-requirement spec shape");

  const namedRanking = Array.from(stackScores.entries()).sort((left, right) => right[1] - left[1]);
  const namedBest = namedRanking[0] ?? null;
  const totalNonstatic = serverScore + (namedBest?.[1] ?? 0);
  const margin = Math.abs(staticScore - totalNonstatic);
  const confidence: StackSuggestion["confidence"] = margin >= 5 ? "high" : margin >= 2 ? "medium" : "low";

  if (staticScore > totalNonstatic) {
    return {
      stack: "static-html",
      confidence,
      signals,
      alternatives: namedRanking.map(([stack]) => stack).filter((stack) => stack !== "static-html"),
    };
  }
  const stack: ProjectStack = namedBest !== null && namedBest[1] >= 6 ? namedBest[0] : "unknown";
  const alternatives: ProjectStack[] = [
    ...namedRanking.slice(1).map(([candidate]) => candidate),
    ...(staticScore > 0 ? (["static-html"] as ProjectStack[]) : []),
  ];
  return { stack, confidence: totalNonstatic === 0 && staticScore === 0 ? "low" : confidence, signals, alternatives };
}
