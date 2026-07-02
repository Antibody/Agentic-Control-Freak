import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeWorkspace } from "@/lib/server/workspace-safety";

const beginMarker = "<!-- CLOSED_DEV_LOOP_ORCHESTRATOR_RULES:BEGIN -->";
const endMarker = "<!-- CLOSED_DEV_LOOP_ORCHESTRATOR_RULES:END -->";

const managedRules = `## Closed Dev Loop Orchestrator Rules

These rules are managed by the local orchestrator. Preserve user/project instructions elsewhere in this file.

- Work directly in this workspace when a task requires code changes.
- Do not edit the orchestrator/control-plane app outside this workspace.
- Do not start long-running dev servers. If a generated app needs preview support, configure it for a non-control-plane port such as 3100 or higher. The orchestrator owns previews.
- Do not run package-manager install commands, full production builds, or long-running verification commands unless the current task explicitly requests that. The orchestrator installs dependencies and runs formal verification.
- The orchestrator keeps node_modules in sync with package.json between tasks. When node_modules is present, run the project's fast static self-check (the typecheck script if one exists, otherwise the closest cheap equivalent) over your changes before declaring a coding task complete and fix every error it reports - type errors that survive a task are only discovered at the formal verification gate, where each one costs a full repair cycle. If node_modules is missing, skip the self-check; never run installs yourself.
- If this workspace already contains a scaffold, keep its routing style and established asset paths. Package versions, build scripts, and verification scripts may be updated when the orchestrator dependency research report recommends newer compatible tooling before coding.
- Do not import, require, dynamically import, or CSS-import any package that is not declared in package.json.
- Do not use classes or directives from a CSS framework unless that framework is already declared and configured in the workspace. When no styling framework is declared, use local class names and plain CSS rules in the existing stylesheet.
- Write CSS that is clean under common PostCSS/Autoprefixer pipelines. For flexbox alignment, prefer broadly supported values such as flex-start and flex-end over bare logical start/end values unless the existing codebase already uses logical alignment intentionally.
- For Next.js apps, browser-only modules that access window, document, navigator, canvas, maps, media APIs, or other DOM globals at module scope must not be imported directly by a prerendered route. Isolate them behind next/dynamic with { ssr: false } or an equivalent client-only wrapper so production builds remain safe when the user explicitly requests one.
- For Next.js App Router route handlers and dynamic pages, params and searchParams are async: type them as a Promise and await them (for example { params }: { params: Promise<{ id: string }> }). Next generates a dev/build type validator that fails synchronous signatures.
- Do not use "next lint" in lint scripts; its CLI options were removed in modern Next. Script lint as a direct eslint invocation over the source directories (for example "eslint app components src lib --no-error-on-unmatched-pattern").
- Modern Next dev servers block cross-origin requests to dev resources, so a server started on localhost serves a dead, never-hydrating page when opened via 127.0.0.1 (client-side fetch fails with "Failed to fetch"). In next.config set allowedDevOrigins: ["127.0.0.1", "localhost"] so the app works on either loopback hostname, and when the project lives inside a nested workspace also pin turbopack: { root: __dirname } so parent-directory lockfiles do not mislead workspace-root inference.
- Importing "server-only" or "client-only" requires declaring that package in package.json like any other dependency.
- Only add eslint plugins whose peer range supports the declared eslint major version; incompatible plugins fail at install time (peer conflicts) or at lint time ("Error while loading rule ... is not a function"). With modern eslint majors prefer a minimal flat config built on typescript-eslint and the framework's own config package instead of legacy plugins, and declare every package the config file imports.
- In Next.js App Router, never pass functions (event handlers, callbacks) as props from a server component to a client component; the boundary only accepts serializable data. Move the interactive subtree into a "use client" component or pass plain data and define handlers inside the client component.
- Keep server-rendered output deterministic: never render Date.now(), Math.random(), locale/timezone-dependent formatting, or other run-variable values directly in server-rendered text - they cause hydration mismatch errors. Compute such values in a client component after mount, or pass a stable value from the data layer.
- Never weaken verification to make it pass: do not exclude application source from lint or typecheck via ignore patterns, eslint ignores, or tsconfig excludes, and do not delete or stub verification scripts. Fix the underlying code instead. A verification script that exists but cannot run counts as a failure, not an exemption.
- Never launch detached or new-window processes: no PowerShell Start-Process, no cmd "start", no -WindowStyle flags, no background "&" daemons. They open visible console windows on the user's desktop and leave orphaned servers holding ports after your turn ends.
- Never leave a server or listener running when your command finishes: the orchestrator owns app previews and smoke runs. To verify HTTP behavior yourself, exercise the exported app in-process on an ephemeral port (keep the app importable without listening), or run the server in the FOREGROUND with a bounded timeout and stop it before finishing. Every process you start must be gone when your turn ends.
- Never stream live server output into workspace files (temp_out.txt and similar) as a monitoring channel; capture bounded output from the foreground process instead, and delete any temporary files you created before finishing.
- Declare dependency versions only from the dependency research report or the existing lockfile; never invent a version number from memory. If unsure, use a caret range of the latest version named in the research report.
- When declaring a library together with its framework binding or wrapper (for example chart.js with react-chartjs-2, or any "react-x" / "vue-x" package wrapping library x), the binding's peerDependencies decide the base library's version - the latest majors of the two packages are often incompatible. Declare the base library inside the binding's peer range. If npm install fails with ERESOLVE naming a peer range, fix the root package.json declaration to satisfy that range; never use --force or --legacy-peer-deps.
- Every routed page must be reachable through visible same-origin links starting from the home page. Dynamic routes (for example /items/[id]) must have at least one concrete linked instance: wherever the matching entities are listed, render their names or titles as links to the detail page. The inverse also holds: never render an internal link whose target route does not resolve - intermediate tree or category nodes either get a real route or are rendered as non-link labels. Runtime verification checks both link reachability for every planned route and that rendered internal links do not 404.
- Some library APIs return a union of sync and async results depending on configuration (for example marked's parse returns string | Promise<string>). Pin the sync path explicitly (such as marked.parse(text, { async: false })) or await the result before passing it to a consumer that requires a plain value; never cast the union away.
- Never end TypeScript import paths with .ts or .tsx unless tsconfig explicitly sets allowImportingTsExtensions (TS5097 otherwise fails typecheck). Use extensionless relative imports everywhere, including test files - ESM-style explicit extensions from Deno/Node examples do not transfer to bundler-resolution tsconfigs.
- For static or vanilla Node apps, use existing shared asset paths consistently across every HTML page instead of inventing new css/js directories.
- For server apps, the package.json dev and start commands must launch the HTTP server and keep it serving - a compiler in watch mode alone is not a dev command. When the build compiles into an output directory, derive the entrypoint path from the real emitted layout (a tsconfig whose rootDir spans src emits dist/src/server.js, not dist/server.js), and resolve runtime directories such as view templates, static assets, and data files from the project root or relative to the compiled module location so lookups still resolve after compilation. After creating or changing the server bootstrap, build scripts, or compiler output settings, prove the boot chain once before finishing: run the dev command in the foreground with a bounded timeout, confirm the home page returns HTTP 200, then stop the process (per the foreground-server rule above).
- A clean checkout plus the documented boot command must yield the complete product: run schema setup/migrations AND load any seed, sample, or starter data the product calls for automatically and idempotently during startup (a framework startup hook, a post-migrate signal, or the dev command chaining the steps). Never gate required data behind a separately documented manual command - automated verification, previews, and the user's first boot only ever run the boot command, so a manual-only seed step ships an empty product. Wire the data load through a mechanism that provably fires: a custom Django runserver command is silently overridden by any app listed earlier in INSTALLED_APPS (django.contrib.staticfiles also overrides runserver), so prefer a post_migrate signal or an AppConfig.ready guard - then boot once and confirm the data exists before completing.
- Generate bulk, sample, or seed data programmatically - loops, factories, comprehensions, or parameterized templates over a small list of base values - never as long runs of repeated literal rows or copy-pasted blocks. Hundreds of near-identical literal lines bloat the file, and emitting them token by token is how generation runs away mid-edit. A seed file should read as a handful of distinct examples plus code that multiplies them.
- The orchestrator displays the running app inside an iframe served from a DIFFERENT loopback origin, so generated apps must never send frame-blocking response headers: no X-Frame-Options (SAMEORIGIN still blocks cross-origin embedding) and no Content-Security-Policy frame-ancestors that excludes loopback origins. In Django remove django.middleware.clickjacking.XFrameOptionsMiddleware from MIDDLEWARE; with Express/helmet disable frameguard and the frame-ancestors directive. Clickjacking protection is meaningless for a loopback-only development preview.
- Never serve the project root as a static directory (express.static(process.cwd()), express.static("."), or any framework equivalent): it exposes source, config, and data files, and a root index.html silently shadows the routed home page because static middleware answers before the routers. Serve a dedicated assets subdirectory (public/ or static/), mount it on an explicit prefix, and delete leftover scaffold pages (root index.html and its css/js) that the final server-rendered app does not serve.
- For Express apps that serve generated HTML files with response.sendFile, pass { dotfiles: "allow" } or an equivalent safe file-serving approach so pages under hidden workspace directories such as .workspace are not rejected as dotfiles.
- For ASP.NET Core Razor Pages, preserve or create Pages/_ViewImports.cshtml with @namespace <ProjectName>.Pages and @addTagHelper *, Microsoft.AspNetCore.Mvc.TagHelpers when pages use @model shorthand, asp-* tag helpers, or ~/ asset paths. Put PageModel classes in the matching .Pages namespace and include Microsoft.AspNetCore.Mvc.RazorPages plus Microsoft.AspNetCore.Mvc when using PageModel, BindProperty, IActionResult, or Page().
- For Django apps, keep settings.py internally coherent: every django.contrib app left in INSTALLED_APPS must have its requirements satisfied - the admin needs the auth and messages context processors (plus the request processor for its sidebar) in TEMPLATES and the sessions/auth/messages middleware. If the product does not use a contrib app (especially the admin), remove the app and its urls include instead of trimming the processors or middleware it depends on. After any change to settings, models, or URL configuration, run python manage.py check in the foreground and fix every reported issue before declaring the task complete.
- For Laravel apps, keep the generated Application::configure bootstrap coherent. Do not add Composer post-autoload/post-update artisan hooks unless a full console kernel/artisan path is already proven. Do not hand-bind ExceptionHandler or Http Kernel contracts in multiple places. When editing PHP files, write one complete PHP document with a single <?php opening tag at the top; replace files instead of appending a second copy of the same class.
- For Laravel forms, keep browser pages server-rendered through routes/web.php, controllers or route closures, Blade views under resources/views, local assets under public, and file/session storage under storage. Include @csrf in every mutating Blade form, preserve session cookies, and preserve or create bootstrap/cache and storage/framework/{cache/data,sessions,views,testing} before relying on Composer, sessions, views, validation, or CSRF.
- For R script projects (stack r-script), keep a runnable entrypoint named main.R and declare every CRAN package you load with library()/require()/:: in a DESCRIPTION file under an Imports: field (one package per line, as a bare package name). The orchestrator installs DESCRIPTION packages into a workspace-local .rlib before running and prefers the binary build matching the installed R, so do not add version constraints like (>= x) / (<= x) in Imports — they are ignored and can suggest a version that has no compatible build. A plot only appears in the preview if it is actually drawn: print() ggplot/lattice objects (a bare ggplot at top level is auto-printed by the preview, but inside a function you must print()) or write files with ggsave()/png()+dev.off(); the orchestrator captures both. Do not call install.packages() yourself and do not open interactive devices or x11()/windows().
- For Shiny apps (stack r-shiny), the entrypoint is app.R ending in a shinyApp(ui, server) object (or split ui.R + server.R). Declare shiny and any other CRAN packages in DESCRIPTION Imports as bare package names (no version constraints — the orchestrator prefers the binary build matching the installed R and ignores (>= x) / (<= x) pins). The orchestrator starts the app with shiny::runApp(host, port): never call runApp() at the top level, never hardcode host/port, and never set launch.browser=TRUE. Put static assets in www/. Keep interactivity in reactive server logic rather than collapsing into a static script.
`;

function managedBlock(): string {
  return `${beginMarker}\n${managedRules.trim()}\n${endMarker}`;
}

export async function ensureWorkspaceAgentsMd(workspacePath: string): Promise<void> {
  await assertSafeWorkspace(workspacePath, { operation: "workspace instructions write" });
  const agentsPath = path.join(workspacePath, "AGENTS.md");
  await mkdir(workspacePath, { recursive: true });

  let existing = "";
  try {
    existing = await readFile(agentsPath, "utf8");
  } catch {
    existing = "";
  }

  const block = managedBlock();
  const begin = existing.indexOf(beginMarker);
  const end = existing.indexOf(endMarker);
  let next: string;

  if (begin >= 0 && end > begin) {
    const afterEnd = end + endMarker.length;
    next = `${existing.slice(0, begin).trimEnd()}\n\n${block}\n\n${existing.slice(afterEnd).trimStart()}`.trim();
  } else if (existing.trim().length > 0) {
    next = `${existing.trimEnd()}\n\n${block}`;
  } else {
    next = `# Workspace Instructions\n\n${block}`;
  }

  await writeFile(agentsPath, `${next.trimEnd()}\n`, "utf8");
}
