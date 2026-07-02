import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveDotnetTargetFramework } from "@/lib/server/runtime/dotnet-resolver";
import { getConfig } from "@/lib/server/config";
import { nextEslintConfig } from "@/lib/server/next-eslint-config";
import { ensureWorkspaceAgentsMd } from "@/lib/server/runtime/agents-md";
import { mutateDatabase } from "@/lib/server/db/file-db";
import { resolveProjectStack, type StackResolutionSource } from "@/lib/server/stack-resolver";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";
import { runMlDoctor } from "@/lib/server/runtime/ml-doctor";
import { logProcess } from "@/lib/server/logging";
import { selectMlScaffold, ML_GITIGNORE } from "@/lib/server/ml/scaffold-sources";
import { classifyProductIntent } from "@/lib/shared/request-intent";
import type { ProjectStack, WorkSessionRecord } from "@/lib/shared/types";

export interface WorkspaceBootstrapResult {
  kind: ProjectStack;
  filesCreated: string[];
  scaffolded: boolean;
  deferred: boolean;
  decisionSource: StackResolutionSource;
}

const ignoredEmptyWorkspaceEntries = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".orchestrator",
  "node_modules",
  ".turbo",
  "__pycache__",
  "AGENTS.md",
  "CLAUDE.md",
]);

async function hasUserWorkspaceContent(workspacePath: string): Promise<boolean> {
  try {
    const entries = await readdir(workspacePath, { withFileTypes: true });
    return entries.some((entry) => !ignoredEmptyWorkspaceEntries.has(entry.name));
  } catch {
    return false;
  }
}

function packageNameFromWorkspace(workspacePath: string): string {
  const basename = path.basename(workspacePath).toLowerCase();
  const normalized = basename.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized : "generated-app";
}

async function writeWorkspaceFile(workspacePath: string, relativePath: string, content: string): Promise<string> {
  const absolutePath = path.join(workspacePath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return relativePath;
}

const nextBuildScript = `const { spawnSync } = require("node:child_process");

const noisyNpmConfigKeys = new Set([
  "npm_config_npm_globalconfig",
  "npm_config_verify_deps_before_run",
  "npm_config__jsr_registry",
]);

const env = { ...process.env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" };
for (const key of Object.keys(env)) {
  const normalized = key.toLowerCase();
  if (normalized === "turbopack" || normalized === "next_runtime" || normalized.startsWith("next_private_") || noisyNpmConfigKeys.has(normalized)) {
    delete env[key];
  }
}

const result = spawnSync(process.execPath, [require.resolve("next/dist/bin/next"), "build"], {
  env,
  stdio: "inherit",
  shell: false,
});

process.exit(result.status ?? 1);
`;

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function baseCss(): string {
  return `:root {
  color-scheme: light;
  --background: #f7f7fb;
  --surface: #ffffff;
  --text: #172033;
  --muted: #5f6b7a;
  --line: #d8dee8;
  --accent: #2563eb;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--background);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

button, input, textarea, select { font: inherit; }

.app-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
}

.starter-panel {
  width: min(680px, 100%);
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  padding: 32px;
}

.eyebrow {
  margin: 0 0 8px;
  color: var(--muted);
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
}

h1 { margin: 0 0 12px; font-size: 2rem; }
p { margin: 0; line-height: 1.5; }
`;
}

function nodeRootPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Generated Express App</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="page-shell">
      <section class="content-panel">
        <p class="eyebrow">Generated workspace</p>
        <h1>Express app ready</h1>
        <p>Use this root page as the starting point for the requested experience.</p>
      </section>
    </main>
    <script src="/script.js"></script>
  </body>
</html>
`;
}

function nodeExpressCss(): string {
  return `:root {
  color-scheme: light;
  --background: #f6f8fb;
  --surface: #ffffff;
  --text: #142033;
  --muted: #5d6b7c;
  --line: #d8e0ea;
  --accent: #176b87;
  --accent-strong: #0f4d64;
  --accent-soft: #e4f4f8;
}

* {
  box-sizing: border-box;
}

body {
  min-height: 100vh;
  margin: 0;
  background: var(--background);
  color: var(--text);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

.page-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  width: min(960px, 100%);
  margin: 0 auto;
  padding: clamp(32px, 8vw, 88px) 20px;
}

.content-panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  padding: clamp(28px, 5vw, 56px);
  box-shadow: 0 18px 44px rgb(20 32 51 / 0.08);
}

.eyebrow {
  margin: 0 0 10px;
  color: var(--accent-strong);
  font-size: 0.8rem;
  font-weight: 800;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 14px;
  font-size: 2.4rem;
  line-height: 1.05;
}

p {
  margin: 0;
  color: var(--muted);
  font-size: 1.05rem;
  line-height: 1.65;
}

@media (max-width: 640px) {
  h1 {
    font-size: 2rem;
  }
}
`;
}

function nodeExpressScript(): string {
  return `"use strict";

