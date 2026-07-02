# Agentic Control Freak (ACF): A local workbench for building software and ML projects with coding agents.

A local web control plane for orchestrating coding agents  - Codex CLI, Claude Code, Google Antigravity (AGY), or local Ollama models: plan, approve, execute, verify, preview, and inspect generated web, Python, R, or ML projects. One can **switch** between agents **without loosing context** while building.

ACF is a Next.js app that runs on your machine and coordinates coding-agent work in isolated generated workspaces. It gives you a browser UI for sending a request, reviewing a durable implementation plan, reverting changes, forking conversations, running verification, and previewing the generated result.

<p align="center">
  <img src="./ACF-intro.gif" alt="Agentic Control Freak Intro" width="800" />
</p>

## TL;DR
Install the local prerequisites first: Node.js `20.9+`, npm/pnpm, and at least one authenticated coding provider: Codex CLI, Claude Code, Google Antigravity (`agy`), or Ollama with a pulled local model. If CLI install is fresh, authenticate with them first. **Optional:** Also install the runtime/toolchain for the kind of project you want ACF to build and verify: Python for Python scripts and ML, .NET SDK for C#/ASP.NET, Java/JDK for Java projects, R for R/Shiny, and the relevant package managers for Node/Python stacks.

Start ACF locally, choose a coding provider (from toolbar's CLI toggle or via `⚙️ Runtime`), chose its `📶 Autonomy Level`, and describe what you want to build in chat area. The app drafts a durable (usually multi-step) plan first; review it and check that the stack is correct (dropdown in plan panel), approve it (or edit or reject and request an updated plan), then watch the agents implement the project task by task in a local workspace.  

Optionally pair with Telegram bot for remote control (see details below). One can also enclose images, PDFs etc or do repo research first (import repo from sidebar, call "research" explicitly in your prompt).  After the work is done one can export the repo to GitHub (or just copy `.workspace/<project>` ).

When the run finishes, the built-in verification would kick-in, and the app (or ML training/Python script panel) will appear in the preview pane. One can continue the same session with follow-up requests, switch between Codex, Claude Code, AGY, or Ollama without losing context, fork or revert work, and export the generated workspace to GitHub when you are ready.

For ML projects, make sure ML pipeline is enabled (`ML_PIPELINE_ENABLED=true` in .env), upload or assign datasets, run smoke/short/full training jobs, compare live metrics, and test saved checkpoints in the inference panel.


## Features

- Durable planning: turns a request into concrete tasks with target files, acceptance criteria, and verification hints.
- Human approval: waits (optionally) for plan approval before execution begins. The plan is editable and rejectable, suggested stack can be changed. 
- Remote control: optionally pair a **Telegram bot** to monitor and control local work sessions from chat. You can view status, receive progress updates, approve or reject plans, switch providers/models, pause/resume/step/abort runs, control previews, and create handoff summaries. Telegram is disabled by default and requires explicit `.env` setup, a local worker token, and pairing an authorized Telegram user and starting the ACF via `npm run dev:all` .
- Multi-provider agent runs: choose the coding provider per work session: Codex CLI, Claude Code, Google Antigravity CLI, or a local Ollama model. ACF uses the selected provider for planning and implementation, keeps the session context when you switch providers, and runs generated project work inside `.workspace/<project>` directories. Codex uses native app-server mode when available, with `codex exec` kept for planner/research jobs and fallback execution.
- Attech images (or simply paste them), documensts, PDFs, tables etc 
- Optional ML experiment pipeline: training scaffolds, smoke/short/full runs with live metric charts, GPU governance, a post-training inference playground, and calibration (**off by default**; see the ML section).
- Orchestrator-owned dependency research and installs: after plan approval, checks current npm/PyPI versions online, updates stale declared npm packages and simple Python requirements before coding, honors discovered npm peer constraints, passes the report into Codex, and installs generated project dependencies when needed.
- Verification: runs stack-aware checks such as `npm run typecheck`, `npm run lint`, or Python/R compile checks (build is excluded from the default gate unless a request explicitly asks for it).
- Preview: starts local previews for Next.js, Vite, static HTML, Express/Fastify, generic Node web apps, Flask, Django, R scripts, R Shiny, C# ASP.NET Core, and Python/ML scripts.
- Python output reports: runs Python scripts headlessly, captures stdout/stderr, and displays generated images or text files in a static preview report.
- GitHub export: publishes the active generated workspace to GitHub through an app-owned export flow, with OAuth device login, manifest preview, update-existing behavior, and export report artifacts.
- Artifact inspection: stores plans, execution logs, verification output, handoffs, and reports under `.data/artifacts`.
- Event timeline: records normalized backend events so you can audit what happened.
- Resumable sessions: persists projects, work sessions, plans, tasks, previews, and logs in a local JSON database.

## Requirements

- Windows, macOS, or Linux (**NOTE!** I have not tested the app on macOS nor Linux - would appreciate feedback)
- Node.js `20.9+`
- npm `10+`
- At least one coding provider installed and authenticated: Codex CLI (default), Claude Code, Google Antigravity CLI (`agy`), or a local Ollama model (see Coding Providers below)
- Python available on `PATH` if you want Python script generation, Python previews/reports, or the optional ML experiment pipeline  (`ML_PIPELINE_ENABLED=true` in .env).

## Install

Clone the repository and install dependencies:

```bash
git clone https://github.com/Antibody/Agentic-Control-Freak.git
cd agentic-control-freak
pnpm install
```


Create your local `.env` from the template (.env.example). This is needed for remote control via Telegram bot, GitHub export (and private import), and for enabling ML pipeline:


On Windows, the app auto-discovers `codex.cmd` from PATH and the common npm global install location. On macOS and Linux it searches PATH plus common Homebrew, npm, local user, asdf, mise, pnpm, and bun shim locations. You can still set `CODEX_CLI_BIN` to a full path to override discovery, for example:

```env
CODEX_CLI_BIN=C:\Users\YOUR-USERNAME\AppData\Roaming\npm\codex.cmd
```

Do not commit real API keys or personal machine paths.

## Run

Start the local control plane:

```bash
npm run dev
```

To run with remote control (see "Telegram Control" below for details )

```bash
npm run dev:all
```

Open:

```text
http://localhost:3000 
```

By default the control plane **auto-picks a free port**: it scans `3000–3099` and uses the first free one (preferring `3000` when available), then prints the URL it landed on - so it runs cleanly alongside other local dev servers. **Open the URL shown in the terminal.**

To pin a fixed port instead, set `CONTROL_PLANE_PORT=<number>` (in `.env` or the environment); the app then uses exactly that port and **fails loudly** if it is already in use, rather than silently drifting. `APP_BASE_URL` and the default `TELEGRAM_CONTROL_APP_URL` are derived from the resolved port, and a separately launched Telegram worker discovers an auto-picked port automatically. GitHub device-flow login does not use the OAuth callback at runtime, so an auto-picked port still works for export - pin the port if you want a fixed OAuth callback URL.

## Basic Workflow

1. Select coder and "thinking" effort from `⚙️ Runtime` and  `📶 Autonomy Level`. Full auto is equivalent to "Full access" or "auto mode on". 
2. Send a request in the chat, such as `Build weather Next.js app with map-click coordinates via react-leaflet and Open-Meteo`.
2a. When using Codex CLI on challenging or lengthy tasks use phrases like "Spawn three subagents: one to write frontend, one to write backend and one to review the code". For Claude one can allow "Ultracode" in `⚙️ Runtime`.
3. Review the durable plan.
4. Approve the plan.
5. The controller executes tasks through the selected coding provider.
6. Verification runs after tasks complete.
7. A preview starts if the generated workspace is previewable.
8. Use the timeline and artifact panels to inspect logs, verification output, and handoff notes.

## Coding Providers

The executor is selectable **per work session** from the Run controls provider selector and Runtime drawer, defaulting to `AGENT_PROVIDER`:

- **Codex CLI** (`codex-cli`, default): a full agent, run native-first through Codex app-server with `codex exec` as the guarded planner/research path. Install and authenticate the Codex CLI; leave `CODEX_CLI_BIN` blank to auto-discover it.
- **Claude Code** (`claude-code`), a full agent spawned per task. Install Claude Code and log in; `/api/health` distinguishes "not installed" from "not logged in". An optional per-session **Ultracode** toggle (Runtime drawer) lets Claude orchestrate its own subagents *at substantially higher token cost*.
- **Google Antigravity CLI** (`antigravity-cli`) - a full agent spawned in print mode (`agy --print`). Install and authenticate `agy`; leave `AGY_CLI_BIN` blank to auto-discover it.
- **Ollama** (`ollama`) - a bare local model API that the orchestrator wraps in its own workspace-confined agent loop. Start Ollama at `OLLAMA_BASE_URL`, `ollama pull` a code-capable model, then pick it in the Runtime drawer (or set `OLLAMA_MODEL`).

Planning and read-only research follow the same selected provider. Per-session model, thinking depth, speed tier, and timeout overrides live in the Runtime drawer.

## Export To GitHub

The workspace toolbar includes **Export to GitHub** (**↥**) for publishing the active generated workspace. Export is owned by the control plane, not by the coding agent: it scans the current workspace or latest checkpoint, ignores generated/system state, creates or updates a GitHub repository, records export metadata, and stores an export report artifact.

### Create The GitHub OAuth App

1. Open GitHub in your browser.
2. Go to **Settings** -> **Developer settings** -> **OAuth Apps** -> **New OAuth App**.
3. Fill the form:
   - **Application name:** `Agentic Control Freak`
   - **Homepage URL:** `http://127.0.0.1:3000`
   - **Authorization callback URL:** `http://127.0.0.1:3000`
4. Check **Enable Device Flow**.
5. Click **Register application**.
6. Copy the app's **Client ID**.
7. Add it to `.env`:

```env
GITHUB_CLIENT_ID=your_client_id_here
```


### Login And Export

1. Start the app with `npm run dev`.
2. Open `http://127.0.0.1:3000`.
3. Click **Export to GitHub** in the workspace toolbar.
4. Click **Login with GitHub**.
5. **Go back to ACF tab.** The app displays a GitHub verification code and opens GitHub's device login page. Note! To get verifcation code **you need to go back to ACF tab **and copy a code from the GitHub export panel. Something like: ABC1-23CD. The code is NOT sent to your email nor mobile.
6. Enter the code on GitHub **and authorize** the OAuth App.
7. Return to ACF tab, choose the owner/repository/branch/visibility, then click **Export repository**.

The app requests `repo` and `workflow` scopes so it can create private repositories and update workflow files when a generated workspace contains `.github/workflows/*`.

After a successful export, reopening **Export to GitHub** for that session defaults to the previously exported repository and enables update mode. If GitHub created an empty repository on the first attempt, the exporter seeds it and then replaces the seed with the real workspace export commit.

### Token Storage

OAuth tokens are stored locally in `.data/github-auth.json` encrypted with `GITHUB_TOKEN_ENCRYPTION_KEY`. If that env var is omitted, the app creates a local fallback key at `.data/github-token.key`. Both files are written owner-only (`0600`) where the operating system supports it (POSIX permissions; best-effort on Windows). Because the fallback key sits next to the encrypted token, the strongest protection is to set `GITHUB_TOKEN_ENCRYPTION_KEY` to a 32-byte hex/base64 value kept outside `.data`. Do not commit `.env`, `.data`, or token files.

Login always requests the `repo` and `workflow` scopes (pinned in the server; the client cannot change them), so the app can create private repositories and update workflow files.

For automation or local-only power-user workflows, you can skip OAuth and set `GITHUB_TOKEN` instead. The token must have permission to create/update the target repositories.

## Remote control via Telegram

Basic setup:

1. Create a Telegram bot with BotFather and copy its token into `TELEGRAM_BOT_TOKEN`.
2. Generate a high-entropy `TELEGRAM_CONTROL_WORKER_TOKEN`.
3. Start both the app and Telegram worker with `npm run dev:all` or `corepack pnpm run dev:all`.
4. Alternatively, start the app with `npm run dev` and the worker with `npm run telegram` in separate terminals.
5. Generate a pairing CODE with `npm run telegram:pair`.
6. On your phone, send the displayed `/pair CODE` command to the bot.
7. Send `/sessions`, then `/help` for the list of commands

#### Detailed setup:
Telegram control is an optional local companion worker. It is disabled unless `TELEGRAM_CONTROL_ENABLED=true` and the worker is running. 

Then create a token for `TELEGRAM_CONTROL_WORKER_TOKENt`
Running `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" ` will result in random 64 hex chars secret.
set `TELEGRAM_CONTROL_WORKER_TOKEN=random_64_hex_char_secret`

Create your bot via Telegram´s "BotFather" (mind the authentic blue checkmark). Then:
`/start`
`/newbot`
name it: `YourOwnBotName_bot` (mind the ending `_bot`)
**Check the latest BotFather´s message**. There will be a link to your bot (t.me/YourOwnBotName_bot ) and a **secreet token** (something like 1234567890:AATyi98793urr9078098w090kjl88). 
set in .env `TELEGRAM_BOT_TOKEN=1234567890:AA_token_from_BotFather`
set `TELEGRAM_CONTROL_APP_URL= http://127.0.0.1:3000`

Run worker `npm run dev:all` / `corepack pnpm run dev:all` to start the app and worker together, or start the worker separately with `npm run telegram`.

In  a separate teminal on your coputer: `pnpm run telegram:pair`
you will get something along those lines:
`Pairing code: 12345AAAAA`
`Role: operator`
`Expires: 2026-07-02T13:54:57.908Z`

Pairing codes are generated locally and stored only as hashes, they expire quickly, and are single-use

Now* back to the Telegram*. Click on the link in the last BotFather's message: t.me/YourOwnBotName_bot 
In your bot type and send:  /pair 12345AAAAA


Useful commands:
- `/help`: list commands
- `/sessions`: list recent work sessions.
- `/new Title`: create a fresh generated project/chat and bind Telegram to it.
- `/use N`: bind the Telegram chat to a work session.
- `/status`: show current state, plan, tasks, verification, preview, and pending approval.
- `/runtime`: show the selected session's provider, model, thinking depth, speed tier, timeout, and provider-specific runtime settings.
- `/runtime models`, `/runtime refresh`, `/runtime reset`: inspect, refresh, or clear runtime overrides.
- `/provider codex|claude|agy|ollama`: change the selected work session's provider.
- `/model list`, `/model N`, `/model model-slug`, `/model inherit`: inspect or choose the provider model.
- `/think low|medium|high|xhigh|inherit`: set thinking depth where supported.
- `/speed fast|standard|inherit`: set speed tier where supported.
- `/timeout SECONDS|inherit`: set the provider timeout.
- `/approvals`: show pending approvals with Approve/Reject buttons.
- `/approve N` and `/reject N note`: resolve approvals from Telegram.
- `/pause`, `/resume`, `/step`: control the current work session.
- `/abort`: request cancellation for the selected work session; the bot asks for confirmation before acting.
- `/preview start`, `/preview restart`, `/preview stop`, `/preview repair`: control previews.
- `/handoff`: create a handoff summary.

Plain text sent to the bot is routed to the selected work session as a normal chat message or queued steering, using the same controller logic as the web UI.

With `TELEGRAM_CONTROL_ACTIVITY_EVENTS=true`, the bot also sends concise progress updates such as "Reading your request", "Drafting the plan", "Working on a task", "Running verification", and "Preview ready".

Set `TELEGRAM_CONTROL_SEND_PREVIEW_SCREENSHOTS=true` if you want the bot to send the captured final preview screenshot after the app records `snapshot.completed` evidence. Screenshot delivery is opt-in because previews can contain local code, file paths, generated UI content, or other sensitive material. `TELEGRAM_CONTROL_MAX_SCREENSHOT_BYTES` caps the image size the local worker is allowed to fetch and upload.

Security notes:

- Telegram user authorization uses numeric Telegram user IDs, not usernames.
- Unknown users cannot control the app.
- Pairing codes are single-use, 64-bit, stored hashed, and expire. Repeated wrong codes from the same Telegram user are rate-limited and then locked out for a few minutes.
- Group control is off by default. If enabled, both the Telegram chat ID and the sender user ID must be authorized.
- `/abort` requires an operator or admin principal and a confirmation button press.
- Runtime inspection is available to viewers. Changing provider/model/thinking/speed/timeout requires operator role and is rejected while the selected session is planning, queued, executing, or verifying.
- Preview screenshots are disabled by default and are fetched through a worker-only, work-session-bound artifact endpoint when enabled.
- `/revoke USER_ID` (admin) removes a Telegram user's access immediately, including users granted via `TELEGRAM_CONTROL_ALLOWED_USER_IDS` (a stored revocation overrides the env allowlist until you re-pair or remove the env entry).
- Replayed Telegram updates are ignored (each Telegram update is processed at most once).
- The worker token is effectively an admin control credential (anything that can present it to the local API can drive an agent). Use a high-entropy value: the worker and `telegram:pair` scripts refuse to start if `TELEGRAM_CONTROL_WORKER_TOKEN` is shorter than 24 characters. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- Keep `TELEGRAM_CONTROL_APP_URL` on loopback. To avoid leaking the worker token off-box, the scripts refuse a non-loopback URL unless it uses `https`.
- Pairing any Telegram account grants real control of an agent that has full local filesystem/network access; only pair accounts you trust, and prefer the least role needed.
- Bot tokens, worker tokens, local state, `.env`, `.data`, and `.workspace` must not be committed.

## Supported Generated Project Types

Agentic Control Freak can scaffold, verify, and preview several local project types:

- Static HTML/CSS/JavaScript
- Next.js
- Vite React
- Express/Fastify and generic Node web apps
- Node CLI apps
- Python scripts
- Flask
- Django
- R scripts and R Shiny apps
- C# ASP.NET Core Razor Pages and minimal-API backends
- Python ML experiment workspaces (`python-ml`, when the ML pipeline is enabled)

Preview behavior varies by stack. Web apps run on local preview ports from `3100` to `3999`. Python and R scripts are run once in a headless preview flow and shown as an HTML report with generated image/text outputs, stdout, stderr, and source code.

## ML Experiment Pipeline (optional)

An opt-in pipeline for small local ML work - training, evaluation, and inference - driven from the same chat loop. It is **off by default**; enable it with `ML_PIPELINE_ENABLED=true` (when off, ML-flavored requests fall back to the plain Python-script stack).

- ML-flavored requests scaffold a `python-ml` workspace from one of eight starter kinds (classical sklearn, numerical simulation, eval harness, LoRA fine-tune, quantized inference, distillation, tiny recursive model, char-level language model), selected by a weighted reading of the request.
- The Experiment panel (right workbench) runs the workspace trainer as **smoke / short / full** runs with an editable run config (seed, device, precision, steps, learning rate, model size, free-form `key=value` extras), streams live metrics into a chart, and scores runs honestly: a run counts as succeeded only if it exits 0 **and** reports a valid primary metric.
- Datasets are uploaded into the workspace `data/` directory and assigned roles (train / validation / test, single corpus, or JSONL fine-tune); trainers are instructed to evaluate on held-out data.
- GPU use is governed: it requires `ML_ALLOW_GPU=true` plus a verified CUDA-capable workspace `.venv` (the installer provisions pinned CUDA wheels and verifies them), a single-GPU mutex, and a VRAM preflight that downshifts batch/sequence settings - or refuses - rather than crash.
- After a run saves a checkpoint, the **Inference panel** loads the model in a warm sandboxed worker and lets you send your own inputs (text, numbers, images, files) against the model's declared I/O contract. An optional calibration pass can post-process a trained checkpoint without touching its weights.
- Safety posture: ML jobs run with provider/ML tokens stripped from the environment unless `ML_ALLOW_SECRETS=true`, remote-code trust is an explicit flag (`ML_TRUST_REMOTE_CODE`, default off), and model/dataset downloads are cached and can be disabled (`ML_ALLOW_NETWORK_DOWNLOADS=false` sets Hugging Face/Transformers offline mode).

`npm run validate:ml` exercises the scaffolds end-to-end (selection, smoke run, full run, inference round-trip). `PROJECT.md` documents the full ML hazard model and configuration flags.

## Verification

Run checks for the control plane itself:

```bash
npm run typecheck
npm run lint
npm run build
```

Generated workspaces are verified by the orchestrator according to their stack. For example:

- Next.js/Vite: typecheck and lint when available (build runs only if the request explicitly asks for build verification).
- Python scripts: `python -m py_compile` on the detected entrypoint.
- Flask: `python -m py_compile app.py`.
- Django: `python -m py_compile manage.py` and `python manage.py check`.
- R scripts / R Shiny: a syntax parse of the entrypoint (`Rscript -e 'parse(...)'`).

There is currently a known non-blocking Turbopack NFT warning during control-plane builds because server modules use filesystem and process APIs. The build still exits successfully.

## Configuration

Common environment variables:

- `AGENT_PROVIDER`: `codex-cli`, `claude-code`, `antigravity-cli`, or `ollama`.
- `PLANNER_PROVIDER`: `codex-cli`. Planning otherwise follows the selected CLI/LLM provider for the work session; if the selected runtime is unavailable, the app reports the planner error and asks the user to switch provider or fix the runtime.
- `CODEX_CLI_BIN`: optional path to the Codex CLI executable. Leave blank to auto-discover it.
- `PYTHON_BIN`: optional Python executable override. Leave blank to auto-discover workspace `.venv`, `python3`, or `python`.
- `NPM_BIN`, `PNPM_BIN`, `YARN_BIN`, `BUN_BIN`: optional package-manager executable overrides. Leave blank to auto-discover.
- `CODEX_SANDBOX_MODE`: Codex CLI sandbox mode. Use `danger-full-access` only for trusted local workspaces.
- `VERIFY_COMMANDS`: semicolon-separated verification commands.
- `WORKSPACE_ROOT`: where generated projects are created.
- `ARTIFACTS_DIR`: where logs and reports are stored.
- `PREVIEW_PORT_START` / `PREVIEW_PORT_END`: preview port range.
- `PREVIEW_AUTO_OPEN`: deprecated no-op, retained for backward compatibility. Previews always stay embedded in the app preview pane; use the explicit "Open Preview" button for a separate browser tab.
- `GITHUB_CLIENT_ID`: GitHub OAuth App client ID used for device-flow login and repository export.
- `GITHUB_TOKEN`: optional non-interactive GitHub token fallback.
- `GITHUB_TOKEN_ENCRYPTION_KEY`: optional 32-byte hex/base64 key for encrypting stored OAuth tokens.
- `ML_PIPELINE_ENABLED`: opt-in ML experiment pipeline (default `false`; see the ML Experiment Pipeline section).
- `CLAUDE_ULTRACODE` (+ `CLAUDE_ULTRACODE_TOOLS` / `CLAUDE_ULTRACODE_MAX_TURNS` / `CLAUDE_ULTRACODE_MAX_BUDGET_USD`): global default for **Ultracode (multi-agent) mode** for the Claude Code provider. Normally toggled per work session from the Runtime drawer (Claude only, default off). When on, a Claude task is cleared to orchestrate subagents / run a Workflow - much higher token cost, bounded by a turn ceiling and a USD budget ceiling, still confined to the work-session workspace by the permission gate. See `.env.example`.

## Local Data

Runtime data is stored locally:

- `.data/...`: embedded database and artifacts.
- `.workspace/...`: generated project workspaces.
- `.orchestrator/...`: durable session mirror data.

Chat history is persisted in the embedded JSON database configured by `DB_FILE` in `.env`. The database stores chat containers in `chatSessions` and individual messages in `chatMessages`, linked by `chatSessionId`. When `POST /api/chat` receives a user message, `lib/server/workflow-controller.ts` appends a new chat message through `lib/server/db/file-db.ts`; the database writer serializes mutations with an in-process lock, writes a temporary file, and renames it over the configured DB file. On page load, `GET /api/app-state` reads the same JSON database and the UI filters messages for the active work session's chat session.

Reset local demo data:

```bash
npm run reset
```

This is a local development tool. Treat generated workspaces as untrusted code unless you reviewed the request, plan, and output.

## API Overview

Important backend routes:

- `GET /api/app-state`
- `POST /api/chat`
- `POST /api/work-sessions/:id/tick`
- `POST /api/work-sessions/:id/preview`
- `POST /api/work-sessions/:id/github-export/prepare`
- `POST /api/work-sessions/:id/github-export`
- `GET /api/github/status`
- `POST /api/github/auth/device/start`
- `POST /api/github/auth/device/poll`
- `POST /api/work-sessions/:id/handoff`
- `POST /api/approvals/:id`
- `GET /api/events/stream?workSessionId=...`
- `GET /api/artifacts/:id`
- `POST /api/projects`
- `POST /api/demo/reset`

## Architecture

Key modules:

- `components/ChatApp.tsx`: browser control-plane UI.
- `lib/server/workflow-controller.ts`: main state machine.
- `lib/server/planner.ts`: provider-backed plan generation and fail-closed planner validation.
- `lib/server/dependency-installer.ts`: orchestrator-owned dependency installer.
- `lib/server/runtime/codex-adapter.ts`: Codex CLI execution adapter.
- `lib/server/verification.ts`: verification runner and preflight checks.
- `lib/server/preview-manager.ts`: preview lifecycle and stack detection.
- `lib/server/github-auth.ts`: GitHub OAuth device-flow status, polling, token encryption, and token loading.
- `lib/server/github-exporter.ts`: GitHub repository creation/update and one-commit export flow.
- `lib/server/github-export-scanner.ts`: export manifest scanning and generated/system-file ignore rules.
- `lib/server/db/file-db.ts`: embedded JSON database.
- `lib/server/events.ts`: normalized event emission.
- `scripts/static-preview-server.mjs`: static preview server used by static and Python report previews.

Supporting docs and in-repo references:

- `.env.example`: annotated configuration reference (every knob, with **DANGER**-flagged options).
- `lib/server/verification.ts` / `lib/server/functional-verification.ts`: the verification + render-gate contract.
- `lib/server/events.ts` and `lib/shared/types.ts`: the normalized event contract and record shapes.
- `lib/server/db/file-db.ts`: the embedded JSON datastore (`.data/closed-dev-loop.json`); there is no SQL database.

## Security Notes

Agentic Control Freak runs code-generation and preview commands locally. Use it with trusted workspaces and review plans before approval. See [SECURITY.md](SECURITY.md) for the threat model, hard rules, known residual risks, and how to report vulnerabilities.

- Do not approve plans you do not understand.
- Do not run with broad filesystem access against sensitive directories.
- Do not commit `.env`, `.data`, `.workspace`, generated artifacts, or API keys.
- Do not commit GitHub OAuth token files or local encryption keys from `.data`.
- Be cautious with dependency installation and generated scripts.

### Local-only network access

The control plane has no login and can drive agents with full local access, so it is locked to your
own machine. `npm run dev` / `npm run start` bind to `127.0.0.1` only (never your LAN), and a request
guard rejects API calls unless the `Host` is loopback and any browser `Origin` exactly matches the
control-plane origin. Generated previews on other loopback ports are intentionally blocked from
calling `/api/*`; local non-browser clients such as hooks and the Telegram worker can still call the
API without an `Origin` header. Keep these defaults; do not re-bind to `0.0.0.0` or widen the guard to
external origins.

### Environment variables and spawned processes

The app runs several kinds of child processes, and it controls which environment variables each one can
see (logic lives in `lib/server/runtime/env.ts`). The boundary is important because coding agents and
generated projects execute local code.

- **The app's own secrets are stripped before any child process starts.** `GITHUB_TOKEN`,
  `GITHUB_TOKEN_ENCRYPTION_KEY`, `GITHUB_CLIENT_ID`, `EVENT_WEBHOOK_URL`, Telegram bot/worker tokens, and
  similar app-control secrets are read only by the control plane itself. They are removed before
  launching agents, verification, previews, installs, and research jobs.
- **The direct implementation adapters use a curated agent environment.** The Codex `exec`, Claude Code,
  and AGY implementation paths receive OS basics (`PATH`, `HOME`, temp dirs), proxy/TLS settings,
  locale, and selected provider/tool namespaces: `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `CODEX_*`,
  `GEMINI_*`, `GOOGLE_*`, `VERTEX_*`, `AGY_*`, `ANTIGRAVITY_*`, `OLLAMA_*`, `AZURE_OPENAI_*`. These are
  environment namespaces, not the app's provider list.
- **Codex app-server and research jobs currently use the broader sanitized environment.** The default
  Codex transport starts native `codex app-server` when available, and the research adapters for Codex,
  Claude, and AGY inherit most of the parent shell environment after the app's secret denylist is
  applied. Known app secrets and several exact cloud/package-manager secrets are removed, but arbitrary
  variables such as `MY_API_KEY`, `SENTRY_AUTH_TOKEN`, `HF_TOKEN`, or service-specific tokens may still
  be visible to those processes if they were present when the control plane started.
- **Verification, preview, dependency installation, and generated app servers also keep the broader
  sanitized environment.** This is intentional so local dev servers and package managers can work, but
  those processes should be treated as local code execution, not a sandbox for untrusted projects.

All agent paths can also access the normal CLI configuration files under your user profile (`HOME`,
`USERPROFILE`, `APPDATA`, and related OS paths remain available). That is how Codex CLI, Claude Code,
AGY, and similar tools find their existing local authentication. Do not run this app from a shell loaded
with unrelated production secrets, and do not run untrusted prompts or generated projects on a machine
where those local CLI credentials should be protected from the agent runtime.

If a coding agent legitimately needs a custom variable you set - for example a runtime gateway,
compatibility endpoint, or token for a tool the agent calls - name it inside one of the allowed provider
namespaces above, or add the exact key/prefix to the allowlist in `lib/server/runtime/env.ts`. A variable
that matches none of the allowed names is intentionally hidden from the direct implementation adapters.

## macOS and Linux Notes (**NOTE!** I have not tested the app on macOS nor Linux - would appreciate feedback)

The app is intended to run from the same repository on Windows, macOS, and Linux. Runtime commands are resolved at startup/use time so GUI-launched apps with a minimal PATH can still find common tool installs.

- Install Codex CLI, Node.js 20.9+, npm, and Python 3.
- For macOS Homebrew installs, `/opt/homebrew/bin` and `/usr/local/bin` are searched automatically.
- For Linux desktop installs, PATH, `~/.local/bin`, asdf, mise, pnpm, and bun shim locations are searched automatically.
- Python workspaces prefer a local `.venv` or `venv` before falling back to `python3`/`python`.
- `/api/health` reports resolved Codex, Python, package-manager commands, platform details, and workspace-root writability.

## License

Released under the [MIT License](LICENSE).