console.log("Express app ready");
`;
}

function gitignore(stack: ProjectStack): string {
  const common = `node_modules
dist
.env*.local
`;
  if (stack.startsWith("python")) {
    return `__pycache__
.venv
*.pyc
.env
`;
  }
  if (stack === "r-script" || stack === "r-shiny") {
    return `.rlib
renv/library
.Rproj.user
.Rhistory
.RData
.Ruserdata
.env
`;
  }
  if (stack === "go") return `bin\n*.test\n.env\n`;
  if (stack === "rust") return `target\n.env\n`;
  if (stack === "csharp") return `bin\nobj\n.env\n`;
  if (stack === "java") return `target\n*.class\n.env\n`;
  if (stack === "php") return `vendor\n.env\n`;
  if (stack === "ruby") return `.bundle\nvendor/bundle\n.env\n`;
  return stack === "next" ? `.next\nout\n${common}` : common;
}

async function scaffoldNext(workspacePath: string): Promise<string[]> {
  return Promise.all([
    writeWorkspaceFile(workspacePath, "package.json", json({
      private: true,
      name: packageNameFromWorkspace(workspacePath),
      scripts: {
        dev: "next dev",
        build: "node scripts/build.js",
        start: "next start",
        typecheck: "tsc --noEmit",
        lint: "eslint app components src --no-error-on-unmatched-pattern",
      },
      dependencies: { next: "latest", react: "latest", "react-dom": "latest" },
      devDependencies: {
        "@types/node": "latest",
        "@types/react": "latest",
        "@types/react-dom": "latest",
        eslint: "latest",
        "eslint-config-next": "latest",
        typescript: "latest",
      },
    })),
    writeWorkspaceFile(workspacePath, "scripts/build.js", nextBuildScript),
    writeWorkspaceFile(workspacePath, "tsconfig.json", `{
  "compilerOptions": {
    "target": "es2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
`),
    writeWorkspaceFile(workspacePath, "next-env.d.ts", `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`),
    writeWorkspaceFile(workspacePath, "eslint.config.mjs", nextEslintConfig),
    writeWorkspaceFile(workspacePath, "next.config.js", `/** @type {import('next').NextConfig} */
const appRoot = __dirname;

const nextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  outputFileTracingRoot: appRoot,
  turbopack: {
    root: appRoot,
  },
};

module.exports = nextConfig;
`),
    writeWorkspaceFile(workspacePath, "app/layout.tsx", `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Generated Next App",
  description: "A generated Next.js app",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`),
    writeWorkspaceFile(workspacePath, "app/page.tsx", `export default function Home() {
  return (
    <main className="app-shell">
      <section className="starter-panel">
        <p className="eyebrow">Generated workspace</p>
        <h1>Next.js app ready</h1>
        <p>Use this scaffold as the starting point for the requested interface.</p>
      </section>
    </main>
  );
}
`),
    writeWorkspaceFile(workspacePath, "app/globals.css", baseCss()),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore("next")),
  ]);
}

async function scaffoldStaticHtml(workspacePath: string): Promise<string[]> {
  return Promise.all([
    writeWorkspaceFile(workspacePath, "index.html", `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Generated Web App</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="app-shell">
      <section class="starter-panel">
        <p class="eyebrow">Generated workspace</p>
        <h1>Static app ready</h1>
        <p>Use this scaffold as the starting point for the requested browser experience.</p>
      </section>
    </main>
    <script src="./script.js"></script>
  </body>
</html>
`),
    writeWorkspaceFile(workspacePath, "styles.css", baseCss()),
    writeWorkspaceFile(workspacePath, "script.js", `"use strict";

console.log("Static app ready");
`),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore("static-html")),
  ]);
}

async function scaffoldViteReact(workspacePath: string): Promise<string[]> {
  return Promise.all([
    writeWorkspaceFile(workspacePath, "package.json", json({
      private: true,
      name: packageNameFromWorkspace(workspacePath),
      type: "module",
      scripts: { dev: "vite", build: "tsc --noEmit && vite build", typecheck: "tsc --noEmit" },
      dependencies: { "@vitejs/plugin-react": "latest", vite: "latest", react: "latest", "react-dom": "latest" },
      devDependencies: { typescript: "latest", "@types/react": "latest", "@types/react-dom": "latest" },
    })),
    writeWorkspaceFile(workspacePath, "index.html", `<div id="root"></div><script type="module" src="/src/App.tsx"></script>\n`),
    writeWorkspaceFile(workspacePath, "src/App.tsx", `import "./styles.css";

export default function App() {
  return (
    <main className="app-shell">
      <section className="starter-panel">
        <p className="eyebrow">Generated workspace</p>
        <h1>Vite React app ready</h1>
        <p>Use this scaffold as the starting point for the requested interface.</p>
      </section>
    </main>
  );
}
`),
    writeWorkspaceFile(workspacePath, "src/main.tsx", `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
`),
    writeWorkspaceFile(workspacePath, "src/styles.css", baseCss()),
    writeWorkspaceFile(workspacePath, "tsconfig.json", json({ compilerOptions: { target: "ES2020", useDefineForClassFields: true, lib: ["DOM", "DOM.Iterable", "ES2020"], allowJs: false, skipLibCheck: true, esModuleInterop: true, allowSyntheticDefaultImports: true, strict: true, forceConsistentCasingInFileNames: true, module: "ESNext", moduleResolution: "Node", resolveJsonModule: true, isolatedModules: true, noEmit: true, jsx: "react-jsx" }, include: ["src"] })),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore("vite-react")),
  ]);
}

async function scaffoldNode(workspacePath: string, express: boolean): Promise<string[]> {
  const source = express
    ? `const express = require("express");
const path = require("node:path");

const app = express();
const port = Number(process.env.PORT || 3100);
const publicDir = path.join(__dirname, "..", "public");

app.use(express.static(publicDir, { dotfiles: "allow" }));

app.get("/", (_request, response) => {
  response.sendFile(path.join(publicDir, "index.html"), { dotfiles: "allow" });
});

app.listen(port, () => {
  console.log(\`Server listening on http://127.0.0.1:\${port}\`);
});
`
    : `function main() {
  console.log("Node CLI app ready");
}

main();
`;
  return Promise.all([
    writeWorkspaceFile(workspacePath, "package.json", json({
      private: true,
      name: packageNameFromWorkspace(workspacePath),
      scripts: express
        ? { dev: "node src/server.js", start: "node src/server.js", typecheck: "node --check src/server.js && node --check public/script.js", lint: "node --check src/server.js && node --check public/script.js" }
        : { start: "node src/index.js", typecheck: "node --check src/index.js", lint: "node --check src/index.js" },
      dependencies: express ? { express: "latest" } : {},
      devDependencies: {},
    })),
    writeWorkspaceFile(workspacePath, express ? "src/server.js" : "src/index.js", source),
    ...(express
      ? [
          writeWorkspaceFile(workspacePath, "public/index.html", nodeRootPage()),
          writeWorkspaceFile(workspacePath, "public/styles.css", nodeExpressCss()),
          writeWorkspaceFile(workspacePath, "public/script.js", nodeExpressScript()),
        ]
      : []),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore(express ? "node-express" : "node-cli")),
  ]);
}

function requestMentionsFastApi(userRequest: string): boolean {
  return /\bfastapi\b/i.test(userRequest);
}

async function scaffoldPython(workspacePath: string, stack: ProjectStack, userRequest = ""): Promise<string[]> {
  if (stack === "python-flask") {
    if (requestMentionsFastApi(userRequest)) {
      return Promise.all([
        writeWorkspaceFile(workspacePath, "app.py", `from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates


BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

app = FastAPI()
app.mount("/static", StaticFiles(directory=str(STATIC_DIR), check_dir=False), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/api/health")
async def health():
    return JSONResponse({"status": "ok", "message": "FastAPI app ready"})
`),
        writeWorkspaceFile(workspacePath, "templates/index.html", `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Generated FastAPI App</title>
    <link rel="stylesheet" href="/static/styles.css" />
  </head>
  <body>
    <main class="app-shell">
      <section class="starter-panel">
        <p class="eyebrow">Generated workspace</p>
        <h1>FastAPI full-stack app ready</h1>
        <p>Use this scaffold as the starting point for the requested backend and frontend experience.</p>
        <button type="button" id="health-check">Check backend</button>
        <p id="health-result" class="muted" aria-live="polite"></p>
      </section>
    </main>
    <script src="/static/app.js"></script>
  </body>
</html>
`),
        writeWorkspaceFile(workspacePath, "static/styles.css", `${baseCss()}

.starter-panel button {
  margin-top: 18px;
  border: 0;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  padding: 10px 14px;
  cursor: pointer;
}

.muted {
  margin-top: 12px;
  color: var(--muted);
}
`),
        writeWorkspaceFile(workspacePath, "static/app.js", `"use strict";

const button = document.getElementById("health-check");
const output = document.getElementById("health-result");

button?.addEventListener("click", async () => {
  if (!output) return;
  output.textContent = "Checking...";
  const response = await fetch("/api/health");
  const data = await response.json();
  output.textContent = data.message ?? data.status ?? "Backend responded";
});
`),
        writeWorkspaceFile(workspacePath, "requirements.txt", "fastapi\nuvicorn\njinja2\n"),
        writeWorkspaceFile(workspacePath, ".gitignore", gitignore(stack)),
      ]);
    }
    return Promise.all([
      writeWorkspaceFile(workspacePath, "app.py", `from flask import Flask, jsonify, render_template

app = Flask(__name__)


@app.get("/")
def home():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "message": "Flask app ready"})


if __name__ == "__main__":
    import os
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "3100")), debug=True)
`),
      writeWorkspaceFile(workspacePath, "templates/index.html", `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Generated Flask App</title>
    <link rel="stylesheet" href="{{ url_for('static', filename='styles.css') }}" />
  </head>
  <body>
    <main class="app-shell">
      <section class="starter-panel">
        <p class="eyebrow">Generated workspace</p>
        <h1>Flask full-stack app ready</h1>
        <p>Use this scaffold as the starting point for the requested backend and frontend experience.</p>
        <button type="button" id="health-check">Check backend</button>
        <p id="health-result" class="muted" aria-live="polite"></p>
      </section>
    </main>
    <script src="{{ url_for('static', filename='app.js') }}"></script>
  </body>
</html>
`),
      writeWorkspaceFile(workspacePath, "static/styles.css", `${baseCss()}

.starter-panel button {
  margin-top: 18px;
  border: 0;
  border-radius: 6px;
  background: var(--accent);
  color: #fff;
  padding: 10px 14px;
  cursor: pointer;
}

.muted {
  margin-top: 12px;
  color: var(--muted);
}
`),
      writeWorkspaceFile(workspacePath, "static/app.js", `"use strict";

const button = document.getElementById("health-check");
const output = document.getElementById("health-result");

button?.addEventListener("click", async () => {
  if (!output) return;
  output.textContent = "Checking...";
  const response = await fetch("/api/health");
  const data = await response.json();
  output.textContent = data.message ?? data.status ?? "Backend responded";
});
`),
      writeWorkspaceFile(workspacePath, "requirements.txt", "flask\n"),
      writeWorkspaceFile(workspacePath, ".gitignore", gitignore(stack)),
    ]);
  }
  if (stack === "python-django") {
    return Promise.all([
      writeWorkspaceFile(workspacePath, "manage.py", `#!/usr/bin/env python
import os
import sys


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "generated_project.settings")
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
`),
      writeWorkspaceFile(workspacePath, "generated_project/__init__.py", ""),
      writeWorkspaceFile(workspacePath, "generated_project/settings.py", `from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = "generated-dev-key"
DEBUG = True
ROOT_URLCONF = "generated_project.urls"
ALLOWED_HOSTS = ["*"]
INSTALLED_APPS = [
    "django.contrib.staticfiles",
]
MIDDLEWARE = []
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {},
    }
]
STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "static"]
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
`),
      writeWorkspaceFile(workspacePath, "generated_project/urls.py", `from django.http import JsonResponse
from django.urls import path


def home(_request):
    return JsonResponse({"message": "Django app ready"})


urlpatterns = [path("", home)]
`),
      writeWorkspaceFile(workspacePath, "static/.gitkeep", ""),
      writeWorkspaceFile(workspacePath, "requirements.txt", "django\n"),
      writeWorkspaceFile(workspacePath, ".gitignore", gitignore(stack)),
    ]);
  }
  return Promise.all([
    writeWorkspaceFile(workspacePath, "main.py", `def main():
    print("Python script ready")


if __name__ == "__main__":
    main()
`),
    writeWorkspaceFile(workspacePath, "requirements.txt", ""),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore(stack)),
  ]);
}

async function scaffoldPythonMl(workspacePath: string, userRequest = ""): Promise<string[]> {
  let torchAvailable = false;
  try {
    const doctor = await runMlDoctor();
    const config = getConfig();
    const installable = config.mlAllowNetworkDownloads
      && (doctor.diskFreeMb === null || doctor.diskFreeMb >= config.mlTorchScaffoldMinDiskMb);
    torchAvailable = doctor.torch.installed || installable;
  } catch {
    torchAvailable = false;
  }
  const scaffold = selectMlScaffold(userRequest, { torchAvailable });
  let readme = scaffold.readme;
  if (scaffold.degradedFrom !== null) {
    logProcess("warn", "experiment.scaffold.degraded", {
      workspacePath,
      degradedFrom: scaffold.degradedFrom,
      scaffoldKind: scaffold.kind,
      reason: "Host PyTorch is unavailable; scaffolded a CPU classical baseline instead of the requested technique.",
    });
    readme = `> **Heads up — technique downgraded.** The requested GPU/torch technique (\`${scaffold.degradedFrom}\`) was replaced with a CPU classical baseline because PyTorch is not available on this host. Install a torch-capable environment (and set \`ML_ALLOW_GPU=true\` for GPU) to scaffold the full technique.

${readme}`;
  }
  const manifest = {
    kind: scaffold.kind,
    entrypoint: scaffold.entrypoint,
    metrics: scaffold.metrics,
    summary: scaffold.summary,
    ...(scaffold.predict != null ? { predict: scaffold.predict } : {}),
    data: scaffold.data,
  };
  const writes: Array<Promise<string>> = scaffold.files.map((file) =>
    writeWorkspaceFile(workspacePath, file.path, file.content),
  );
  writes.push(writeWorkspaceFile(workspacePath, "requirements.txt", scaffold.requirements));
  writes.push(writeWorkspaceFile(workspacePath, "experiment.json", `${JSON.stringify(manifest, null, 2)}
`));
  writes.push(writeWorkspaceFile(workspacePath, ".gitignore", ML_GITIGNORE));
  writes.push(writeWorkspaceFile(workspacePath, "README.md", readme));
  return Promise.all(writes);
}

async function scaffoldR(workspacePath: string, stack: ProjectStack): Promise<string[]> {
  if (stack === "r-shiny") {
    return Promise.all([
      writeWorkspaceFile(workspacePath, "app.R", `library(shiny)

ui <- fluidPage(
  titlePanel("Generated Shiny app"),
  sidebarLayout(
    sidebarPanel(
      sliderInput("bins", "Number of bins:", min = 5, max = 50, value = 20)
    ),
    mainPanel(
      plotOutput("distPlot")
    )
  )
)

server <- function(input, output, session) {
  output$distPlot <- renderPlot({
    x <- faithful$waiting
    hist(x, breaks = input$bins, col = "#2563eb", border = "white",
         main = "Waiting times", xlab = "Minutes")
  })
}

shinyApp(ui = ui, server = server)
`),
      writeWorkspaceFile(workspacePath, "DESCRIPTION", `Package: generatedapp
Type: Shiny
Title: Generated Shiny App
Version: 0.0.1
Description: Generated by the orchestrator.
Imports:
    shiny
`),
      writeWorkspaceFile(workspacePath, ".gitignore", gitignore(stack)),
    ]);
  }
  return Promise.all([
    writeWorkspaceFile(workspacePath, "main.R", `# Generated R script. Print or ggsave() any plot you want shown in the preview.
main <- function() {
  x <- seq(-10, 10, length.out = 200)
  y <- x^2
  plot(x, y, type = "l", col = "#2563eb", lwd = 2,
       main = "Generated R script", xlab = "x", ylab = "x^2")
  cat("R script ready\\n")
}

main()
`),
    writeWorkspaceFile(workspacePath, "DESCRIPTION", `Package: generatedapp
Type: Script
Title: Generated R Script
Version: 0.0.1
Description: Generated by the orchestrator.
`),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore(stack)),
  ]);
}

async function scaffoldGo(workspacePath: string): Promise<string[]> {
  const moduleName = packageNameFromWorkspace(workspacePath).replace(/-/g, "");
  return Promise.all([
    writeWorkspaceFile(workspacePath, "go.mod", `module ${moduleName}

go 1.22
`),
    writeWorkspaceFile(workspacePath, "main.go", `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

func main() {
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3100"
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "Go app ready"})
	})
	log.Printf("Server listening on http://%s:%s", host, port)
	log.Fatal(http.ListenAndServe(host+":"+port, nil))
}
`),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore("go")),
  ]);
}

async function scaffoldRust(workspacePath: string): Promise<string[]> {
  return Promise.all([
    writeWorkspaceFile(workspacePath, "Cargo.toml", `[package]
name = "${packageNameFromWorkspace(workspacePath).replace(/-/g, "_")}"
version = "0.1.0"
edition = "2021"

[dependencies]
`),
    writeWorkspaceFile(workspacePath, "src/main.rs", `use std::env;
use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = env::var("PORT").unwrap_or_else(|_| "3100".to_string());
    let listener = TcpListener::bind(format!("{host}:{port}")).expect("bind http listener");
    println!("Server listening on http://{host}:{port}");

    for stream in listener.incoming() {
        let mut stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                eprintln!("connection failed: {error}");
                continue;
            }
        };
        let mut buffer = [0; 1024];
        let _ = stream.read(&mut buffer);
        let body = r#"{"message":"Rust app ready"}"#;
        let response = format!(
            "HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: {}\\r\\nConnection: close\\r\\n\\r\\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
    }
}
`),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore("rust")),
  ]);
}

function csharpProjectName(workspacePath: string): string {
  const name = packageNameFromWorkspace(workspacePath).replace(/[^a-zA-Z0-9_]/g, "");
  if (name.length === 0) {
    return "GeneratedApp";
  }
  return /^[A-Za-z_]/.test(name) ? name : `App${name}`;
}

function isCsharpRazorPagesRequest(userRequest: string): boolean {
  const normalized = userRequest.toLowerCase().replace(/\s+/g, " ").trim();
  const intent = classifyProductIntent(userRequest);
  const explicitRazorSurface = /\b(razor|mvc|server[-\s]?rendered|server[-\s]?side rendering|ssr|web\s*page|webpage|page|pages|site|website|form|html)\b/.test(normalized);
  const explicitApiOnly = /\b(api|endpoint|json|backend service|backend only|back[-\s]?end only)\b/.test(normalized) && !explicitRazorSurface;
  if (explicitApiOnly) {
    return false;
  }
  return explicitRazorSurface || intent.productShape === "server-rendered-web" || intent.productShape === "fullstack-web";
}

async function scaffoldCsharp(workspacePath: string, userRequest = ""): Promise<string[]> {
  const name = csharpProjectName(workspacePath);
  const targetFramework = await resolveDotnetTargetFramework();
  const commonFiles = [
    writeWorkspaceFile(workspacePath, `${name}.csproj`, `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>${targetFramework}</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
`),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore("csharp")),
  ];

  if (isCsharpRazorPagesRequest(userRequest)) {
    return Promise.all([
      ...commonFiles,
      writeWorkspaceFile(workspacePath, "Program.cs", `var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorPages();

var app = builder.Build();

app.UseStaticFiles();
app.UseRouting();
app.MapRazorPages();

var host = Environment.GetEnvironmentVariable("HOST") ?? "127.0.0.1";
var port = Environment.GetEnvironmentVariable("PORT") ?? "3100";
app.Run($"http://{host}:{port}");
`),
      writeWorkspaceFile(workspacePath, "Pages/_ViewImports.cshtml", `@namespace ${name}.Pages
@addTagHelper *, Microsoft.AspNetCore.Mvc.TagHelpers
`),
      writeWorkspaceFile(workspacePath, "Pages/Index.cshtml", `@page
@model IndexModel
@{
    ViewData["Title"] = "Home";
}

<link rel="stylesheet" href="~/css/site.css" />

<main class="page">
    <section class="panel">
        <p class="eyebrow">ASP.NET Core</p>
        <h1>Server-rendered page ready</h1>
        <p>This Razor Page is rendered on the server and is ready to customize.</p>
    </section>
</main>
`),
      writeWorkspaceFile(workspacePath, "Pages/Index.cshtml.cs", `using Microsoft.AspNetCore.Mvc.RazorPages;

namespace ${name}.Pages;

public class IndexModel : PageModel
{
    public void OnGet()
    {
    }
}
`),
      writeWorkspaceFile(workspacePath, "wwwroot/css/site.css", baseCss()),
    ]);
  }

  return Promise.all([
    ...commonFiles,
    writeWorkspaceFile(workspacePath, "Program.cs", `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/", () => Results.Json(new { message = "ASP.NET Core app ready" }));

var host = Environment.GetEnvironmentVariable("HOST") ?? "127.0.0.1";
var port = Environment.GetEnvironmentVariable("PORT") ?? "3100";
app.Run($"http://{host}:{port}");
`),
  ]);
}

async function scaffoldJava(workspacePath: string): Promise<string[]> {
  return Promise.all([
    writeWorkspaceFile(workspacePath, "Main.java", `import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;

public class Main {
  public static void main(String[] args) throws Exception {
    String host = System.getenv().getOrDefault("HOST", "127.0.0.1");
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "3100"));
    HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
    server.createContext("/", exchange -> {
      byte[] body = "{\\"message\\":\\"Java app ready\\"}".getBytes();
      exchange.getResponseHeaders().add("Content-Type", "application/json");
      exchange.sendResponseHeaders(200, body.length);
      try (OutputStream output = exchange.getResponseBody()) {
        output.write(body);
      }
    });
    server.start();
    System.out.println("Server listening on http://" + host + ":" + port);
  }
}
`),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore("java")),
  ]);
}

async function scaffoldPhp(workspacePath: string): Promise<string[]> {
  return Promise.all([
    writeWorkspaceFile(workspacePath, "composer.json", json({
      name: `local/${packageNameFromWorkspace(workspacePath)}`,
      type: "project",
      require: {},
      scripts: { test: "php -l public/index.php" },
    })),
    writeWorkspaceFile(workspacePath, "public/index.php", `<?php
header('Content-Type: application/json');
echo json_encode(['message' => 'PHP app ready']);
`),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore("php")),
  ]);
}

function isLaravelRequest(userRequest: string): boolean {
  return /\blaravel\b/i.test(userRequest);
}

async function scaffoldLaravel(workspacePath: string): Promise<string[]> {
  const packageName = packageNameFromWorkspace(workspacePath);
  return Promise.all([
    writeWorkspaceFile(workspacePath, "composer.json", json({
      name: `local/${packageName}`,
      type: "project",
      require: {
        "laravel/framework": "^12.0",
      },
      autoload: {
        "psr-4": {
          "App\\": "app/",
        },
      },
      scripts: {
        test: "php -l public/index.php",
      },
    })),
    writeWorkspaceFile(workspacePath, "public/index.php", `<?php

use Illuminate\\Foundation\\Application;
use Illuminate\\Http\\Request;

define('LARAVEL_START', microtime(true));

require __DIR__ . '/../vendor/autoload.php';

/** @var Application $app */
$app = require __DIR__ . '/../bootstrap/app.php';

$app->handleRequest(Request::capture());
`),
    writeWorkspaceFile(workspacePath, "bootstrap/app.php", `<?php

use Illuminate\\Cookie\\CookieServiceProvider;
use Illuminate\\Encryption\\EncryptionServiceProvider;
use Illuminate\\Filesystem\\FilesystemServiceProvider;
use Illuminate\\Foundation\\Application;
use Illuminate\\Foundation\\Configuration\\Exceptions;
use Illuminate\\Foundation\\Configuration\\Middleware;
use Illuminate\\Session\\SessionServiceProvider;
use Illuminate\\Translation\\TranslationServiceProvider;
use Illuminate\\Validation\\ValidationServiceProvider;
use Illuminate\\View\\ViewServiceProvider;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: null,
        then: function (): void {
        }
    )
    ->withProviders([
        CookieServiceProvider::class,
        EncryptionServiceProvider::class,
        FilesystemServiceProvider::class,
        SessionServiceProvider::class,
        TranslationServiceProvider::class,
        ValidationServiceProvider::class,
        ViewServiceProvider::class,
    ])
    ->withExceptions(function (Exceptions $exceptions): void {
    })
    ->withMiddleware(function (Middleware $middleware): void {
    })
    ->create();
`),
    writeWorkspaceFile(workspacePath, "routes/web.php", `<?php

use Illuminate\\Support\\Facades\\Route;

Route::get('/', function () {
    return view('welcome');
});
`),
    writeWorkspaceFile(workspacePath, "resources/views/welcome.blade.php", `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Laravel App</title>
    <link rel="stylesheet" href="/styles.css">
</head>
<body>
    <main class="shell">
        <h1>Laravel app ready</h1>
        <p>The server-rendered Laravel preview is running.</p>
    </main>
</body>
</html>
`),
    writeWorkspaceFile(workspacePath, "public/styles.css", `:root {
    color-scheme: light;
    font-family: Arial, Helvetica, sans-serif;
    background: #f6f7f9;
    color: #1f2937;
}

body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
}

.shell {
    width: min(720px, calc(100% - 32px));
    padding: 32px;
    background: #ffffff;
    border: 1px solid #d9dee7;
    border-radius: 8px;
    box-shadow: 0 20px 45px rgba(15, 23, 42, 0.08);
}

h1 {
    margin: 0 0 10px;
    font-size: 32px;
}

p {
    margin: 0;
    line-height: 1.6;
}
`),
    writeWorkspaceFile(workspacePath, ".env", `APP_NAME=Laravel
APP_ENV=local
APP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
APP_DEBUG=true
APP_URL=http://localhost

LOG_CHANNEL=stack
SESSION_DRIVER=file
SESSION_LIFETIME=120
`),
    writeWorkspaceFile(workspacePath, ".env.example", `APP_NAME=Laravel
APP_ENV=local
APP_KEY=
APP_DEBUG=true
APP_URL=http://localhost

LOG_CHANNEL=stack
SESSION_DRIVER=file
SESSION_LIFETIME=120
`),
    writeWorkspaceFile(workspacePath, "storage/app/.gitkeep", ""),
    writeWorkspaceFile(workspacePath, "storage/framework/cache/data/.gitkeep", ""),
    writeWorkspaceFile(workspacePath, "storage/framework/sessions/.gitkeep", ""),
    writeWorkspaceFile(workspacePath, "storage/framework/testing/.gitkeep", ""),
    writeWorkspaceFile(workspacePath, "storage/framework/views/.gitkeep", ""),
    writeWorkspaceFile(workspacePath, "storage/logs/.gitkeep", ""),
    writeWorkspaceFile(workspacePath, "bootstrap/cache/.gitkeep", ""),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore("php")),
  ]);
}

async function scaffoldRuby(workspacePath: string): Promise<string[]> {
  return Promise.all([
    writeWorkspaceFile(workspacePath, "Gemfile", `source "https://rubygems.org"
`),
    writeWorkspaceFile(workspacePath, "app.rb", `require "json"
require "webrick"

host = ENV.fetch("HOST", "127.0.0.1")
port = Integer(ENV.fetch("PORT", "3100"))
server = WEBrick::HTTPServer.new(Host: host, Port: port)

server.mount_proc "/" do |_request, response|
  response["Content-Type"] = "application/json"
  response.body = JSON.generate(message: "Ruby app ready")
end

trap("INT") { server.shutdown }
server.start
`),
    writeWorkspaceFile(workspacePath, ".gitignore", gitignore("ruby")),
  ]);
}

async function scaffoldWorkspace(workspacePath: string, stack: ProjectStack, userRequest = ""): Promise<string[]> {
  if (stack === "next") return scaffoldNext(workspacePath);
  if (stack === "static-html") return scaffoldStaticHtml(workspacePath);
  if (stack === "vite-react") return scaffoldViteReact(workspacePath);
  if (stack === "node-express") return scaffoldNode(workspacePath, true);
  if (stack === "node-cli") return scaffoldNode(workspacePath, false);
  if (stack === "python-ml") return scaffoldPythonMl(workspacePath, userRequest);
  if (stack === "python-script" || stack === "python-flask" || stack === "python-django") return scaffoldPython(workspacePath, stack, userRequest);
  if (stack === "r-script" || stack === "r-shiny") return scaffoldR(workspacePath, stack);
  if (stack === "go") return scaffoldGo(workspacePath);
  if (stack === "rust") return scaffoldRust(workspacePath);
  if (stack === "csharp") return scaffoldCsharp(workspacePath, userRequest);
  if (stack === "java") return scaffoldJava(workspacePath);
  if (stack === "php") return isLaravelRequest(userRequest) ? scaffoldLaravel(workspacePath) : scaffoldPhp(workspacePath);
  if (stack === "ruby") return scaffoldRuby(workspacePath);
  return scaffoldNext(workspacePath);
}

export interface RescaffoldResult {
  rescaffolded: boolean;
  reason: string;
  filesCreated: string[];
}

async function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dirAbs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (rel === "" && ignoredEmptyWorkspaceEntries.has(entry.name)) {
        continue;
      }
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(dirAbs, entry.name), childRel);
      } else {
        results.push(childRel);
      }
    }
  }
  await walk(workspacePath, "");
  return results;
}

export async function rescaffoldWorkspaceForStack(workSession: WorkSessionRecord, stack: ProjectStack): Promise<RescaffoldResult> {
  const workspacePath = workSession.activeWorktreePath;
  await assertSafeWorkspace(workspacePath, { operation: "workspace re-scaffold" });
  const manifest = new Set((workSession.scaffoldManifest ?? []).map((entry) => entry.replace(/\\/g, "/")));
  const existing = await listWorkspaceFiles(workspacePath);
  if (manifest.size === 0) {
    if (existing.length > 0) {
      return { rescaffolded: false, reason: "No scaffold manifest is recorded for this workspace, so the existing files were left unchanged.", filesCreated: [] };
    }
  } else {
    const foreign = existing.filter((file) => !manifest.has(file));
    if (foreign.length > 0) {
      return {
        rescaffolded: false,
        reason: `Workspace already has non-scaffold content (${foreign.slice(0, 3).join(", ")}${foreign.length > 3 ? ", …" : ""}); files were left unchanged.`,
        filesCreated: [],
      };
    }
    for (const entry of manifest) {
      await rm(path.join(workspacePath, entry), { force: true });
    }
  }
  const filesCreated = await scaffoldWorkspace(workspacePath, stack, workSession.lastUserMessage);
  await ensureWorkspaceAgentsMd(workspacePath);
  return { rescaffolded: true, reason: "", filesCreated };
}

export async function bootstrapWorkspaceIfNeeded(
  workSession: WorkSessionRecord,
  options: { deferLowConfidenceDefault?: boolean } = {},
): Promise<WorkspaceBootstrapResult | null> {
  const workspacePath = workSession.activeWorktreePath;
  await assertSafeWorkspace(workspacePath, { operation: "workspace bootstrap" });
  await mkdir(workspacePath, { recursive: true });
  await ensureWorkspaceAgentsMd(workspacePath);

  const config = getConfig();
  const resolution = await resolveProjectStack({
    userRequest: workSession.lastUserMessage,
    workspacePath,
    defaultStack: config.defaultProjectStack,
  });

  if (await hasUserWorkspaceContent(workspacePath)) {
    await recordStackDecision(workSession, resolution.stack, "workspace", resolution.confidence, resolution.reason, null);
    return null;
  }

  if (options.deferLowConfidenceDefault === true && resolution.source === "default") {
    await recordStackDecision(workSession, resolution.stack, "heuristic", resolution.confidence, resolution.reason, null);
    return { kind: resolution.stack, filesCreated: [], scaffolded: false, deferred: true, decisionSource: resolution.source };
  }

  const filesCreated = await scaffoldWorkspace(workspacePath, resolution.stack, workSession.lastUserMessage);
  await recordStackDecision(workSession, resolution.stack, "heuristic", resolution.confidence, resolution.reason, filesCreated);
  return { kind: resolution.stack, filesCreated, scaffolded: true, deferred: false, decisionSource: resolution.source };
}

async function recordStackDecision(
  workSession: WorkSessionRecord,
  stack: ProjectStack,
  source: "heuristic" | "workspace",
  confidence: "high" | "medium" | "low",
  rationale: string,
  filesCreated: string[] | null,
): Promise<void> {
  await mutateDatabase((db) => {
    const session = db.workSessions.find((candidate) => candidate.id === workSession.id);
    if (session === undefined) {
      return;
    }
    const existing = session.stackDecision ?? null;
    if (existing === null || existing.source === "heuristic" || existing.source === "workspace") {
      session.stackDecision = {
        stack,
        source,
        confidence,
        rationale,
        decidedAt: new Date().toISOString(),
      };
    }
    if (filesCreated !== null) {
      session.scaffoldManifest = filesCreated;
    }
  });
}
