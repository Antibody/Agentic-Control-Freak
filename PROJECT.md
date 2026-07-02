# Project Summary

This repo is a Next.js 16 local orchestration app for a closed dev loop coding-agent workflow. It provides a web chat control plane that creates durable plans, asks for approval, runs the selected coding provider against isolated generated workspaces, verifies results, stores artifacts/events, and previews generated apps across multiple project stacks.

## Core App Entry

- `app/page.tsx` renders `components/ChatApp.tsx`.
- `app/api/*` exposes chat, state, approvals, projects, health, Codex hook ingestion, SSE events, handoff, fork, tick, run-control (pause/resume/step/abort/set-autonomy/set-runtime/set-steering), per-task actions (re-run/skip/edit), preview APIs, final-summary changed-file/diff APIs, report/playbook/runtime-tool APIs, skill APIs, user/project memory APIs, agent-run event/transcript replay, and GitHub auth/export APIs.
- `app/api/telegram-control/*` exposes a narrow loopback-only Telegram worker API for optional remote control. It is protected by `TELEGRAM_CONTROL_WORKER_TOKEN`, disabled unless `TELEGRAM_CONTROL_ENABLED=true`, and dispatches explicit Telegram-control operations instead of exposing broad app APIs directly.
- `.env` controls provider, runtime, verification, and preview settings.

## Important Backend Modules

- `lib/server/workflow-controller.ts` - main state machine. Handles intake, planning, approval, execution, verification, handoff, and completion. Enforces per-session autonomy gating (`manual`, `checkpoint`, `supervised`, `full_auto`): `advanceController(id, { trigger })` pauses before gated actions unless a `step` authorizes exactly one. Blocks unsafe implementation roots before agent/provider work can run, and validates plan/task target files so generated work cannot escape the active workspace.
- `lib/server/runtime/process-registry.ts` - module-level registry of in-flight runtime processes keyed by agent run, so an abort request from one HTTP handler can kill a provider process started by another.
- `lib/server/runtime/operation-registry.ts` - module-level registry of in-flight controller-owned operations such as controller ticks, verification, preview startup, snapshot capture, and exports. It gives Pause/Abort a general cancellation path for long-running orchestration work that is not itself a provider process.
- `lib/server/stack-resolver.ts` - detects the intended project stack from the request and workspace files. `resolveProjectStack` now tags each result with `source: "request" | "workspace" | "default"` so callers can tell an explicit/evidence-backed decision apart from a no-signal fallback to `DEFAULT_PROJECT_STACK`.
- `lib/server/workspace-analysis.ts` - inspects generated workspaces and records important files, routes, scripts, and stack type.
- `lib/server/workspace-bootstrap.ts` - scaffolds empty workspaces for supported stacks before planning/execution. `bootstrapWorkspaceIfNeeded` accepts a `deferLowConfidenceDefault` option: when the resolved stack is only the configured default (resolution `source === "default"`, i.e. no request signal and no workspace evidence) it skips the pre-plan scaffold and returns `deferred: true` instead of committing a heavy default scaffold that would bias the planner; `createPlan` passes this option, execution-time bootstrap does not (so an empty workspace still scaffolds as a fallback). C# browser/full-stack/server-rendered requests start from ASP.NET Core Razor Pages with `Pages/_ViewImports.cshtml` and `wwwroot` assets; explicit C# API/backend-only requests stay on minimal API JSON endpoints. Generated Next.js scaffolds pin `outputFileTracingRoot` and `turbopack.root` to the generated app's own directory (and set `allowedDevOrigins: ["127.0.0.1","localhost"]`) so a nested generated app's `next dev` cannot infer the orchestrator as its workspace root and compile the control-plane `proxy.ts`.
- `lib/server/workspace-safety.ts` - central execution-root safety guard. It blocks generated/manual workspaces that resolve to the control-plane app root, a parent of it, a generated path outside `WORKSPACE_ROOT`, or a folder with control-plane markers before bootstrap, dependency work, preview, verification, or provider execution can mutate/run there.
- `lib/server/planner.ts` - provider-backed plan generator for requested work, using the selected CLI/LLM planner and fail-closed planner errors instead of local substitute plans. Plan rules demand evidence-friendly tasks: each task is one durable, restartable step with observable-behavior acceptance criteria, and any user-input surface must carry a graceful invalid/empty-input criterion (executor prompts reinforce this; the JSON quality gate itself is unchanged). The shared `targetStack` rule also instructs the planner that when the workspace analysis is empty (`isEmpty=true`, no detected stack) it must infer the stack from the user's request alone and not default to a web framework — a script/plot/chart/visualization/math/simulation/report request that names Python or `py` (or otherwise implies a runnable program rather than a website) is `python-script`, with web stacks reserved for explicit page/site/app/server/API asks.
- `lib/server/dependency-research.ts` - approval-time package intelligence preflight that checks npm/PyPI online, updates stale declared npm dependencies and Python requirements to current registry versions before coding, modernizes Next lint config, and writes a report for agent prompts.
- `lib/shared/loop-bounds.ts` - the enforced controller loop bounds (per-root execution-repair budget, per-task attempt ceiling, and the progress-aware verification-repair budget: a repeated failure fingerprint still blocks early, but distinct sequential failures - each repair succeeding and surfacing the next issue - get a higher hard cap before the session blocks), shared with the UI loop chip in the run-controls bar (shown only when a session is inside a repair/retry loop; derived client-side from records the UI already receives). `scripts/loop-metrics.mjs` prints per-session loop metrics (repairs by kind, attempts per fingerprint, verification failure mix, interaction-probe outcomes, dispatch-context usage, zero-attempt task closures) from the embedded DB.
- `lib/server/dispatch-context.ts` - dispatch-time evidence blocks compiled immediately before provider dispatch: a provider-neutral retry addendum for attempt >= 2 (fresh failure summary/fingerprint, prior-attempt summaries, already-changed files) and a bounded session-continuity block for providers without native cross-turn memory; both ride optional task metadata so absent fields keep adapter prompts byte-identical.
- `lib/server/dependency-installer.ts` - orchestrator-owned package installer for generated workspace dependency tasks, with conservative package extraction and peer-compatible version resolution. A successful install auto-completes a task only when its contract is manifest-only (`DEPENDENCY_TASK_AUTOCLOSE=manifest-only`, the default); tasks with non-manifest deliverables still go to an executor with the install summary attached as a "Dependency pre-flight" prompt block.
- `lib/server/workflow-transitions.ts` - small pure transition evaluator for verification outcomes, repair budgets, repeated failures, and completion.
- `lib/server/runtime/codex-transport.ts` - central Codex transport policy. `CODEX_TRANSPORT_MODE=auto` makes task execution native app-server first, allows `codex exec` fallback only for startup/protocol failures before `turn/start`, and lets the Runtime drawer switch a session to `app-server-only` or `exec-only`.
- `lib/server/runtime/codex-adapter.ts` - legacy Codex `codex exec` transport and guarded Codex planner/research path, with prompt via stdin. Resolves per-session runtime overrides (model `-m`, `-c model_reasoning_effort`, service tier/fast mode via `-c service_tier=...`, sandbox, `-c sandbox_workspace_write.network_access`, timeout) on top of configured defaults, and injects the session/per-task steering note into the executor prompt.
- `lib/server/runtime/codex-app-server-execution.ts` + `lib/server/runtime/codex-collab.ts` - native Codex app-server execution path. It starts/resumes Codex threads, supports live `turn/steer`, `thread/settings/update`, approvals, native review/fork/rollback APIs, parses `collabAgentToolCall` items, persists subagent/collab caches on the work session, distinguishes explicit user aborts from Codex-reported interrupted turns, and exposes root/child thread history through `GET /api/work-sessions/{id}/codex-thread`.
- `lib/server/runtime/claude-code-adapter.ts` - invokes Claude Code as a spawned local agent process. The orchestrator writes long prompts into `.orchestrator`, passes a short launcher prompt to Claude, applies explicit Fast/Standard choices through session-scoped `/fast on` or `/fast off` control turns when persistent Claude sessions are enabled, captures before/after workspace diffs, and returns the same runtime result contract as Codex. The write/execute turn is bounded by `--max-turns` (`CLAUDE_MAX_TURNS`) as an agentic-loop runaway guard alongside `--max-budget-usd` and the wall-clock timeout. `--permission-mode` is derived from the work session's autonomy level on a headless-safe mapping (`full_auto` → `bypassPermissions`; `manual`/`checkpoint`/`supervised` → `acceptEdits`, since a `-p` spawn has no human to answer a prompt and autonomy gating is enforced at the controller layer); an explicit `CLAUDE_PERMISSION_MODE` overrides the mapping. Stable cross-turn governor material (role, the orchestrator's hard rules, and the session steering note) is delivered via `--append-system-prompt` so it outranks task text and caches across turns; per-task material stays in the stdin task prompt, and persistent sessions add `--exclude-dynamic-system-prompt-sections` for a stable cached prefix. The stream-json parser also reads `system/init` (actual model/tools/MCP/permission mode loaded — used to flag a silent model fallback when the requested model ≠ the one that ran) and `rate_limit_event` (surfaces a degraded "rate-limited/retrying" state instead of a run that looks hung). The execute turn passes `--json-schema` to constrain the final message to a structured contract (`summary`, `filesChanged`, `verificationSteps`, `risks`, `needsFollowup`), read back from the result event's `structured_output` so the completion summary carries reliable fields instead of free prose; `filesChanged` is advisory only — the filesystem diff stays the source of truth. For tool-call-level autonomy enforcement, non-`full_auto` sessions run in `--permission-mode default` and route every gated tool call through an orchestrator-owned MCP permission server (`scripts/claude-permission-server.mjs`, registered via `--mcp-config` + `--permission-prompt-tool mcp__orchestrator__approve`) whose auto-policy denies any mutation whose path escapes the active worktree and allows the rest; `full_auto` keeps `bypassPermissions` (no server), an explicit `CLAUDE_PERMISSION_MODE` disables gating, and a missing server script degrades gracefully to `acceptEdits`. `CLAUDE_PERMISSION_GATING=false` opts out entirely. Optional deterministic policy delivery via `--settings`/`--setting-sources` (`CLAUDE_SETTINGS_JSON`, `CLAUDE_SETTING_SOURCES`) is off unless configured. For reliability, the execute turn can carry an automatic `--fallback-model` (`CLAUDE_FALLBACK_MODEL`, validated through the model catalog) so an overloaded/retired primary completes the run on the fallback instead of hard-failing. Two opt-in execute-turn controls round this out: `--add-dir` (`CLAUDE_ADD_DIRS`) grants extra read/tool-access roots — file access only, not config discovery, and non-existent entries are dropped; and `--disable-slash-commands` (`CLAUDE_DISABLE_TASK_SLASH_COMMANDS`, default off) hardens the task turn so a piped task/attachment line beginning with `/` can't be parsed as a command (the `/fast` and `/compact` control turns are unaffected). When persistent sessions are on, a repair task (one carrying `repairForTaskId`/`repairForVerificationRunId`/`repairForPreviewId`) resumes the canonical session with `--fork-session`, so a failed or speculative repair attempt diverges into a fresh forked id and never pollutes the resumable transcript that later regular tasks continue (the forked id is not persisted; `/compact` deliberately still does not fork). The execute turn runs on a stream transport by default (`CLAUDE_TRANSPORT_MODE=auto`, `lib/server/runtime/claude-stream-transport.ts`): the same per-task-turn process, but with `--input-format stream-json` over a kept-open stdin, which registers live-control hooks on the process registry — a `steer` hook that injects user steering INTO the running turn (acknowledged via the `--replay-user-messages` echo; the model absorbs the redirect mid-turn instead of the message waiting for the next boundary or killing the run) and a graceful `abort` that sends a `control_request` interrupt (the CLI finalizes in-flight writes and emits a result) with kill-tree escalation after a grace window; per-turn timeouts follow the same interrupt-then-escalate ladder. The controller's existing live-steer-first ladder picks these hooks up with zero controller changes. Startup-only failures fall back to the legacy text transport automatically in `auto` mode; `CLAUDE_TRANSPORT_MODE=text` is the kill switch. The activity feed parses real assistant `text_delta` events and tool-call markers out of the stream instead of digesting raw JSON lines. `CLAUDE_CODE_BIN` is optional; blank means auto-discover from PATH and common install locations.
- `lib/server/runtime/agy-adapter.ts` - invokes Google Antigravity CLI (`agy`) in print mode as a spawned local agent process. The orchestrator writes long prompts into `.orchestrator`, passes a launcher prompt via `--print`, scopes access with `--add-dir`, disables auto-update for app-owned runs, captures filesystem diffs, and treats exit-zero/no-output/no-change runs as failures instead of false success. `AGY_CLI_BIN` is optional; blank means auto-discover from PATH, `%LOCALAPPDATA%\agy\bin` on Windows, and `~/.local/bin` on macOS/Linux.
- `lib/server/runtime/ollama-adapter.ts` - alternative coding provider that wraps a local Ollama model in an **orchestrator-owned agent loop**. Because Ollama is a model API (not an agent like Codex), the orchestrator itself runs the ReAct loop: it offers workspace-confined tools, executes each tool call against the filesystem, feeds results back, and iterates until the model calls `finish` or a budget/timeout/abort is hit. Code changes are captured by the same before/after snapshot diff used for Codex, so the model is never trusted for change truth. Registers with the process registry so Abort and steering-interrupt work; returns the same `RuntimeExecutionResult` contract the controller already consumes.
- `lib/server/runtime/research-adapter.ts` - read-only research runtime. Codex, Claude Code, and AGY research use their spawned local agent CLIs with read-only instructions/permissions where the CLI supports them; Ollama research uses a separate orchestrator-owned read-only loop (`list_dir`, `read_file`, `search_text`, `finish`) that produces the same chat summary and research report artifacts without exposing write/delete/shell tools.
- `lib/server/runtime/chat-model-client.ts` + `lib/server/runtime/ollama-client.ts` - provider-agnostic chat transport interface (`ChatModelClient`) and its Ollama implementation (`/api/chat` with native tool-calling, `/api/tags`, `/api/version`). A future llama.cpp client implements the same interface without touching the loop, tools, diff, controller, or UI.
- `lib/server/runtime/ollama-tools.ts` - the workspace toolset the orchestrator exposes to Ollama (`list_dir`, `read_file`, `write_file`, `delete_file`, `finish`), every path confined to the work session workspace; plus an envelope-directive parser (`<<<WRITE>>>`/`<<<READ>>>`/`<<<DELETE>>>`/`<<<FINISH>>>`) fallback for models without native tool-calling. Tool availability is now mediated through `lib/server/runtime/tool-catalog.ts` and `lib/server/runtime/tool-policy.ts`, which classify tools by mode (`plan`, `research`, `execute`, `repair`), mutability, risk, and provider support. Plan/research policies fail closed for mutating tools.
- `lib/server/runtime/*-doctor.ts` + runtime option/catalog modules - cached provider reachability checks surfaced in `/api/health` plus provider-specific runtime options returned through `/api/runtime-options`. Codex and Ollama expose selectable model catalogs; Codex also exposes live service tiers from `codex debug models` and reads the configured `service_tier` default from `~/.codex/config.toml`; Claude Code derives model choices from structured local Claude Code usage/settings, keeps Claude aliases as a fallback, hides effort for models that do not support thinking, and exposes Fast only for Opus-capable models; AGY derives model choices from Antigravity settings/log artifacts plus installed-client `@default` model keys and applies the selected model to Antigravity settings before launch.
- `lib/server/source-context.ts` - shared prompt-source wrapper for user-controlled or externally derived context. Attachment summaries and prior research excerpts are rendered as explicitly untrusted source data so providers can use them as evidence without treating embedded instructions as system/operator commands.
- `lib/server/playbooks.ts` - approved project playbook retrieval and prompt rendering. Approved playbooks are matched against the active work session/task and injected into Codex CLI, Claude Code, AGY, and Ollama executor prompts as trusted reusable workflow guidance; draft/archived playbooks are not injected.
- `lib/server/skills/*` - app/workspace skill discovery, registry reconciliation, import/delete/update APIs, and prompt activation. App skills are Markdown files under `.skills/*.md`; workspace skills are Codex-compatible `.agents/skills/*/SKILL.md` files under the active generated workspace. Enabled/trusted skills can be selected explicitly by name or implicitly by task relevance and are rendered as bounded workflow guidance for Codex CLI, Claude Code, AGY, and Ollama without overriding system rules, safety, approvals, verification, or the current user request.
- `lib/server/user-memory.ts` and `lib/server/project-memory.ts` - durable memory layers. User memory is app-wide operator preference/context; project memory is work-session/project-specific context with category/scope/status metadata. Active memories are injected into executor prompts before provider dispatch, with user memory rendered before project memory so app-wide preferences are available across Codex, Claude Code, AGY, and Ollama while still allowing the current request to supersede them.
- `lib/server/runtime/agents-md.ts` - writes orchestrator-owned invariant Codex instructions into `AGENTS.md` while preserving user/project content.
- `lib/server/runtime/codex-doctor.ts` - cached Codex CLI preflight used by health checks and execution startup.
- `lib/server/runtime/workspace-diff.ts` - snapshots generated workspaces before and after Codex runs and derives real file change records.
- `lib/server/work-session-fork.ts` - creates independent forked projects/work sessions. Current-chat forks copy the live workspace and full transcript; checkpoint and handoff forks materialize a historical git checkpoint and copy only the transcript available at that fork point.
- `lib/server/session-changes.ts` - resolves the changed-file set for a Final summary/handoff. It prefers checkpoint-backed git diffs between the session's base/current-history checkpoint and the handoff checkpoint, with a fallback to recorded `CodeChangeRecord[]` rows if the checkpoint repository is unavailable.
- `lib/server/github-auth.ts` - GitHub OAuth device-flow and token handling. Supports `GITHUB_TOKEN` for local power users, stores OAuth tokens encrypted under `.data`, and exposes safe account status without putting tokens in public app state, events, artifacts, or prompts.
- `lib/server/github-exporter.ts` + `lib/server/github-export-scanner.ts` - orchestrator-owned GitHub repository export. Scans the active workspace or latest checkpoint with hard deny rules for generated/system state and for secret-bearing files (the scanner unconditionally excludes `.env`/`.env.*` except sharable `.env.example`-style files, `*.pem`/`*.key`/`*.pfx`/`*.p12`/`*.tfstate`/keystores, `.npmrc`/`.netrc`/`.pypirc`/`.git-credentials`, SSH keys, service-account/credential JSON, and whole `.ssh`/`.aws`/`.gnupg`/`.azure`/`.data`/`.workspace` directories — so the encrypted GitHub token and its decryption key under `.data` can never be uploaded), surfaces every exclusion in `manifest.ignored` plus a warning, creates or updates a GitHub repository via the Git Database API, seeds brand-new empty repositories when GitHub requires an initial contents commit before refs exist, records durable export metadata, emits `github.export.*` events, and writes an export report artifact.
- `lib/server/runtime/browser-harness.ts` - Playwright-backed browser inspection harness for generated preview URLs. Captures a bounded semantic DOM snapshot, accessibility tree when available, viewport screenshot, console/page/network signals, basic geometry summaries, and enforces localhost-only preview navigation with strict same-origin request blocking.
- `lib/server/runtime/process-runner.ts` - Windows-safe process wrapper, including `.cmd` and `.bat` handling. Accepts an `AbortSignal` and tree-kills the process on abort (`taskkill /T /F` on Windows); results carry an `aborted` flag.
- `lib/server/verification.ts` - runs stack-compatible verification commands, strips inherited `NODE_ENV`, installs Python requirements when needed, verifies declared package imports, performs structural checks for generated web apps including ASP.NET Core Razor Pages tag-helper/_ViewImports wiring, validates Django database readiness with a non-mutating migration plan, classifies verification-contract failures, runs Python commands through structured argv execution, and threads cancellation signals into install/verification subprocesses.
- `lib/server/functional-verification.ts` - runtime rendered-output verification for web previews. Uses snapshot/DOM evidence to assert that generated routes render visible content, browser signals are clean, and navigation links exist in the live app instead of only in source text.
- `lib/server/snapshot-capture.ts` - server-side preview evidence capture. Validates ready preview records against configured host/port policy, captures screenshot + semantic DOM/report artifacts, emits `snapshot.*` events, and attaches snapshot evidence to verification runs.
- `lib/server/preview-manager.ts` - detects previewable stacks, installs dependencies when needed, prepares Django previews with noninteractive migration generation/application before `runserver`, starts/stops or safely refreshes generated-app previews on safe free ports, health-checks expected routes/assets with bounded abortable requests, and renders Python script output reports with captured matplotlib figures. Python script previews accept user-supplied run parameters (entrypoint override, argv, stdin, env, and matplotlib dpi/format/style) and expose selectable entrypoints via `listPythonEntrypoints`.
- `lib/server/db/file-db.ts` - JSON-file embedded DB and record factories. Default managed workspaces are created under `WORKSPACE_ROOT`, explicit generated workspaces under that root remain durable, and DB writes use randomized temporary files to avoid colliding writer state.
- `lib/server/events.ts` - normalized event emission with priority, typed payloads, SSE persistence, and optional webhook delivery.
- `lib/server/telegram-control/*` - optional Telegram control integration. It stores paired Telegram principals, chat-to-work-session bindings, hashed pairing challenges, callback nonces, notification cursors, and audit entries under `.data/telegram-control.json`; dispatches authorized Telegram commands to existing controller/preview/approval/runtime functions; and formats selected app events into safe Telegram notifications.
- `lib/server/work-session-runtime-control.ts` - shared runtime-control service used by the web run-control route and Telegram commands. It persists per-session provider/runtime overrides, validates model/thinking/speed options against provider catalogs, clears stale provider-specific fields on provider changes, and resets Claude persisted-session metadata when model/effort changes require a fresh Claude session.
- `lib/server/orchestrator-state.ts` - mirrors durable state under `.orchestrator`.
- `app/api/reports`, `app/api/work-sessions/{id}/reports` - report artifact library APIs. They return research, dependency-research, verification, handoff, and explicitly tagged report artifacts with report type, summary metadata, session state, and project context.
- `app/api/playbooks`, `app/api/playbooks/{id}` - local playbook CRUD APIs for creating reusable workflow recipes, approving them, archiving them, and editing tags/triggers/procedures.
- `app/api/skills`, `app/api/skills/{id}` - skill registry APIs. `GET` refreshes discovered app/workspace skills, JSON `POST` creates an app-level Markdown skill from typed/pasted content, multipart `POST` imports Markdown/text skill files, `PATCH` updates enabled/implicit/trusted settings, and `DELETE` removes only app-owned `.skills` Markdown files.
- `app/api/user-memory`, `app/api/user-memory/{memoryId}` - app-wide user memory CRUD APIs. User memories support active/dismissed status, pinning, editing, deletion, and prompt-injection timestamp tracking.
- `app/api/work-sessions/{id}/project-memory`, `app/api/work-sessions/{id}/project-memory/{memoryId}` - project memory CRUD APIs for the selected work session. Project memories support category, scope, active/candidate/dismissed status, pinning, editing, deletion, extraction from completed runs, and prompt-injection timestamp tracking.
- `app/api/runtime-tools` - runtime tool catalog API. Returns the active tool set for a requested policy mode, so the UI or diagnostics can show which tools are exposed before a model run.
- `app/api/work-sessions/{id}/runs/{agentRunId}/events` - agent-run replay API. Returns persisted events, tool runs, and artifacts for a specific agent run so clients can reconstruct missed progress after reload/disconnect without depending on a live SSE stream.

## State And Storage

- Primary embedded DB: `.data/closed-dev-loop.json`
- The DB is serialized compact (single line) because every mutation rewrites the whole file; use `jq` to read it. The eventLog is bounded: low-priority stream events are evicted first (`EVENT_LOG_MAX_LOW_PRIORITY_ENTRIES`, default 4000), then a total cap applies (`EVENT_LOG_MAX_ENTRIES`, default 12000). Agent/verification output deltas are coalesced in `lib/server/events.ts` (~1.5s / 3500-char buckets) before persistence — never assume one eventLog record per stream chunk, and never use array-index cursors over eventLog (use event ids; see `app/api/events/stream/route.ts`).
- On first DB read each process runs a best-effort hygiene sweep (`lib/server/db/file-db.ts`): abandoned `closed-dev-loop.json.*.tmp` partial writes older than 10 minutes and `locks/controller-*.lock` files whose owning pid is dead are removed.
- Artifacts: `.data/artifacts/...`
- Playbooks are embedded in the primary DB as `PlaybookRecord[]`. Only approved playbooks are eligible for prompt injection; drafts and archived records remain stored but inert.
- Skills are embedded in the primary DB as `SkillRecord[]`, with activation history in `SkillActivationRecord[]`. App-owned skill bodies live as Markdown under `.skills/*.md`; workspace-discovered Codex skills stay in the generated workspace under `.agents/skills/*/SKILL.md`.
- User memory is embedded in the primary DB as `UserMemoryRecord[]`. It is app-wide and not tied to any work session.
- Project memory is embedded in the primary DB as `ProjectMemoryRecord[]` and scoped to work sessions/projects according to each record's scope/status metadata.
- GitHub OAuth token envelope: `.data/github-auth.json`; local encryption key fallback: `.data/github-token.key` unless `GITHUB_TOKEN_ENCRYPTION_KEY` is provided.
- Optional Telegram control state: `.data/telegram-control.json`. It contains paired numeric Telegram user IDs, roles, chat bindings, notification cursors, audit metadata, and hashed short-lived pairing/callback secrets. It must remain local and must not be committed.
- Generated apps: `.workspace/<project-slug>/...`
- Generated/default work sessions use children of `WORKSPACE_ROOT`; `ALLOW_APP_ROOT_VERIFICATION` does not select the app root as an implementation workspace.
- The control-plane app root, parents of the app root, generated paths outside `WORKSPACE_ROOT`, and folders with control-plane markers are not valid implementation workspaces.
- Do not let generated apps write into the orchestrator root.

## Current Behavior

- New project creates a fresh project, chat session, and work session with empty messages, events, logs, plans, approvals, handoffs, artifacts, and verification records.
- Active UI state is scoped to the selected work session.
- Chat forking creates a new project, runtime profile, chat session, generated workspace, baseline checkpoint, and work session. The fork records lineage with `forkedFromWorkSessionId`, `forkedFromCheckpointId`, and `forkedAt`.
- Forking from the history sidebar is a current-head fork: it copies the selected session's current workspace and full copied chat transcript.
- Forking from checkpoint history is point-in-time: it materializes the selected checkpoint commit into the new workspace and cuts the copied chat transcript at that checkpoint's `createdAt`.
- Forking from a Final summary/handoff card is also point-in-time: the client sends the `handoffId`, the server resolves the latest checkpoint at or before that handoff, materializes that checkpoint, and cuts the copied chat transcript at the handoff's `createdAt`. This prevents the fork from continuing from later messages or a later workspace state in the source chat.
- Final summary/handoff cards expose a "Changed files" action. It swaps the right workbench panel from Preview to `ChangedFilesPane`, calls `GET /api/work-sessions/{id}/changes?handoffId=...` for a durable file list, and loads a selected file's unified diff through `GET /api/work-sessions/{id}/changes/diff?handoffId=...&filePath=...`. Checkpoint-backed sessions show real git diffs; older or degraded sessions fall back to recorded change excerpts.
- Forked sessions derive `lastUserMessage` from the copied transcript rather than from the latest source session metadata, so follow-up planning starts from the fork's actual chat history.
- GitHub export is a control-plane workflow, not a coding-provider task. The workbench "Export to GitHub" action prepares a file manifest from `workSession.activeWorktreePath` or the latest checkpoint, supports device-login or `GITHUB_TOKEN`, creates/updates the repository through GitHub's Git Database API, updates `Project.repoUrl` only after success, records `GithubExportRecord[]`, and stores a report artifact with exported/ignored files.
- GitHub export never uploads likely-secret files. The scanner excludes them unconditionally (regardless of repo visibility, because a private repo can be made public later), records each as an ignored entry, and emits a manifest warning summarizing how many were withheld. The export dialog additionally shows a prominent warning whenever the selected visibility is `public`. This is the H2/M2 secret-leak mitigation; the security rationale lives under "Local-Only Network Security" alongside H1.
- GitHub's refs API returns `Git Repository is empty.` for empty repositories. The exporter handles this by creating a temporary seed file through the Contents API, then writing the real export commit on top of that seed tree so the final repository contains the workspace files and not the seed file.
- After a successful export, the UI defaults future exports for that work session to the same owner/repo/branch with update mode enabled. The backend also treats previously completed app-owned exports as update-eligible even if a stale client omits `updateExisting`.
- Updating an existing repository is **additive by default** (M1): the export commit adds/updates the exported files and leaves any other repo files in place. Deleting repo files that are not in the export (so the repo mirrors the workspace exactly) is a separate, explicit `writeMode: "replace"` opt-in — surfaced as the "Replace all repository contents" checkbox (only enabled when updating, off by default, with a destructive-action warning) and never inferred from history. `updateExisting` controls permission to write to an existing repo; `writeMode` controls whether non-manifest files are deleted; the two are independent. `GithubExportRecord.writeMode` persists the choice (legacy records normalize to `replace`, which is what they actually did), and the export report records which mode ran.
- Empty generated workspaces are scaffolded according to the detected stack before the selected provider receives implementation tasks.
- Workspace safety is checked before project creation, workspace selection, bootstrap, dependency research/install, preview startup, verification, and provider dispatch. Unsafe sessions emit `workspace.safety.blocked` plus `session.blocked` and do not launch a coding provider.
- Generated plan/task target paths must be workspace-relative and cannot use absolute paths or `..` segments to escape `workSession.activeWorktreePath`.
- After plan approval and before the first coding task, dependency research checks current registry versions online, updates stale declared npm packages in `package.json` and simple Python package lines in `requirements.txt`, records a report artifact, and attaches the summary to the active provider's task prompts.
- Dependency research artifacts are tagged with `reportType="dependency_research"` plus a compact summary, workspace path, plan id, package counts, and manifest update counts so they appear in the report library instead of being visible only through the timeline/artifact drawer.
- The verification-gate dependency install self-heals mechanical manifest defects before burning repair tasks. A bounded heal-and-retry loop (max 4 rounds with a no-progress guard) covers two classes: declared versions that do not exist on the registry (npm ETARGET "No matching version found" — rewritten to a caret of the registry latest) and root-declared versions that violate a dependency's peer range (npm ERESOLVE — the conflicting package is pinned to the newest registry version satisfying the peer range named in the error, exact pin so a caret cannot drift back out of a bounded range). Both healers matter because models add packages to package.json after dependency research has already run, so research-time peer checking cannot see them. Version resolution is always local (`npm view <name> versions` plus local range matching); semver range characters never reach the shell.
- User attachments and prior research excerpts are wrapped as untrusted source context in provider prompts. The prompt wrapper explicitly tells the model to treat those blocks as evidence only and ignore embedded tool requests, role claims, secret requests, or policy changes inside the source text.
- Approved project playbooks can be stored in the embedded DB and reused across runs. The executor prompt path for Codex CLI, Claude Code, AGY, and Ollama matches approved playbooks against the active task/session and injects only bounded trusted playbook summaries. Draft and archived playbooks are never injected.
- App/workspace skills can be managed from the toolbar Skills drawer next to Runtime. The drawer can create a skill from typed/pasted name, description, and Markdown body; import Markdown/text files through the same file-picker pattern as chat attachments; toggle enabled/implicit/trusted settings; show diagnostics for changed or untrusted skills; and delete app-owned `.skills` files. Workspace `.agents/skills/*/SKILL.md` files are discoverable but require trust before implicit use.
- Skill activation is provider-neutral. Before planning/execution prompts are assembled, the registry refreshes discovered skills, selects explicit name matches and high-scoring implicit matches from enabled/trusted skills, writes an `activated_skill_prompt` artifact, records `SkillActivationRecord[]`, emits `skill.activated`, and threads the rendered skill block into Codex CLI, Claude Code, AGY, and Ollama prompts as workflow guidance.
- The toolbar Memory drawer separates app-wide User Memory from Project Memory. User memories are typed/pasted app-level preferences or durable operator context, with active/dismissed status and pinning. Project memories are work-session/project facts with category (`architecture`, `style`, `constraint`, `verification`, `decision`, `handoff`), scope (`project`, `session`, `lineage`), status (`active`, `candidate`, `dismissed`), and pinning.
- Active user memories are injected before active project memories in executor context. Persistent Codex and Claude resume paths that skip the heavier orchestrator context still render user/project memory blocks, so provider switches and resumed native sessions keep durable memory without relying on raw cross-provider transcript replay. The current user request remains higher priority than stored memory.
- Orchestrator-managed `AGENTS.md` content is written into every workspace with stable begin/end markers. Existing user/project `AGENTS.md` content is preserved, and orchestrator-only `AGENTS.md` is ignored when deciding whether a workspace has user content.
- Supported scaffold targets include static HTML, Next.js, Vite React, Node CLI, Express-hosted vanilla web apps, Python scripts, Flask, Django, R scripts (`r-script`), and R Shiny apps (`r-shiny`). The Django scaffold includes runnable development settings for SQLite, templates, and static assets so simple server-rendered pages can preview without first repairing core settings. The R stacks mirror the Python ones: `r-script` is a generated-report stack (an `Rscript` entrypoint such as `main.R` whose plots/printed output are captured into a static report, like `python-script`), and `r-shiny` is a live-web stack (`shiny::runApp` served on a free port, health-checked and snapshotted like Flask/Django). R package dependencies are declared in a workspace `DESCRIPTION` (`Imports:`) and installed into a workspace-local `.rlib` (`R_LIBS_USER`) — the analog of Python's `.venv`/`requirements.txt` — by `syncRManifestDependencies` before dispatch and by the preview/verification install. The install (`rInstallExpression`) prefers binary packages on Windows/macOS (`type="binary"`, `.Platform$pkgType`-gated to fall back to source on Linux) so every package and its dependencies resolve from the same frozen binary repo for the installed R — avoiding the old-binary/new-source version-floor conflicts (e.g. "namespace 'promises' … is already loaded, but >= … is required") that otherwise break `install.packages`' default `type="both"` on an older R. `Imports:` entries are treated as bare package names; version constraints in `DESCRIPTION` are not currently enforced (binary preference already yields a self-consistent set for the installed R). `Rscript` is resolved by `lib/server/runtime/r-resolver.ts` from `RSCRIPT_BIN`/`R_BIN`, then PATH, then common install locations (including the globbed `C:\Program Files\R\R-*\bin` on Windows, since the R installer does not add itself to PATH). Verification for R is a syntax-parse gate (`Rscript -e invisible(parse(file=...))` for the entrypoint, or `app.R`/`ui.R`+`server.R` for Shiny).
- Plans are stack-aware. Vanilla Express web requests are normalized into one coherent app-surface task when appropriate, so route wiring, pages, shared assets, styling, and active-link behavior stay consistent.
- Spawned CLI providers are preflighted before execution. The health API reports availability, version, smoke execution where supported, resolved executable path, and explicit errors. The Claude Code doctor also runs `claude auth status --json` (short-TTL cached; execution preflight forces a fresh check) so "installed but not logged in" is distinguished from "not installed" in `/api/health` and the `/api/runtime-status` `diagnostics[]` auth check; a not-logged-in state fails both Claude execution and read-only research preflight with a clear message unless `ANTHROPIC_API_KEY`/`--bare` supplies auth.
- Executor task prompts contain task-specific context only; static runtime rules live in `AGENTS.md`.
- Codex runs are surrounded by workspace snapshots. Actual created, updated, deleted, and practical rename changes become `CodeChangeRecord[]` and `code.change.detected` events even when Codex stdout is vague.
- Checkpoints provide the authoritative final-summary diff boundary. `CodeChangeRecord.diffExcerpt` remains a compact fallback/telemetry field; the right-panel diff view uses checkpoint git history whenever possible so it can display actual per-file unified diffs.
- Task records track attempts and latest failure summary/fingerprint. Verification failures create bounded repair tasks, and repeated same-fingerprint failures escalate to a blocker/handoff instead of churning indefinitely. Execution failures without captured file changes block with details instead of creating code-repair tasks, because there is no generated-app delta to repair automatically.
- Completion requires acceptance-criteria evidence and render evidence for previewable web apps, not only a zero exit code. Evidence is mirrored into `.orchestrator/session.json`.
- Generated app preview is owned by the orchestrator, not by Codex.
- Final preview validation is part of the verification gate. The controller prefers to refresh/reuse an existing safe live preview before marking the session complete, falling back to a hard restart when the live preview is stale, incompatible, or fails health checks; if a previewable app cannot become ready, the same verification run is marked failed with render evidence and the repair loop continues instead of emitting `session.finished`.
- A user-triggered hard restart that leaves the latest preview failed can be turned into an explicit "Repair preview" action. The action queues a normal repair task from the failed preview command, health status, stdout/stderr tails, and recent code changes; completed plans are reopened to approved state so the normal controller loop can repair and re-verify.
- Ready web previews are inspected server-side with Playwright before completion. Snapshot capture stores a PNG screenshot artifact, bounded semantic DOM/report artifacts, console/page/network diagnostics, and runtime DOM/AX structural verification results.
- Failed runtime DOM/AX checks are classified as `functional_failure` and are repairable. Snapshot/browser setup failures that look environmental remain explicit environment blockers rather than false success.
- Static HTML previews use `scripts/static-preview-server.mjs`.
- Node, Next, and Vite previews are detected via `package.json` and started on free ports from `3100-3999`. Next/Vite dev servers, watcher-backed Node scripts (`nodemon`, `tsx watch`, `node --watch`, etc.), and static previews can be gently refreshed/reused; plain Node server processes and Python script report previews use hard restart/rerun semantics when code changes require it.
- Express/Fastify previews prefer `npm run dev`, fall back to `npm run start`, and can fall back to direct Node entrypoints such as `src/server.js`, `server.js`, `src/app.js`, or `app.js`.
- Python script previews detect runnable Python entrypoints instead of assuming only `main.py`. They run headlessly with `MPLBACKEND=Agg`, capture matplotlib figures from `plt.show()`, collect generated image/text outputs, and serve an HTML report with visual output, stdout, stderr, and source code.
- Python script previews are user-parameterizable. The Preview pane exposes a "Python run parameters" panel (entrypoint dropdown, argv, stdin, KEY=VALUE env, and matplotlib dpi/format/style) and a "Run with parameters" button for fast iterate-and-rerun without regenerating code. Parameters persist on the work session (`pythonRunParams`), are applied by the preview runner (`sys.argv`, piped stdin, merged env, `plt.rcParams`/`plt.style`, chosen figure format), and orchestrator-critical env keys cannot be overridden by user env. The preview iframe is remounted by preview ID so re-runs reload in place.
- The preview API supports `GET /api/work-sessions/{id}/preview` (selectable Python entrypoints plus current run parameters) and `POST` with an optional `runParams` body to persist parameters and start/restart the preview.
- Generic Node web apps with common server entrypoints are previewable; Node CLI apps remain non-previewable by design.
- Preview manager installs dependencies when `node_modules` is missing.
- Preview manager installs Python requirements before Python preview/verification when `requirements.txt` exists.
- Preview URL is shown in the UI and rendered in an iframe. Previews do not open external browser tabs automatically; use the explicit Open Preview button when a separate tab is desired. The Preview pane exposes Refresh for the default gentle path and Hard restart for an explicit clean server process. The iframe URL includes a preview-generation query string so refreshed/restarted previews reload even when the base port is reused. The iframe is sandboxed (`sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups"`): the generated app is served on a separate loopback port, so same-origin policy still isolates it from the control-plane origin and the `/api` proxy guard still blocks any cross-origin pivot. `allow-same-origin` is required — Next 16 serves its `/_next/...` dev chunks only to a same-origin document, so an opaque-origin sandbox (without `allow-same-origin`) makes Next reject those chunks as "from an unknown source" (HTTP 403), which silently breaks CSS and React hydration while bare HTML still loads.
- The right workbench panel can be replaced by the Final summary changed-files view. The view lists changed files by kind (`create`, `update`, `delete`, `rename`), selects the first file by default, loads diffs lazily per file, and includes a Preview button to return to the live iframe.
- The right workbench panel can also switch to a Reports view from the composer slash controls. `ReportsPane` calls `GET /api/work-sessions/{id}/reports` and lists research, dependency, verification, handoff, and tagged report artifacts with type, timestamp, summary, and an Open artifact link.
- Failed previews show a "Repair preview" action when the failure is repairable as generated-app code or dependency work. Environment-only failures such as port exhaustion or permission errors are rejected as local environment issues rather than sent to the coding provider.
- The chat UI auto-advances runnable backend states (`planning`, `queued`, `executing`, `verifying`) when no approval is pending, the session is not paused, no step is pending, and the autonomy level is not `manual`, so a transient page state does not leave the controller idle.
- Each work session has an autonomy level that governs how far the controller runs before stopping for the user:
  - `manual` pauses before every task execution and before verification; the user advances one action at a time with Step.
  - `checkpoint` auto-runs low-risk tasks but pauses before `medium`/`high`-risk tasks and before verification.
  - `supervised` auto-runs tasks and verification but pauses on the first verification failure before any automatic repair.
  - `full_auto` runs the whole loop without stopping (legacy behavior).
- When the controller stops at a gate it sets `awaitingStep` plus a human-readable `nextActionLabel`, surfaced in the UI Run controls bar. A Step authorizes exactly one gated action and then re-arms the gate.
- Individual tasks can be controlled after a plan starts. The plan-card task checklist exposes per-task Re-run and Skip. Re-run resets a done/blocked/skipped task to runnable (fresh attempt budget, evidence reset), accepts an optional one-line guidance nudge that is injected into that task's provider prompt (`task.metadata.steeringNote`), and reopens a completed plan so the loop runs again. Skip marks a task skipped and unblocks a session that was blocked on it. A not-started task's content can also be edited via the `edit` action. These are served by `POST /api/work-sessions/{id}/tasks/{taskId}` and the `rerunTask`/`skipTask`/`editTask` controller functions; advancement is left to the existing autonomy-gated tick/step loop.
- The Run controls bar (top of the workbench, sharing a row with the phase rail) exposes the autonomy selector, Pause/Resume, Step, and Abort. Pause persists `paused=true` and cancels active controller-owned operations such as validation or preview startup so the UI does not remain stuck in a running phase. Abort targets both provider process trees and controller-owned operations, immediately persists the session as `canceled`, and marks any running verification record failed. Canceled sessions are terminal for the auto-run loop, so a missing in-memory registry entry or late verification callback cannot restart validation after Abort.
- New work sessions adopt `DEFAULT_AUTONOMY_LEVEL` (unset defaults to `checkpoint`); existing sessions in older databases normalize to `full_auto`. Autonomy can be changed per session at any time from the UI.
- Each work session carries optional runtime overrides and a steering note, set from the Run controls "Runtime" drawer. Provider-specific overrides are applied at dispatch time: Codex uses model, reasoning effort, speed tier, sandbox, network, and timeout; Claude Code uses model, effort, speed tier, and timeout, with effort cleared for Haiku-style models that do not support thinking and Fast exposed only for Opus-capable models; AGY uses model and timeout, applying the selected model to Antigravity settings before planning/research/execution while leaving context and permissions to Antigravity settings/env; Ollama uses model, temperature, context length, and timeout. The steering note is injected into the planner prompt and every executor prompt so the user can shape generation (e.g., "use TypeScript strict; no chart libraries") without re-describing it each turn. Overrides live on the work session, not the runtime profile, because `applyRuntimeConfigToProfiles` rewrites profile fields from config on every read.
- Telegram exposes the same per-session runtime controls through `/runtime`, `/provider`, `/model`, `/think`, `/speed`, and `/timeout`. These commands use the shared runtime-control service rather than mutating DB fields directly, so one-field Telegram updates merge with existing overrides and still pass provider-specific validation. Viewers can inspect runtime settings and model catalogs; operators can change provider/model/thinking/speed/timeout while the selected session is idle.
- Runtime model and speed-tier choices are fetched through `/api/runtime-options`. Codex uses `codex debug models` for models, reasoning levels, context windows, and `service_tiers`, and reads `service_tier` from `~/.codex/config.toml` as the inherited default; Ollama uses `/api/tags`; Claude Code derives a cached local catalog from structured Claude Code usage plus `~/.claude/settings.json`/env defaults and alias fallbacks, and adds a Fast service tier for Opus-family models; AGY derives its model catalog from the current `~/.gemini/antigravity-cli/settings.json`, AGY model-selection logs, and installed-client `@default` model keys. Server-side runtime save/execution paths validate provider-appropriate fields, clear stale combinations when switching providers, and fall back to configured defaults when needed.
- `/api/runtime-status` now returns a `diagnostics[]` runtime-doctor list in addition to quota/context/compaction. The Runtime drawer shows provider, model, context, quota, tooling, and compaction checks with degraded/unknown/unavailable states instead of forcing the user to infer runtime health from raw status text.
- Ollama implementation tools are selected from a mode-aware catalog. `/api/runtime-tools?mode=plan|research|execute|repair` exposes the allowed tool metadata, and the execution path checks policy before running any workspace tool. Mutating tools such as `write_file` and `delete_file` are rejected in plan/research modes even if a model asks for them.
- Agent-run progress is replayable through `GET /api/work-sessions/{id}/runs/{agentRunId}/events`. The endpoint returns the persisted agent run, its matching events, tool runs, and artifacts, which gives clients a durable recovery path after reloads or dropped SSE connections.
- Agent final replies, provider-captured thinking, and replayable progress deltas are available through `GET /api/work-sessions/{id}/runs/{agentRunId}/transcript`. Timeline reply notes render a collapsed "Show progress" control for completed/failed runs; expanding it shows native reasoning when the provider exposes it and replayed `agent.process.output.delta` activity from the live activity card. The run's user-facing message is rendered separately as a "Reply" card below the progress/details area, using the run summary immediately and the latest transcript `finalText` after the transcript payload loads.
- Native Codex app-server subagents are modeled as Codex threads, not extra orchestrator processes. Live `collabAgentToolCall` notifications update `codexSubagents` and `codexCollabCalls`, child-thread approval requests keep source thread metadata, and the Runtime drawer shows the root thread, subagent tree, recent collab operations, and native thread rollback.
- Native subagent execution defaults to `CODEX_MULTI_AGENT_MAX_THREADS=8` total Codex threads, including the root thread. Codex's effective child capacity is one less than that value, so the default allows up to seven native subagent threads per root session. The app injects shallow-delegation guidance that asks the root to spawn direct children, asks children to report back instead of nesting more agents unless necessary, and tells agents not to override model/reasoning unless the user explicitly requested it.
- Requests that explicitly mention Codex subagents require native Codex app-server unless the operator deliberately selects `exec-only`. In `auto`/`app-server-only`, native startup failure is surfaced instead of silently becoming a normal exec run, so missing native thread UI is explicit. If a native collab tool call is still `inProgress` when its parent app-server turn closes, the app marks it `stale` and records the reason so the Runtime drawer does not show permanent "mailbox" starts for calls that never returned a child thread.
- Codex app-server interrupted turns are classified by the app's own control-plane state. A process-registry Abort or steering interrupt remains a user/control interruption; a Codex-reported `interrupted` turn with no recorded abort reason is treated as a runtime failure, and if file changes were captured it remains repairable through the normal execution-repair path instead of being blocked as a user abort.
- Codex app-server `error` notifications nest their diagnostic under `params.error` (v2 `ErrorNotification` is `{error, willRetry}`). The runtime extracts the top-level message, then the nested `error.message`, then a serialized-params fallback, so transcripts and failure summaries carry the provider's actual error text instead of a generic "Codex app-server error." label.
- Native subagent tooling degrades gracefully on provider capability mismatches. If a turn fails because the provider rejected the request's tool declarations (for example a model that does not accept the encrypted-parameter form of `spawn_agent`, as happened with `gpt-5.3-codex-spark` under Codex CLI 0.138.0) and the turn produced no agent output and no collab calls, the runtime retries the turn exactly once on a fresh thread with `features.multi_agent_v2` disabled. The retry is recorded in the transcript and as a high-priority `task.progress` event, so the run completes single-agent instead of blocking the session on an upstream model/CLI incompatibility.
- Codex planner/research runs remain logically read-only. On Windows, where Codex CLI `--sandbox read-only` can fail during sandbox setup before file tools run, the app launches those read-only Codex runs with a configurable fallback sandbox and enforces no workspace changes by before/after diff. Any mutation fails the run instead of accepting the result.

## Critical Environment Settings

### Coding providers (Codex CLI, Claude Code, AGY CLI, Ollama)

The executor provider is selectable **per work session** from the Run controls provider selector and Runtime drawer, defaulting to `AGENT_PROVIDER`. The choice lives on the work session as `agentProvider` (null = inherit the configured default) and is applied at plan, research, and task-dispatch time. Switching providers clears stale provider-specific runtime overrides.

The providers are architecturally different:
- **Codex CLI** is a full agent the orchestrator runs native-first through Codex app-server for implementation tasks, with `codex exec` retained as the guarded planner/research path and legacy execution fallback. Codex inspects files and applies edits inside its own sandbox.
- **Claude Code** is a full agent the orchestrator *spawns* (`claude`). The orchestrator writes long prompts to `.orchestrator`, passes a short launcher prompt, registers the process for abort/steering, and captures filesystem diffs. A per-session **Ultracode** toggle (Runtime drawer, Claude only; default off) clears the spawned agent to orchestrate its own subagents / run a Workflow (multi-agent fan-out) for a task — it widens `--tools` to include `Task`/`Workflow`, raises the turn ceiling, and applies a USD budget ceiling. Subagents inherit the same worktree permission gate, so ultracode runs stay workspace-confined under every autonomy level; they cost substantially more tokens.
- **AGY CLI** is a full agent the orchestrator *spawns* (`agy --print`). The orchestrator scopes the workspace with `--add-dir`, disables AGY auto-update during app-owned runs, writes long prompts to `.orchestrator`, registers the process, captures filesystem diffs, and rejects silent no-op success.
- **Ollama** is a bare model API the orchestrator *wraps* in its own loops. The orchestrator becomes the sandbox: every tool call is confined to the work session workspace. Implementation tasks get the write-capable loop (`list_dir`, `read_file`, `write_file`, `delete_file`, `finish`); research requests get a separate read-only loop (`list_dir`, `read_file`, `search_text`, `finish`). Models without native tool-calling are driven via parsed text-directive envelopes. Change detection, verification, the completion/render gate, repair loop, checkpoints, and acceptance evidence are all reused unchanged for implementation work because they sit downstream of the shared `RuntimeExecutionResult` and the filesystem diff.

Per-session runtime options come from `/api/runtime-options?provider=<codex-cli|claude-code|antigravity-cli|ollama>`. Codex and Ollama expose real model catalogs. Codex exposes Speed tier choices from the CLI model catalog and applies them through `service_tier`; explicit "Standard" is represented as an override that clears a configured fast/priority tier. Claude Code exposes a dynamic local catalog built from structured Claude Code usage (`~/.claude/stats-cache.json` and assistant `message.model` fields in project JSONL logs), configured settings/env model defaults, and Claude aliases as a fallback, with no context-window control; the Runtime drawer disables thinking level selection for Haiku-style models and shows Fast only for Opus-capable models. Claude Fast/Standard is applied by sending `/fast on` or `/fast off` to the persisted Claude session before the task turn, so explicit Claude speed-tier overrides require `CLAUDE_PERSISTENT_SESSIONS=true`. AGY exposes model selection by reading/writing Antigravity CLI settings before launch, but context, speed tier, and permission behavior remain owned by Antigravity CLI settings/env rather than the orchestrator UI.

The per-session provider drives the **whole loop, not just execution**: `generatePlan` receives the session's effective provider (`workSession.agentProvider ?? config.agentProvider`), so Codex/Claude/AGY/Ollama sessions plan through their selected CLI/LLM provider when supported. Planner failures fail closed with the provider error; the app does not substitute a local plan because that can produce the wrong app. If no working planner provider is available, the user must switch to a working CLI/LLM or fix the selected runtime. Read-only research uses the same effective provider and still produces `research_full_report` artifacts plus Markdown chat summaries. The provider selector is disabled while a run is executing.

Executor prompts include a compact cross-provider handoff section built from prior in-history `AgentRunRecord.summary` values. This lets a newly selected provider see what recent Codex CLI, Claude Code, AGY CLI, or Ollama runs did without loading another provider's native session transcript. `CROSS_PROVIDER_BRIEF_RUNS` caps how many prior runs are injected; set it to `0` to disable the section. When `CROSS_PROVIDER_TRANSCRIPT=true`, the controller also writes provider-neutral transcript turns to `.data/transcripts/<workSessionId>.jsonl`; on provider switches it creates a compact cross-provider handoff and injects that distilled brief instead of raw transcript or reasoning.

To use Ollama:
- Start the local Ollama service at `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`).
- Install at least one model with Ollama, for example via `ollama pull <model>`.
- Either set `AGENT_PROVIDER=ollama` for the default provider or switch a specific work session from the Run controls provider selector / Runtime drawer.
- Choose an installed Ollama model in the Runtime drawer, or set `OLLAMA_MODEL=<installed-tag>` as the default. Leaving `OLLAMA_MODEL` blank forces a per-session model choice before Ollama execution/research can run.
- Prefer code-capable, tool-capable local models for implementation work. If a model rejects native tools, the app falls back to directive mode (`<<<WRITE>>>` for implementation, `<<<READ>>>`/`<<<SEARCH>>>`/`<<<FINISH>>>` for research), but weaker models may need more repair iterations.

### GitHub export

GitHub export is available from the workspace toolbar. Set `GITHUB_CLIENT_ID` to the client ID of a GitHub OAuth App with device flow enabled, or set `GITHUB_TOKEN` for a local non-interactive token. In the GitHub OAuth App form, use `http://127.0.0.1:3000` for both Homepage URL and Authorization callback URL; device flow does not use the callback during login, but GitHub requires one. OAuth login requests `repo` plus `workflow` so private repositories and workflow-file updates can work. During login the app displays GitHub's device verification code and opens the GitHub verification page; the user enters that code in GitHub and authorizes the app. If `GITHUB_TOKEN_ENCRYPTION_KEY` is omitted, the app creates a local `.data/github-token.key` and uses it to encrypt the OAuth token envelope in `.data/github-auth.json`.

```env
AGENT_PROVIDER=codex-cli
# Default autonomy level for NEW work sessions: manual | checkpoint | supervised | full_auto
# Unset/blank defaults to checkpoint (safe). full_auto removes the human gate - explicit opt-in only.
DEFAULT_AUTONOMY_LEVEL=checkpoint
# Optional Codex defaults (per-session UI overrides take precedence)
CODEX_MODEL=
CODEX_REASONING_EFFORT=
# Leave blank to auto-discover Codex CLI from PATH/common install locations.
CODEX_CLI_BIN=
CODEX_SANDBOX_MODE=danger-full-access
# Windows-only fallback used for Codex read-only planning/research when the native read-only sandbox is unavailable.
# Allowed: danger-full-access | workspace-write. The app still enforces no workspace changes by diff.
CODEX_READONLY_WINDOWS_FALLBACK_SANDBOX=danger-full-access
CODEX_APPROVAL_POLICY=never
CODEX_TIMEOUT_MS=300000
CODEX_TRANSPORT_MODE=auto
CODEX_APP_SERVER_FALLBACK=true
CODEX_NATIVE_THREAD_PERSISTENCE=auto
# Total native Codex app-server threads for a root session, including the root thread.
# Effective direct subagent capacity is this value minus one.
CODEX_MULTI_AGENT_MAX_THREADS=8
# Claude Code spawned-agent provider. Leave CLAUDE_CODE_BIN blank to auto-discover.
CLAUDE_CODE_BIN=
CLAUDE_MODEL=
# Optional automatic fallback model (--fallback-model, execute path only): if the primary is overloaded
# or retired mid-run, Claude transparently retries on this model so the run completes. Validated against
# the model catalog; ignored if it resolves to the same model as the primary. Blank = no fallback.
CLAUDE_FALLBACK_MODEL=
CLAUDE_EFFORT=
CLAUDE_TIMEOUT_MS=600000
# Agentic-loop bound for the write/execute turn, emitted as --max-turns.
CLAUDE_MAX_TURNS=24
# Leave blank to derive --permission-mode from the session autonomy level (full_auto → bypassPermissions,
# others → acceptEdits). Set a concrete value (acceptEdits|auto|bypassPermissions|default|dontAsk|plan) to override.
CLAUDE_PERMISSION_MODE=acceptEdits
CLAUDE_TOOLS=Read;Edit;Write;Glob;Grep
CLAUDE_DISALLOWED_TOOLS=Bash;WebFetch;WebSearch
# Ultracode (multi-agent) mode. Global default for the per-session Runtime-drawer toggle (Claude only).
# When ON, the execute turn is cleared to orchestrate subagents / run a Workflow: --tools is swapped to
# CLAUDE_ULTRACODE_TOOLS (which must include Task + Workflow), the orchestration tools are removed from the
# --disallowedTools set, --max-turns is raised to CLAUDE_ULTRACODE_MAX_TURNS, and --max-budget-usd is set to
# CLAUDE_ULTRACODE_MAX_BUDGET_USD when no global CLAUDE_MAX_BUDGET_USD is set. Subagents inherit the same
# --permission-prompt-tool worktree gate (verified), so non-full_auto runs stay workspace-confined. Bash is
# excluded from the default ultracode tool set. Off path is byte-for-byte unchanged.
CLAUDE_ULTRACODE=false
CLAUDE_ULTRACODE_TOOLS=Read;Edit;Write;Glob;Grep;Task;Workflow
CLAUDE_ULTRACODE_MAX_TURNS=200
CLAUDE_ULTRACODE_MAX_BUDGET_USD=5
# Opt-in extra read/tool-access roots granted to the execute turn (--add-dir, one per entry). Grants file
# ACCESS only, NOT config/CLAUDE.md discovery. Non-existent entries are dropped. Blank = none (legacy).
CLAUDE_ADD_DIRS=
# Hardening: disable slash-command/skill parsing on the task execute turn (--disable-slash-commands) so a
# task/attachment line starting with `/` can't be read as a command. The /fast and /compact control turns
# are unaffected. Default false (skills stay available on the execute turn).
CLAUDE_DISABLE_TASK_SLASH_COMMANDS=false
CLAUDE_EXTRA_ARGS=
# Tool-call-level autonomy gating (non-full_auto routes tool calls through the orchestrator MCP
# permission server for worktree-confinement). Set false for legacy acceptEdits behavior with no gate.
CLAUDE_PERMISSION_GATING=true
# Execute-turn transport. "auto" (default) = stream-json stdin kept open for live mid-turn steering
# injection and graceful protocol interrupts (instead of SIGKILL), with a startup-only fallback to the
# legacy text path; "stream" = stream only; "text" = legacy one-shot text stdin (kill switch).
CLAUDE_TRANSPORT_MODE=auto
# Optional deterministic settings delivery (blank = no flag emitted = legacy behavior untouched).
CLAUDE_SETTINGS_JSON=
CLAUDE_SETTING_SOURCES=
# Google Antigravity CLI spawned-agent provider. Leave AGY_CLI_BIN blank to auto-discover.
AGY_CLI_BIN=
AGY_TIMEOUT_MS=600000
AGY_SANDBOX=false
AGY_DANGEROUSLY_SKIP_PERMISSIONS=false
AGY_EXTRA_ARGS=
# Local Ollama provider (orchestrator-owned agent loop). Blank OLLAMA_MODEL forces a per-session UI choice.
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=
OLLAMA_TIMEOUT_MS=600000
OLLAMA_MAX_ITERATIONS=24
OLLAMA_TOOLS_MODE=auto
OLLAMA_TEMPERATURE=0.2
OLLAMA_NUM_CTX=
OLLAMA_KEEP_ALIVE=5m
# Cross-provider prompt continuity. Set to 0 to disable prior-run summaries.
CROSS_PROVIDER_BRIEF_RUNS=6
# Optional structured transcript side files and switch-time distilled handoffs.
CROSS_PROVIDER_TRANSCRIPT=false
PYTHON_BIN=
NPM_BIN=
PNPM_BIN=
YARN_BIN=
BUN_BIN=
DOTNET_BIN= # Optional .NET SDK path; Windows previews also auto-discover C:\Program Files\dotnet\dotnet.exe.
# Verification-only trust flag; never selects the app root as an implementation workspace.
ALLOW_APP_ROOT_VERIFICATION=true
# Recommended Node gate. Inline " #" comments truncate the semicolon list there; build commands are
# additionally filtered out unless the user request explicitly asks for build verification. Each run
# emits verification.commands.resolved (configured vs resolved commands) and the summary carries a
# gate advisory when the workspace declares standard scripts (typecheck/lint/test/build) the gate never runs.
VERIFY_COMMANDS=npm run typecheck;npm run lint;npm run build
# "manifest-only" (default): a successful dependency install auto-completes a task only when its
# targetFiles are limited to package.json/lockfiles; otherwise the install becomes a pre-flight
# (task.progress mode=preflight_for_executor) and the executor still runs the task with a
# "Dependency pre-flight" prompt block. "legacy" restores unconditional auto-completion.
DEPENDENCY_TASK_AUTOCLOSE=manifest-only
# Dispatch-time evidence blocks (lib/server/dispatch-context.ts), both default true.
# Retry context: on attempt >= 2 of a task, all providers get fresh failure evidence compiled at
# dispatch (last failure summary/fingerprint, prior-attempt summaries, files those attempts changed).
# Repair tasks are NEW records (attempt 1), so the same flag also covers repair lineage: repair
# task #2+ in a plan gets prior repair outcomes, files they changed, and a fingerprint verdict
# (identical fingerprint = "the previous repair did not clear this failure; diagnose differently").
DISPATCH_RETRY_CONTEXT=true
# Session continuity: prior task outcomes + files changed so far, injected ONLY for providers without
# native cross-turn memory (AGY, Ollama compact variant, Claude when CLAUDE_PERSISTENT_SESSIONS=false).
# Codex threads and persistent Claude sessions never receive it (their transcript already knows).
DISPATCH_CONTINUITY_CONTEXT=true
PREVIEW_HOST=127.0.0.1
PREVIEW_PORT_START=3100
PREVIEW_PORT_END=3999
PREVIEW_AUTO_OPEN=false # Deprecated/no-op; previews stay embedded unless opened explicitly from the UI.
SNAPSHOT_CAPTURE_ENABLED=false
FUNCTIONAL_VERIFICATION_ENABLED=false
FUNCTIONAL_CHECK_TIMEOUT_MS=45000
# Interaction probe depth for browser inspection. "basic" (default): single safe-verb probe, legacy
# behavior. "extended": probes up to 3 forms per page on the root + up to 2 linked same-origin routes,
# runs an empty-submit negative-path probe on mutating forms BEFORE filling (pass = graceful rejection:
# inline error or 4xx; fail = uncaught page error or 5xx), and promotes probe outcomes to first-class
# functional verification specs (a failed probe fails verification with the probe record as evidence;
# render-quality checks are judged on pre-probe signals only). The unsafe-verb list (delete/remove/
# reset/clear/logout/drop/destroy) on the clicked submitter remains the safety boundary at both levels.
# Functional verification also enforces a home-interactivity floor at every probe level: when the
# workspace declares >=2 server view templates (.ejs/.pug/.hbs/.blade.php/.cshtml/...), the rendered
# home page must expose at least one link, form, or control. Route detection is file-layout-only and
# cannot see Express/Flask code-declared routes, so this floor is what catches a stubbed or
# static-shadowed home page that would otherwise pass vacuously.
# Browser-initiated request cancellations (net::ERR_ABORTED — navigation cutting off an open
# SSE/EventSource stream, download takeover, dropped prefetch) are recorded informationally as
# abortedRequests and never count as probe or render failures; only real network failures
# (CONNECTION_REFUSED, timeouts, 5xx) do. Functional failure rawOutput ends with a plain-text
# FAILED CHECKS digest so the repair task's tail excerpt always carries the failing evidence.
INTERACTION_PROBE_LEVEL=basic
BROWSER_HEADLESS=true
# Optional: send domain events to an external sink. Low-priority events are batched.
EVENT_WEBHOOK_URL=
# Optional Telegram remote control. Disabled by default; run `npm run dev:all` for app + Telegram,
# or run `npm run telegram` separately when the app is already running.
TELEGRAM_CONTROL_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_CONTROL_APP_URL=http://127.0.0.1:3000
TELEGRAM_CONTROL_WORKER_TOKEN=
TELEGRAM_CONTROL_ALLOWED_USER_IDS=
TELEGRAM_CONTROL_ALLOWED_CHAT_IDS=
TELEGRAM_CONTROL_GROUPS_ENABLED=false
TELEGRAM_CONTROL_ACTIVITY_EVENTS=true
TELEGRAM_CONTROL_NOTIFY_EVENTS=approval.requested;session.blocked;session.failed;session.finished;verification.failed;preview.ready;preview.failed;task.timeout.needs_decision
TELEGRAM_CONTROL_MAX_TEXT_CHARS=4000
TELEGRAM_CONTROL_SEND_PREVIEW_SCREENSHOTS=false
TELEGRAM_CONTROL_MAX_SCREENSHOT_BYTES=10485760
```

## Local-Only Network Security

This control plane has no per-request authentication and, by design, can drive coding agents
with full filesystem and network access. "Runs locally" is treated as a hard boundary, enforced
in two layers so that neither the LAN nor a browser can reach the API:

- **Loopback bind.** `npm run dev` and `npm run start` pass `-H 127.0.0.1`, so the server listens
  only on loopback and is never exposed to other devices on the network. (Do not re-add a `0.0.0.0`
  host or a `-H` override that widens this.)
- **Request guard (`proxy.ts`).** A Next.js proxy guard runs on every `/api/:path*` request and
  returns `403` unless:
  - the `Host` header is loopback (`localhost`, `127.0.0.0/8`, or `::1`) — this defeats DNS-rebinding,
    where a malicious domain resolves to `127.0.0.1` but still carries its own `Host`; and
  - the `Origin` header, when present, exactly matches the control-plane request origin (scheme,
    hostname, and port) — this defeats CSRF and also blocks generated preview pages on other loopback
    ports from calling `/api/*`. Same-origin app fetches pass; non-browser local clients such as Codex
    hooks send a loopback `Host` and no `Origin` and pass.

Why this matters: a single unauthenticated `POST /api/chat` with `{ "content": "..." }` falls back to
the first project's work session and drives the full plan/execute loop (default autonomy
`full_auto`, Codex sandbox `danger-full-access`). Without these two layers, any website open in the
user's browser or any peer on the same WiFi could task an agent with full local access. The guard is
intentionally strict; it is not a CORS allowlist and should not be relaxed to permit external origins.

Telegram control adds an explicit second boundary for remote messaging. Telegram never receives direct access
to the unauthenticated local API. A separate worker polls Telegram and forwards normalized updates to
`/api/telegram-control/*` over loopback with `TELEGRAM_CONTROL_WORKER_TOKEN`. The server then checks the
numeric Telegram user ID, optional group chat allowlist, per-user role, command-specific permission, and
short-lived callback nonce before invoking controller operations. Pairing codes are generated locally through
`npm run telegram:pair`, stored only as hashes, expire quickly, and are single-use. Group control is off by
default; enabling it requires both `TELEGRAM_CONTROL_GROUPS_ENABLED=true` and explicit numeric chat IDs.
The worker token is an admin-equivalent credential, so `scripts/telegram-shared.mjs` (used by both the
worker and `telegram:pair`) fails fast unless `TELEGRAM_CONTROL_WORKER_TOKEN` is at least 24 characters
and `TELEGRAM_CONTROL_APP_URL` is loopback (a non-loopback target is allowed only over https), so the
token is never shipped off-box over cleartext http. Additional hardening: pairing codes are 64-bit and a
per-user failed-attempt counter locks a user out after repeated wrong codes (T-B); every inbound Telegram
update is processed at most once via a recorded `update_id` dedup, so replays are dropped (T-C); an admin
`/revoke USER_ID` writes a revoked stored principal that overrides the env allowlist, so even an
`TELEGRAM_CONTROL_ALLOWED_USER_IDS` admin can be disabled at runtime (T-D); and the worker no longer echoes
internal error text into the chat, logging it locally instead (T-E).
`TELEGRAM_CONTROL_ACTIVITY_EVENTS=true` sends concise phase notifications such as "Reading your request",
"Drafting the plan", "Working on a task", and "Running verification" without forwarding raw provider output.
`TELEGRAM_CONTROL_SEND_PREVIEW_SCREENSHOTS=false` keeps screenshot uploads disabled by default. When enabled,
the notification collector waits for `snapshot.completed`, then the worker downloads only screenshot PNG
artifacts through `/api/telegram-control/artifacts/:id`; that route is worker-token protected, checks that
the Telegram chat is still bound to the artifact's work session, and enforces `TELEGRAM_CONTROL_MAX_SCREENSHOT_BYTES`
before the worker uploads the image to Telegram.

### Spawned-process environment hygiene (H3)

`lib/server/runtime/env.ts` exposes two environment builders so secrets are not handed to child
processes:

- `createSanitizedProcessEnv` — broad inherited environment for **trusted orchestrator tooling**
  (verification, preview dev servers, dependency install/research, provider doctors). It now also
  strips the orchestrator's own secrets (`GITHUB_TOKEN`, `GITHUB_TOKEN_ENCRYPTION_KEY`, any
  `GITHUB_*` token/secret/encryption variant, `GITHUB_CLIENT_ID`, `EVENT_WEBHOOK_URL`) — none of
  which npm/node/python need — in addition to the existing noisy `NODE_ENV`/Next/npm keys.
- `createAgentProcessEnv` — **minimal allowlist** for the spawned coding agents (Codex CLI/Claude Code CLI/AGY CLI
  execution). Because these processes act on untrusted task text and have network egress, they
  receive only shell/system basics, TLS/proxy and locale settings, and the runtime/tool auth/config
  namespaces they need (`ANTHROPIC_`/`CLAUDE_`/`OPENAI_`/`CODEX_`/`GEMINI_`/`GOOGLE_`/`AGY_`/
  `ANTIGRAVITY_`/`OLLAMA_`/`AZURE_OPENAI_`, plus `LC_`/`XDG_`/`PROCESSOR_`). These are environment namespaces, not the app's provider list. Agents authenticate via
  their config files under `HOME`/`APPDATA`, which remain reachable. Ambient secrets such as unrelated
  cloud credentials are NOT exposed to agents. Per-call overrides are applied last. The Codex/Claude/
  AGY adapter execution spawns use this builder; planner/research/doctor spawns still use the broad
  (secret-stripped) builder. Ollama is HTTP, not a spawned process, so it is unaffected. When adding a
  new runtime env var an agent legitimately needs, extend the allowlist (exact key or namespace
  prefix) in `env.ts` — do not switch the agent back to the broad inherited environment.

### ML pipeline isolation and hazards (H4)

The optional ML/experiment pipeline (`python-ml` stack, `lib/server/ml/*`) is **default-OFF**
(`ML_PIPELINE_ENABLED=false`). When off, the stack resolver collapses `python-ml` to `python-script`,
the experiment API rejects requests, the doctor returns a cheap disabled result, and every new code
path is unreachable, so the default build behaves exactly as before. When on, these hazards apply:

- **Untrusted weights are arbitrary code execution.** `torch.load`/`joblib`/pickle and HuggingFace
  custom architectures (which need `trust_remote_code=True`) run attacker-controlled code on load. The
  posture: scaffolds prefer safetensors and `weights_only=True` loads, the methodology guidance tells
  the planner to pin a model revision and hash, and `trust_remote_code` is an explicit recorded
  decision (`ML_TRUST_REMOTE_CODE=false` by default, surfaced in the provenance artifact's policy
  block). This sits alongside H1/H3 because the threat model is the same: untrusted input reaching a
  process with execution and egress.
- **ML secrets never reach task-driven agents.** `createAgentProcessEnv` is unchanged. ML jobs use a
  dedicated `createMlJobProcessEnv`, which starts from the secret-stripped base and additionally
  removes ML provider tokens (`HF_TOKEN`, `HUGGINGFACE_HUB_TOKEN`, `WANDB_API_KEY`, `KAGGLE_KEY`,
  `OPENAI_API_KEY`, etc.) unless `ML_ALLOW_SECRETS=true`. Redaction covers `hf_...` tokens.
- **Egress is gated.** Model/dataset downloads are treated like dependency installs (visible, bounded,
  cached under `ML_CACHE_DIR`). When `ML_ALLOW_NETWORK_DOWNLOADS=false`, the job env sets
  `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE`. pip dependency installs remain online (a normal install). On
  Windows the cache root defaults to `%LOCALAPPDATA%\acf-ml-cache` (not the deep project `.data/ml-cache`):
  HuggingFace `datasets` mangles the full absolute cache path into lock/builder folder names, which under a
  deep project path blows past the 260-char `MAX_PATH` limit and fails dataset loads with `[Errno 2] No such
  file or directory`. A short cache root keeps those derived paths well under the limit. `ML_CACHE_DIR`
  overrides it; posix keeps `.data/ml-cache`.
- **Resource governance.** Heavy installs are refused below `ML_DISK_BUDGET_MB` free disk; a
  single-GPU mutex (`gpu-mutex.ts`) prevents two accelerator jobs from mutually OOMing; a pure VRAM
  preflight (`vram-preflight.ts`) estimates memory and either downshifts (gradient checkpointing,
  smaller micro-batch with compensating grad-accum, shorter sequence) or refuses rather than crash;
  jobs run under a liveness/timeout budget and register in the operation/process registries so Abort
  tree-kills them. GPU use additionally requires `ML_ALLOW_GPU=true` (default off => CPU-only). The
  disk-budget refusal is computed independently of the (sometimes-flaky) host doctor probe -- it falls back
  to a direct `freeDiskMb(workspacePath)` check -- so a low-disk install always fails with the clear
  "requires at least N MB free disk" message instead of a later cryptic empty pip failure; and an install
  that exits non-zero with no captured output reports an explicit disk-full/killed hint rather than a bare
  "Dependency install failed". Subprocess timeouts are clamped in `runtime/process-runner.ts` to Node's max
  timer delay (2,147,483,647 ms): a too-large `ML_JOB_TIMEOUT_MS` (or any caller value over ~24.8 days)
  would otherwise overflow `setTimeout`, which Node silently coerces to 1 ms and fires immediately --
  insta-killing every ML subprocess as a phantom "timed out, no output". The clamp makes a huge timeout mean
  "effectively no timeout" instead of "kill instantly".
- **GPU/venv readiness is verified, not assumed (single source of truth).** The only authority on
  whether a run can use CUDA is a probe of the per-project `.venv` (`probeVenvCapability` in
  `runtime/ml-doctor.ts`), persisted to `.orchestrator/experiment/venv-capability.json`; the host
  doctor stays advisory only (VRAM budget, scaffold hint). When `ML_ALLOW_GPU=true` and torch is
  requested, the installer (`ml-installer.ts`) forces a validated CUDA wheel: a two-step
  `pip install --index-url <pytorch cuda index> <pinned torch specs>` then `-r requirements.txt`, with
  the CUDA tag validated against a published allowlist (`resolveCudaIndexTag`, default
  `ML_DEFAULT_CUDA_TAG=cu124`). Because pip will not replace an already-satisfied CPU torch, the helpers
  `--force-reinstall` from the CUDA index when a non-CUDA torch is present, and `verifyVenvTorchInstall`
  is the authoritative final step: it re-probes, repairs (force-reinstall CUDA) when a later
  `-r requirements.txt` resolution downgraded torch to a PyPI CPU wheel, and throws a remediation
  `MlInstallError` if the venv still cannot use CUDA (bypass with `ML_REQUIRE_VENV_CUDA_VERIFY=false`). The
  repair and the throw only fire when torch is *actually installed* (`capability.torchInstalled`): a
  requirement whose PEP 508 marker excludes the platform (e.g. `torch; platform_system != "Windows"`, which
  pip skips on Windows) leaves torch legitimately absent and does not trip the CUDA gate -- marker evaluation
  is deferred to pip rather than re-implemented, and a genuine install failure still surfaces via the pip
  non-zero exit.
- **One installer for all three venv paths.** The experiment runtime, the Python Script Preview
  (`preview-manager.ts`), and verification (`verification.ts`) all route ML-workspace torch installs
  (`mlPipelineEnabled` + torch in requirements + an `experiment.json` manifest) through the shared
  `analyzeRequirements`/`ensureCudaTorch`/`verifyVenvTorchInstall` helpers, so a verified CUDA venv is
  provisioned whether the user runs via Preview or the Experiment panel. When `ML_ALLOW_GPU` is off
  (default) these are no-ops and the plain `pip install -r requirements.txt` path is unchanged; non-ML
  python stacks are never affected.
- **Run-parameter contract (orchestrator <-> agent scripts).** The panel/`MlRunConfig` is canonical
  camelCase, but agent-authored Python reads idiomatic snake_case, so `run-config.ts` bridges both:
  `projectRunConfigForDisk` (used by `writeRunConfig`) emits every numeric knob at top level in BOTH
  conventions (`maxSteps`+`max_steps`, `gradAccum`+`gradient_accumulation_steps`, `lr`+`learning_rate`,
  `epochs`+`num_epochs`/`num_train_epochs`, `subsetLimit`+`subset_limit`,
  `batchSize`+`per_device_train_batch_size`/`batch_size` -- aliases listed once in `RUN_CONFIG_ALIASES`),
  flattens `decode.*` to top level (so a flat `maxNewTokens`/`temperature`/`top_p` reader works), and hoists
  arbitrary `extra` key=value pairs to top level (skipping reserved names, never clobbering). Nulls stay null
  so a script keeps its own defaults (purely additive). `normalizeMlRunConfig` canonicalizes the same
  conventions on the way IN, so a caller may POST either form. The Experiment panel exposes Max steps,
  Learning rate, and a generic "Extra parameters (key=value)" editor (-> `extra`), so any script knob (e.g.
  `eval_steps`, `max_length`) is settable from the UI without task-specific fields. This is what makes a real
  fine-tune (more than the script's hardcoded default steps) controllable from the panel.
- **ML scaffold selection is a weighted heuristic, not first-match.** When an empty `python-ml`
  workspace is bootstrapped, `selectMlScaffold` (`scaffold-sources.ts`) chooses the scaffold (classical-ml
  | numerical | eval-harness | trm | distillation | quantized-inference | peft-finetune | inference-eval)
  from the user request. It used to be a precedence-ordered regex chain that returned on the FIRST match
  with `NUMERICAL_PATTERN` tested first, so a single incidental word could hijack an otherwise
  clearly-inference request -- a 32K-char "build a tiny chat LM" prompt that said "optimization" once
  (against 48 inference signals) scaffolded as `kind:numerical`/`entrypoint:sim.py`, a damped-oscillation
  stub that never trains the model. Now each intent is SCORED by `match-count * specificity-weight`
  (high-precision technique terms like `lora`/`int8`/`distill`/grid-puzzle weight 3, eval-harness 2, the
  broad inference/numerical nets 1); the highest score wins and ties break toward the more specific intent,
  so a dominant broad signal (dozens of text-generation mentions) still wins but one incidental token
  cannot. `NUMERICAL_PATTERN` also dropped the generic-ML tokens (`numerical`/`integration`/`optimization`)
  that collide with non-numerical prompts. A torch-requiring winner degrades to the classical scaffold
  (recording `degradedFrom`) when torch is unavailable. Guarded by `scripts/ml-corpus.json` selection cases
  -- a `selectionOnly` flag asserts the chosen kind without running the scaffold.
- **A placeholder entrypoint is adopted away from, or the run fails loudly — never silently run.** A run
  can end up pointed at the bundled numerical stub (`entrypoint:sim.py`) while the agent built the real
  trainer in a subdirectory (e.g. `bonsai-chat-rx/scripts/train.py`) that root-only manifest reconstruction
  never sees. Before each run, `resolveExperimentEntrypoint` (`experiment-manifest.ts`), called from
  `startExperimentRun` (`experiment-runtime.ts`), decides the entrypoint to actually run on an
  adopt-if-conforming-else-fail policy: a declared entrypoint that conforms to the run contract (a `.py`
  with both `__main__` and `--smoke`) and is not a bundled placeholder (`kind:numerical` or basename
  `sim.py`) is trusted as-is. Otherwise the workspace is scanned (root + up to 2 subdirectory levels,
  candidates ranked by `entrypointScore`, then shallower depth) and the strongest conforming candidate is
  ADOPTED: the orchestrator-owned manifest is rewritten to pin it (preserving predict/data declarations),
  the run is repointed, and an `experiment.phase` `entrypoint-adopted` event records the switch. A
  conforming placeholder overrides only to a strictly stronger candidate, so a genuine numerical project
  (no stronger entrypoint nearby) still runs as-is; and when the active entrypoint is not runnable and
  nothing conforming exists, the run fails with a precise repair instruction ("make `X` runnable as
  `python X --smoke`, or add a conforming trainer at the workspace root") instead of executing a broken stub.
- **The experiment manifest is clobber-resistant.** `experiment.json` at the workspace root is the
  orchestrator's run manifest (`readExperimentManifest`), but agents commonly write a file of the same name as
  their own run summary, which destroyed the manifest after the first run (`readExperimentManifest` -> null ->
  startExperimentRun threw "not an ML workspace", while the panel still showed because the GET enables on the
  `python-ml` stack). Now `readExperimentManifest` reads in priority order: the orchestrator-owned
  `.orchestrator/experiment/manifest.json`, then root `experiment.json` (only if it is a valid manifest), then
  **reconstructs** one by discovering the ML entrypoint (a top-level `.py` containing both `__main__` and
  `--smoke` -- the ML-contract signature, which avoids false-positives on non-ML python) and **persists** it to
  the owned path so it survives all future clobbering. `writeExperimentManifest` writes the owned copy. The
  methodology guidance also tells agents not to overwrite `experiment.json`. Additionally the Experiment panel
  now surfaces a failed run-submit's error (it previously discarded the POST response), and the experiment API
  logs `experiment.api.failed`.
- **Pre-run accelerator preflight.** Before a non-smoke run, `assertVenvAccelerator`
  (`experiment-runtime.ts`) reads the venv capability and applies `ML_GPU_UNAVAILABLE_POLICY`
  (`refuse` default | `cpu-downgrade`): an explicit `device=cuda/mps` with no usable accelerator is
  refused (fail-loud) or downgraded to CPU; `device=auto` falls back to CPU. A downgrade releases the
  single-GPU mutex and rewrites `run_config.json` so the process actually runs on CPU. `bf16` requires
  `bf16Supported`; int8/int4 quantization requires `bitsandbytes` importable.
- **Honest success semantics.** A non-smoke run counts as succeeded only if it exited 0 AND
  `metrics.json.ok !== false` AND a valid primary metric exists; otherwise it is reported failed
  (`scorecard.ts` + `experiment-runtime.ts`), closing the "exit 0 but no real training" gap. Smoke keeps
  its separate `smoke_report.passed` gate. Intended-vs-effective device is recorded on the run record,
  in the provenance artifact (host + venv hardware blocks), and as a warning chip in the Experiment
  panel; the panel also shows a live GPU status chip ("GPU: <device> ready" / "GPU disabled
  (ML_ALLOW_GPU=false)" / "CPU"). That chip is derived from the **per-project venv capability artifact**
  (`readVenvCapabilityArtifact`) combined with `mlAllowGpu` -- NOT the host doctor -- because the host
  probe runs under a sanitized (stripped-PATH) env where a system-CUDA host torch reports no CUDA, while the
  venv torch (self-contained CUDA libs) and the actual run do have it. The host doctor is only the fallback
  before the first install writes the capability artifact.
- **Checkpoints and forks never copy regenerable ML bulk.** A shared exclusion module
  (`runtime/workspace-ignore.ts`: `IGNORED_WORKSPACE_DIRS` + `hasIgnoredModelExtension`) is the single
  source of truth used by BOTH the checkpoint engine (`runtime/workspace-git.ts`) and the workspace fork
  copier (`work-session-fork.ts`), so the two lists can no longer drift. It excludes virtualenvs
  (`.venv`/`venv`), `mlruns`, `.ml-cache`, and large model blobs (`*.safetensors`/`*.pt`/`*.pth`/`*.gguf`/
  `*.onnx`/`*.joblib`/`*.pkl`). Previously the checkpoint force-added (`git add -f`) the entire multi-GB
  CUDA `.venv` (tens of thousands of files), which overwhelmed staging and failed the checkpoint, and the
  fork copier `cp`-recursed the same venv. Checkpoint mirrors the dirs in the bare repo `info/exclude` and
  defensively unstages leftover entries with nested-safe glob pathspecs; restore is `git reset --hard`,
  which leaves the untracked venv in place (regenerable from `requirements.txt`).
- **Torch-family detection is requirement-name precise.** `analyzeRequirements` keys off each
  comment-stripped requirement's leading package name, so `torch`/`torchvision`/`torchaudio` only trigger
  CUDA provisioning when they are top-level requirements -- a transitive `accelerate[torch]` extra or
  `pytorch-lightning` no longer forces a spurious multi-GB CUDA install. The CUDA skip in `ensureCudaTorch`
  also re-checks the installed CUDA build against the requested tag (so a stale `+cu121` venv is corrected
  when `cu124` is requested). ML-workspace installs in `verification.ts` run under the ML job timeout
  (`mlJobTimeoutMs`, not the 2-minute shell timeout) and the ML cache env (shared `PIP_CACHE_DIR`/HF
  cache), so a multi-GB CUDA (re)install does not time out and is not re-downloaded across paths.
- **Inference playground (post-training model testing).** After a short/full run saves a checkpoint, the
  Inference panel (`components/PreviewPane.tsx` -> `InferencePanel`) lets a user feed their own inputs to the
  trained model. The model declares an I/O **contract** (`lib/shared/inference-contract.ts`: per-input
  `modality` text/number/image/audio/video/file/tabular/json, and an `output.kind`); the panel renders the
  matching widgets and result views. A warm per-session **worker** (`lib/server/ml/inference-runtime.ts`)
  loads the model once and speaks newline-delimited JSON over stdin/stdout via a bundled stdlib harness
  (`ml/inference/predict-harness-source.ts`); the model author only writes `predict.py` (CONTRACT + optional
  `load()` + `predict(inputs, options, ctx)`). The classical scaffold ships a working sklearn `predict.py`;
  the methodology guidance instructs agents to write one for any model. Governance is **reused, not
  reinvented**: the worker runs under `createMlJobProcessEnv` (ML secrets stripped unless
  `ML_ALLOW_SECRETS`), `ACF_TRUST_REMOTE_CODE` is threaded identically to experiment jobs, it shares the
  single-GPU mutex (a starting experiment evicts an idle inference worker; a busy GPU downgrades inference to
  CPU), registers in the operation registry (`kind: "inference"`, so Abort tree-kills it), and library/user
  stdout is redirected to stderr so it cannot corrupt the protocol. Uploaded inputs and file outputs are
  confined to `<workspace>/.orchestrator/inference/` (path-traversal-refused by `resolveSandboxFile`), never
  the orchestrator root, and the dir is already in the checkpoint/fork ignore lists. Flags:
  `ML_INFERENCE_IDLE_MS` (warm-worker idle teardown, default 600000 — releases the GPU), `ML_INFERENCE_TIMEOUT_MS`
  (per-request, default 120000), `ML_INFERENCE_MAX_UPLOAD_MB` (per-file upload cap, default 64). The panel and
  routes stay dark unless `ML_PIPELINE_ENABLED=true` and a non-smoke checkpoint plus a predict entrypoint exist.

### Additional hardening (L1–L5)

- **L1 — token at rest.** `.data/github-auth.json` (encrypted OAuth token) and the local fallback
  `.data/github-token.key` are written `0o600` and re-`chmod`ed on reuse (`github-auth.ts`
  `writePrivateFile`), so other local accounts cannot read them. chmod is a best-effort no-op on
  Windows. The strongest protection remains setting `GITHUB_TOKEN_ENCRYPTION_KEY` outside `.data`.
- **L2 — OAuth scopes pinned server-side.** `startGithubDeviceAuth()` always requests the fixed
  `["repo","workflow"]` scope set; the `scopes` field in the device-start request body is ignored so a
  CSRF-reachable caller cannot widen or alter the grant.
- **L3 — artifact filenames.** `artifacts.ts` `safeName` now collapses any run of 2+ dots and falls
  back to `artifact`, so a stored filename can never be a `..` traversal segment.
- **L4 — Ollama tool path confinement.** Beyond the existing string-prefix check, `ollama-tools.ts`
  now resolves symlinks on the deepest existing ancestor of every read/list/write/delete target
  (`isRealpathInsideWorkspace`) and rejects anything whose real path leaves the workspace, closing
  symlink-escape writes. Verified against a real escaping junction.
- **L5 — workspace selection (reviewed, no code change).** The hard `workspace-safety` guard blocks
  only the control-plane root by design; `workspace-selection.ts` independently flags home dir, drive/
  filesystem roots, Windows/Unix system folders, app-parent, and multi-project dirs as risks and
  `selectWorkspaceFolder` refuses them unless `confirmedRisk === true`. With H1 blocking cross-origin
  callers, pointing the workspace at a sensitive folder still requires an explicit local confirmation,
  which is the intended behavior (users may legitimately target an existing project under their home).

## Security Hardening Pass

A consolidated local-security and open-source-publication hardening pass. The threat model is unchanged — local-only, loopback-bound, unauthenticated by design — so these items harden the boundary, shrink blast radius, and prepare the repo for public release. The companion Next-preview isolation fix is recorded under Recent Reliability Improvements. All items below are present in this tree except where noted.

**Network boundary and web surface**
- The `/api` loopback guard validates each `127.0.0.0/8` octet as 0–255 (`lib/shared/local-api-guard.ts`) instead of a digit-count regex, rejecting malformed Host values such as `127.300.999.1`; the exact-Origin match is unchanged.
- The control plane ships defense-in-depth response headers via `next.config.ts` `headers()`: a `Content-Security-Policy` that blocks remote script/connect/frame/object sources and cross-origin framing (deliberately permitting `'unsafe-inline'`/`'unsafe-eval'`/`ws:`/`blob:` so Next/Turbopack dev HMR keeps working), plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN`, and `Permissions-Policy`.
- The generated-app preview iframe is sandboxed (`components/PreviewPane.tsx`: `allow-scripts allow-same-origin allow-forms allow-downloads allow-popups`; see Current Behavior for why `allow-same-origin` is required for Next dev chunks).
- A non-loopback `PREVIEW_HOST` logs a one-time startup warning that previews and workspace files would be reachable on the LAN with no auth (`config.ts`).

**Untrusted-content / stored-XSS surface**
- `GET /api/artifacts/:id` sends `X-Content-Type-Options: nosniff`, serves only a small safe inline allowlist (png/jpeg/webp/gif/pdf, plain/markdown/json), and force-downloads everything else (e.g. `text/html`, `image/svg+xml`) as `application/octet-stream` + `Content-Disposition: attachment`, so a stored artifact cannot execute script in the control-plane origin.
- Workspace skill bodies are re-hashed at injection (`readSkillBody(sourcePath, expectedHash)` in `skills/skill-loader.ts`); on a hash mismatch the body is refused and the caller falls back to the stored preview, closing the trust-check/read TOCTOU.
- Verification/preview commands prefix any agent-authored filename beginning with `-` with `./` (`asFilePathArg` in `verification.ts`, plus the preview `javac` argv), so a crafted name cannot be parsed as a flag.
- Intent classification clamps its input to the first 50,000 chars before its regexes run (`lib/shared/request-intent.ts`) as ReDoS insurance.

**Secret handling**
- A shared redactor (`lib/server/secret-redaction.ts`) masks OpenAI `sk-`, Anthropic `sk-ant-`, GitHub `gh*_`/`github_pat_`, Google `ya29.`/`AIza`, any `Bearer <token>`, Slack `xox*`, AWS `AKIA`, PEM private keys, and labelled `secret=`/`token:` assignments, and is wired into `logging.ts`, `tracing.ts`, and the event/webhook pipeline (`events.ts`), so a credential printed by an agent or tool is masked before it is persisted or POSTed to `EVENT_WEBHOOK_URL`.
- The spawned-agent env allowlist (`runtime/env.ts`) denies `GOOGLE_APPLICATION_CREDENTIALS` even though the `GOOGLE_` namespace is otherwise forwarded, so a GCP service-account JSON path is not handed to task-driven agents.

**DoS / robustness**
- Office-document attachments decompress through a bounded stream with a 12 MB per-entry cap (`chat-attachments.ts`), defeating zip-bomb memory exhaustion.
- `/api/chat` and `/api/skills` reject oversized multipart bodies on the declared `Content-Length` before `request.formData()` buffers them.
- Embedded-DB writes `fsync` the temp file before the atomic rename (`db/file-db.ts` `writeFileSynced`), so a crash mid-write cannot leave a torn or zero-byte database.

**Telegram control**
- The worker token must be at least 24 characters server-side (`telegram-control/security.ts`), matching the helper-script floor, so a weak token configured outside those scripts fails closed.
- `/pair` is gated by the chat allowlist before redemption (`telegram-control/dispatcher.ts`), so a pairing code cannot be redeemed (nor a role label disclosed) from a non-allowlisted chat.

**Preview health checks**
- Internal health checks and the post-task render probe fetch with `redirect: "manual"` (`preview-manager.ts`, `workflow-controller.ts`); only `response.status` is consumed, so a local app's 3xx is read as its own status rather than chased off-box. (A generated app that legitimately redirects `/` then surfaces as status 0; the Next scaffold serves `/` directly, so this has not affected generated previews here.)

**Open-source publication prep**
- Added an MIT `LICENSE` and `package.json` `"license": "MIT"`.
- Added a safe-by-default `.env.example` (checkpoint autonomy, no auto-approve, Telegram disabled, loopback preview; danger knobs flagged `DANGER`); the README points at it.
- Standardized on a single pnpm lockfile: the npm `package-lock.json` — which embedded an internal package-registry hostname in every resolved URL — was removed and gitignored, leaving `pnpm-lock.yaml` (no such URLs) as the lockfile of record. `.gitignore` also excludes `*.tsbuildinfo`.
- Work-marker comments (TODO/FIXME/HACK/XXX) were eliminated from the TS/JS source; the comments that remain are technical documentation. Typecheck and lint stay green.

**Not applied in this tree** (proposed during the audit but absent here): symlink-realpath confinement in `scripts/claude-permission-server.mjs`, which still relies on string-prefix / `path.relative` containment only and deliberately fails open on policy errors (the workspace-safety guard and filesystem-diff change truth are the backstops). `scripts/static-preview-server.mjs` DOES have the confinement now: `isRealpathInsideRoot` realpath-resolves both the serving root and the requested target before streaming, on top of the loopback-Host check and dot-segment rejection.

## Windows-Specific Lessons

- `workspace-write` Codex sandbox failed shell spawning on this setup; use `danger-full-access` for trusted local workspaces.
- Do not spawn `npm.cmd` or `pnpm.cmd` directly; route `.cmd` and `.bat` through `cmd.exe /d /s /c`.
- Do not run Python verification commands through a shell when avoidable. On Windows, `cmd.exe /c python -m py_compile "main.py"` can pass literal quote characters to Python; structured argv execution avoids bogus `[Errno 22] Invalid argument: '"main.py"'` failures.
- Kill preview process trees with `taskkill /PID <pid> /T /F`.
- Preview port allocation must reject ports that already answer TCP connections, not only ports that fail a bind probe. On Windows, stale wildcard listeners can otherwise coexist with `127.0.0.1` binds and serve old apps.
- Watch for a bogus `C:\Windows\System32\pnpm` shadowing the real `pnpm.cmd`.
- Express `response.sendFile` and static middleware should use `{ dotfiles: "allow" }` for generated pages under hidden `.workspace` directories.
- R (`Rscript`) is not added to PATH by the Windows installer; it lives under `C:\Program Files\R\R-<version>\bin\Rscript.exe` (and `bin\x64`). `r-resolver.ts` globs `C:\Program Files\R\R-*\bin` newest-first as a known location. Run R through structured argv (no shell): `Rscript -e <expr>` is passed as a single verbatim arg so R string literals such as `parse(file="main.R")` keep their quotes (a shell/tokenizer would strip them). Generated `run_preview.R`/`DESCRIPTION` files are written with Node `writeFile(...,"utf8")` (no BOM); a UTF-8 BOM makes `Rscript` fail with `unexpected input`.
- `install.packages()` defaults to `type="both"` on Windows and will compile the newest *source* of any package whose latest version has no binary for the installed R, while pulling older *binary* dependencies — on an older R (e.g. 4.2, whose CRAN binary repo is frozen at older versions) this mixes incompatible versions and fails with `namespace ... is already loaded, but >= ... is required` / `lazy loading failed`. The R install (`rInstallExpression`) therefore pins `type="binary"` on Windows/macOS (`.Platform$pkgType`-gated so Linux stays source-only) so the whole dependency set resolves from one frozen binary repo.

## macOS/Linux Portability

- Codex CLI, Python, and package-manager commands are resolved through runtime resolvers instead of assuming a single command name is visible on PATH.
- Blank `CODEX_CLI_BIN`, `PYTHON_BIN`, `NPM_BIN`, `PNPM_BIN`, `YARN_BIN`, `BUN_BIN`, `RSCRIPT_BIN`, and `R_BIN` values mean auto-discover. R discovery checks PATH plus the globbed `C:\Program Files\R\R-*\bin` on Windows and Homebrew/`/usr/local/bin`/`/Library/Frameworks/R.framework/Resources/bin` on macOS/Linux.
- Codex discovery checks PATH plus common Homebrew, user-local, npm, asdf, mise, pnpm, and bun shim locations on macOS/Linux.
- Python execution prefers a workspace `.venv`/`venv` before falling back to `python3`/`python` on macOS/Linux.
- Abort and timeout cleanup kills Unix process groups with SIGTERM/SIGKILL, while Windows continues to use `taskkill /T /F`.
- Workspace risk checks include Unix/macOS system roots such as `/`, `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/etc`, `/var`, `/opt`, `/private`, and `/Volumes`.
- `/api/health` reports platform, Node version, PATH entry count, workspace-root writability, and resolved Codex/Python/package-manager command metadata.

## Verification Commands

```powershell
npm run typecheck
npm run lint
```

Build verification is intentionally not part of the default loop. The orchestrator filters `npm run build` out of configured/generated verification commands unless the user explicitly asks for build verification. There is a persistent non-blocking Turbopack NFT warning caused by dynamic filesystem/process imports in server modules when build is run manually.

## Preview Support

Preview support has been verified for:

- static HTML
- generic Node web apps with common server entrypoints
- Express/Fastify apps with either `scripts.dev`, `scripts.start`, or direct `src/server.js` style entrypoints
- Express-hosted vanilla HTML/CSS/JS apps with `/`, `/about`, `/contact`, `/styles.css`, and `/script.js`
- Next.js app with dependency install and `next dev -H <host> -p <port>`; the scaffold pins `outputFileTracingRoot`/`turbopack.root` to the generated app directory so the dev server cannot climb to the orchestrator repo root and compile the control-plane `proxy.ts`.
- Python scripts with generated visual output such as PNG/SVG/JPEG/PDF and text output files, served through a static preview report.
- Python scripts that call `matplotlib.pyplot.show()` without saving files; the preview wrapper captures open figures as PNGs.
- R scripts (`r-script`) with generated visual output. The `run_preview.R` wrapper opens a single multi-page graphics device with a `figure-%03d.<fmt>` filename pattern, so every auto-printed `ggplot`/lattice object and every base `plot()` page is captured as a separate file (the moral equivalent of the Python `plt.show()` capture); `source(..., print.eval = TRUE)` auto-prints top-level plot objects. Files the script writes itself (`ggsave()`, `png()`+`dev.off()`) are also collected. Run parameters (entrypoint, argv, stdin, env, and plot dpi/format/width/height) are user-editable from the same Preview-pane panel as Python.
- R Shiny apps (`r-shiny`) served live via `Rscript -e "shiny::runApp('.', host, port, launch.browser=FALSE)"`, a `plain_process` server health-checked and snapshotted on a free port like the Flask/Django previews. The app's `R_LIBS_USER` is pointed at the workspace `.rlib` so `shiny` and other declared packages load.

## Recent Reliability Improvements

- R package installs no longer fail on an older R from a binary/source version skew: a real `r-shiny` generation produced a correct, well-formed app (valid `app.R`/`DESCRIPTION`, syntax-parse gate green) but the preview's package install aborted with `namespace 'promises' 1.3.0 is already loaded, but >= 1.5.0 is required` → `lazy loading failed for package 'shiny'` → `R packages failed to install: shiny`. Root cause was the install call, not the generated code: `install.packages()` defaults to `type="both"` on Windows, so on R 4.2 (whose CRAN binary repo is frozen at older versions like `shiny 1.8.1.1`/`promises 1.3.0` while the source index always points at the latest) it installed the old *binary* dependencies and then tried to compile the newest *source* `shiny 1.13.0`, whose dependency floors the just-installed binaries no longer satisfied. The fix (`rInstallExpression` in `runtime/r-environment.ts`) prefers binaries on Windows/macOS — `pkg_type <- if (.Platform$pkgType == "source") "source" else "binary"`, so Linux keeps source-only CRAN — and sets `options(install.packages.check.source="no")`, so every package and dependency resolves from the same frozen binary repo for the installed R: no source compile, no Rtools requirement, no version-floor conflict (on R 4.2 it lands cleanly on `shiny 1.8.1.1` + compatible deps); the failure message also now notes a newer R may be required. Both install paths share the one function, so the pre-dispatch `syncRManifestDependencies` and the preview/verification install are fixed together. DESCRIPTION `Imports:` version constraints remain intentionally unenforced (binary preference already yields a self-consistent set), and the managed AGENTS.md R rules now tell agents to declare bare package names since pins are ignored and can name a version with no compatible build. Verified against the real R 4.2.0: the exact expression installs `shiny 1.8.1.1` + deps and `library(shiny)` loads, both exit 0; typecheck and lint stay green.
- `DEFAULT_PROJECT_STACK` no longer hijacks no-signal requests away from their true stack. Symptom: a request like "Write py script to visualize hyperbola. Then visualize the hyperbola" produced a Next.js app instead of the Python-script pipeline. Root cause was sequencing plus a lexical gap: `createPlan` scaffolded the workspace *before* planning, and on a no-signal request (`py` is not matched by any detector — only the full word `python`/`matplotlib`/`pyplot`/`seaborn` is) the resolver fell to `DEFAULT_PROJECT_STACK=next`; the planner then saw an existing Next.js scaffold and, per its "an existing workspace's detected stack wins" rule, rubber-stamped `targetStack: next`, so the existing `plan.stack.mismatch` re-scaffold safety net never fired (heuristic == planner). Fix makes the configured default carry almost no weight: (1) `stack-resolver.ts` tags each resolution with `source` so a pure-default outcome is detectable; (2) `bootstrapWorkspaceIfNeeded` **defers** the scaffold when `source === "default"` (returns `deferred: true`, leaves the workspace empty) so the planner sees `isEmpty=true` and is not biased; (3) the `planner.ts` `targetStack` rule now tells the planner to infer the stack from the request alone on an empty workspace and not default to a web framework (scripts/plots/visualization/math → `python-script`); (4) after planning, `createPlan` scaffolds for the planner's `targetStack` via `rescaffoldWorkspaceForStack` (which already handles the empty-manifest + empty-dir case), covering both the deferred-empty path and the pre-existing signal-based mismatch path. Net effect: the default is used only when a request has zero signal **and** the planner also declines to name a stack; an unbiased provider-backed planner — not a zero-signal heuristic — owns the stack choice. Typecheck and lint stay green.
- Generated Next.js previews no longer compile the control-plane's parent `proxy.ts`: generated apps live under `.workspace/` inside the orchestrator repo, and because the tree carries lockfiles above them, Next/Turbopack could infer an ancestor as the workspace root and pull in the control-plane root `proxy.ts`, which imports `@/lib/shared/local-api-guard`. That `@/` alias resolves against the *generated app's* own root (where the module does not exist), so `next dev` failed to compile and every route returned HTTP 500 — and the repair loop then churned trying to "fix" a generated-app dependency that was never the app's, degrading the otherwise-correct generated app. Two fixes: (1) the Next scaffold (`workspace-bootstrap.ts`) now pins the app to its own root via `outputFileTracingRoot` and `turbopack.root` set to the generated app directory (plus `allowedDevOrigins: ["127.0.0.1","localhost"]`), so Next stops climbing into the orchestrator; the existing `.workspace/demo-project/next.config.js` was aligned to match. (2) `classifyPreviewRepairability` (`workflow-controller.ts`) detects this exact leak via `isNextParentProxyLeak` (a Next preview whose failure evidence names `@/lib/shared/local-api-guard` and a `proxy.ts` that is NOT the generated workspace's own) and classifies it as a non-repairable `environment_failure` — an orchestrator preview-isolation problem, not a generated-app dependency error — so the controller stops burning repair budget on a phantom failure. Validated against the pre-security-refactor snapshot, whose self-contained `proxy.ts` (no `@/` import) did not exhibit the leak.
- "Restore to here" reloads the preview, with a visible rollback signal: restoring a checkpoint rolls the git work tree back but the running preview server kept serving the pre-restore app (a `plain_process` server serves boot-time code until restarted; an HMR server keeps the stale iframe mounted), and the client only called `refresh()`. A shared `reloadPreviewAfterRollback` helper now re-points the preview at the rolled-back tree via the preview `start` action (`refresh_existing_or_start` — reuses a watcher/HMR server and bumps the iframe `refreshRevision` to remount/re-fetch; hard-restarts a `plain_process` server), wired into all three rollback paths (`restore-checkpoint`, `surgical-revert-checkpoint`, `undo-last`). It only fires when a preview was actually serving (captured before the rollback), so a rollback never starts one from nothing, and a reload failure is surfaced softly. A `restoring` flag drives a full-body `.pane-restoring` overlay (spinner + "Restoring workspace…") over the preview pane as the visible signal, which also covers the stale iframe so it can't be mistaken for the restored state mid-reload. Presentation/lifecycle only; restore semantics and the non-destructive chat projection are untouched.
- Provider quota exhaustion pauses instead of blocking: when the coding provider returns a usage-limit / rate-limit / quota / overloaded error (e.g. Codex "You've hit your usage limit … try again at 3:13 AM"), the executor produces zero file changes, which the repair classifier correctly declines to fix — but the controller used to transition the session to a terminal `blocked` ("failed and was not converted into a code repair task"), forcing a manual rescue for a transient condition that clears itself. A shared cross-provider detector (`isProviderExhaustionMessage` / `providerExhaustionRetryHint` in `runtime/execution-result.ts`) and a new `failureKind: "provider_exhausted"` (reclassified once, centrally, in `executeTask` so every adapter is covered uniformly) now route this family to a **resumable pause**: the task is restored to `todo` with its retry budget refunded (a quota wall is not a genuine attempt), the session parks on the existing awaiting-step surface ("Coding provider quota reached — try again at 3:13 AM, then resume to retry this task"), and a non-critical `session.provider_quota_paused` event replaces the critical `session.blocked` so the UI/Telegram present a pause rather than a crash. No work is lost; resuming re-runs the same task.
- Checkpoints tolerate live-server file churn: `createGitCheckpoint` (`workspace-git.ts`) enumerates the work tree and then stages via `git add --pathspec-from-file` — a TOCTOU race once the always-on probe preview keeps the generated app's dev server running across checkpoints (live apps legitimately write/rename ephemeral files, e.g. atomic tmp-then-rename JSON stores, so an enumerated path can vanish before git consumes the list and git fails hard, blocking the session as an environment failure). Staging now retries with a fresh enumeration (3 attempts, 150 ms apart) only when the failure is a vanished pathspec; everything else still surfaces as a real checkpoint error.
- The preview pane shows task-boundary states, never the live working tree: HMR/watcher stacks (Next.js, Vite) stream the executor's half-written edits into the published iframe in real time, so while an agent is actively running a task the pane veils the iframe ("Task running: … — the preview updates at the next checkpoint", with a "Watch live anyway" opt-out), revealing at each validated boundary when the post-task probe's refreshRevision bump remounts a fresh frame. While the session is still working, a failed published preview renders as calm "broken page detected — being repaired" copy instead of a dead-end failure placeholder (terminal sessions keep the real failure UI). Presentation-layer only; the probe and all measurement are untouched. Plain-process stacks (Express, Django runserver) were already boundary-frozen by accident — this makes the semantic explicit and universal.
- The preview boot chain no longer authors workspace state: the Django prepare step (`preparePythonWebPreviewIfNeeded` in `preview-manager.ts`) runs plain `migrate --noinput` — `--run-syncdb` removed (it created tables for migration-less apps outside `django_migrations`, so when real migrations arrived mid-plan every boot failed with "table already exists") and the preceding bare `makemigrations --noinput` removed (probe-authored migrations can collide with the executor's own). Nothing is lost at the gate, which already enforces `makemigrations --check`. Probe boot exceptions swallowed by the render probe's inconclusive-safe guard now leave a diagnostic trace (`workflow.render_probe.boot_exception` + a low-key task.progress event) so deterministic prepare failures surface at the task that first hits them.
- Preview measurement and presentation are separated: probe-mode previews (`PreviewServerRecord.mode`) are internal instruments and only surface to the preview pane, timeline milestones, and Telegram once the session's app has first proven servable (`WorkSessionRecord.previewFirstServableAt` — HTTP < 400 on a probe fetch or a successful render-gate snapshot; monotonic). Before that, half-built boot failures and bare 404 shells are presented as neutral "app not yet servable — still building" states instead of danger markers, because mid-plan brokenness is expected task sequencing (the same regression-only ontology the probe itself uses). Explicit user preview starts and final-gate previews always publish; a final-mode refresh permanently upgrades a probe record. Servability (< 400) is deliberately stricter than the probe's regression threshold (< 500) so a legitimate 404 can't trip repairs while a 404 shell can't masquerade as a presentable app.
- Preview restarts no longer mutate dependencies under a live dev server: `startPreviewForWorkSessionInternal` (`preview-manager.ts`) used to skip stopping existing previews in probe mode, so when a probe refresh was rejected the boot chain's pip/npm install rewrote `.venv`/`node_modules` while the old server's file watcher was still alive — Django's StatReloader re-exec'd into a half-installed tree and crashed (transient "failed preview" flashes in the UI, leaked ports, misleading crash records). Previews are now stopped in all modes once reuse is rejected (a successful probe refresh still keeps the old server), and the preview exit handler distinguishes "exited while running" from "exited before becoming ready" since that message feeds boot-chain audit and render-probe repair evidence.
- The post-task render regression probe actually runs now: it was gated on `functionalVerificationEnabled`/`snapshotCaptureEnabled`, which default to false and only govern optional mid-plan extras, while the final render gate it front-runs always runs (`forceEnabled: true`) — so the probe was dead code in default deployments. The guard is removed (`detectPostTaskRenderRegression` in `workflow-controller.ts`); the probe now fires after every completed coding task. Rule of thumb recorded: a mechanism that front-runs a gate must derive its enablement from that gate's actual behavior, and must be confirmed firing in the next live run.
- The blind-executor window is closed for Python stacks: the pre-dispatch manifest sync (`syncWorkspaceManifestDependencies` in `dependency-installer.ts`) now runs per-ecosystem — alongside the existing node_modules sync, `syncPythonManifestDependencies` creates the `.venv` and pip-installs `requirements.txt` (the exact verification-gate install, keyed by a hash of meaningful requirement lines at `.venv/.closed-loop-manifest-hash`) before every executor dispatch. Previously the `.venv` first appeared at the verification gate, so Python executors that tried to self-run `manage.py check`/`makemigrations` per the AGENTS.md rules hit `ModuleNotFoundError: No module named 'django'` and could only syntax-check, end-loading import-time errors into verification repairs; it also lets mid-plan Python probe previews boot, which the post-task render regression probe depends on. Advisory like the Node sync — the gate install stays authoritative.
- Render breakage is caught at the task that introduced it: after every completed coding task, `detectPostTaskRenderRegression` (`workflow-controller.ts`) probes the home page on the refreshed probe preview and, when a previously healthy page now 5xxs (or the app stopped booting), flips the task result to failed with the server traceback attached and routes it through the existing execution-repair loop. Regression-only by design — an app that has never been healthy mid-plan is skipped (task sequencing legitimately passes through broken states; the final render gate owns that case), and the baseline is consumed per regression so one broken window produces one repair.
- The runtime gate now protects the embedded preview and the data contract: `runtime-embeddable` fails when the root response sends frame-blocking headers (X-Frame-Options or restrictive CSP frame-ancestors blank the cross-origin preview iframe while the direct URL works), and `runtime-seeded-data` fails when the request explicitly demands seeded/sample data but the app's SQLite user tables are empty after the preview booted (both in `functional-verification.ts`; both skip silently when inconclusive — missed checks are recoverable, gate false positives are not). Matching AGENTS.md rules prevent both at the source, including the Django trap where a custom `runserver` command is silently overridden by `django.contrib.staticfiles`.
- Preview URLs of completed sessions are durable: when the idle reaper stops a preview, the freed port is parked with a wake responder (`parkIdleStoppedPreviewPort` in `preview-manager.ts`) that serves an auto-polling "waking up" page and revives the preview on first request, so handoff links and open tabs self-heal instead of refusing connections; the parked listener doubles as a port reservation. The managed AGENTS.md contract also gained a first-run completeness rule: the boot command must run migrations AND load any required seed data automatically and idempotently — manual-only seed commands ship an empty product because verification and previews only ever run the boot command.
- Probe-time 5xx failures are no longer repaired blind: verification repair tasks attach the linked preview's runtime log tails (stderr first — server tracebacks live there; `previewRuntimeLogEvidence` in `workflow-controller.ts`) whenever a runtime failure links a preview that stayed healthy, with an acceptance criterion to diagnose from the traceback or a local reproduction instead of guessing from the route name. Previously preview evidence was attached only when the preview itself failed to boot, so a healthy server's exception logs never reached the repair agent and a one-line server bug could exhaust the whole repair budget.
- Python web structural checks no longer require a JavaScript asset: server-rendered HTML+CSS is a complete frontend, backend-only collapse is still caught by the HTML/CSS checks, and client-side behavior is verified by the runtime interaction probes (previously the gate forced repair agents to ship dead stub `static/app.js` files into SSR apps). Relatedly, `source_failure` reporting is phase-truthful: the run summary distinguishes failed commands from failed structural checks, and verification repair tasks lead with a `Failed checks:` digest parsed from the `FAILED [phase]` lines, saying "Failed commands" only when a command actually failed (`verification.ts`, `workflow-controller.ts`).
- The nav-link structural check measures reachability, not adjacency: a deep route passes when the root page links the route directly or links a detected ancestor section page (`detectedAncestorRoutes` in `functional-verification.ts`; dynamic-segment ancestors match via the existing route-pattern logic). Top-level routes still require a direct root link. Previously the gate demanded a root link to every leaf, which forced repair agents to add post-action redirect pages (e.g. an import-summary page) to the global nav.
- Controller scheduling is self-healing: the `scheduledControllerRuns` dedup entry is cleared when the scheduled advance starts (holding it for the whole run made the guard swallow the run's own continuation — the actual cause of the inter-task starvation stalls), advance requests arriving mid-run are deferred via `pendingControllerReruns` and rescheduled from the finally, a 45 s watchdog sweep recovers any active unpaused session with no running/scheduled advance and no progress for 60 s (covers crashes and dev-server restarts), and background advance crashes persist a high-priority event instead of dying console-only.
- Executors no longer work without dependencies: before every executor dispatch (repairs included) the controller syncs node_modules with the workspace manifest (`syncWorkspaceManifestDependencies` — plain package-manager install, idempotent via a dependency-hash marker in `node_modules/.closed-loop-manifest-hash`, advisory on failure since the verification-gate install stays authoritative). A managed AGENTS.md rule then has executors run the project's fast static self-check (typecheck) before declaring a coding task complete, so type errors are fixed in-task instead of surfacing as verification repair cycles.
- The runtime functional gate names the failing layer truthfully: when only interaction probes fail, the summary no longer claims structural "rendered-output issues"; structural and probe failure counts are reported separately.
- Preview failures persist their reason on the record: `PreviewServerRecord.lastFailureReason` is set at every failure site (failed health path on start/refresh, spawn error, premature exit) and cleared on ready, and `VerificationRunRecord.previewId` links a failed render gate to its preview. Verification repair tasks for render-gate failures lead with a `Health failure:` line naming the exact failing request and include the shared boot-chain audit block, so a single-defect preview failure converges in one repair instead of serial blind attempts. Snapshot/probe failures with a healthy preview deliberately skip the boot-chain framing.
- The controller no longer starves when a plan needs more than `CONTROLLER_MAX_STEPS_PER_TICK` (default 8) steps: when the per-tick budget runs out with the session still active and unpaused, `advanceController` schedules its own follow-up from the lock-release path (`steps` includes `continuation-scheduled`). Early breaks (paused, blocked, awaiting step, terminal) still wait for an external trigger.
- Event persistence is bounded and batched: stream output deltas are coalesced before hitting the DB, the eventLog has low-priority-first retention caps, the DB is written compact, and each process sweeps dead controller locks and abandoned tmp partials on first DB read (see State And Storage).
- Prompt source hygiene now distinguishes operator/task instructions from untrusted source data. Attachments and prior research excerpts are wrapped with explicit boundaries and injection warnings before they enter provider prompts.
- Runtime tool exposure is policy-driven for Ollama. The catalog records tool mutability/risk/mode, `/api/runtime-tools` exposes the current mode's tools, and `executeWorkspaceTool` rejects tools that are not registered or not allowed for the active mode.
- Runtime status now includes a doctor-style `diagnostics[]` list. The Runtime drawer renders these checks so provider/model/context/quota/tooling/compaction problems are visible without reading terminal logs.
- Report artifacts are now library-addressable. Research, dependency-research, verification, handoff, and tagged report artifacts can be listed globally or per work session, and the right workbench panel has a Reports view for session-local inspection.
- Project playbooks provide approved reusable workflow knowledge. They are stored as durable records, editable through playbook APIs, and injected into executor prompts only when approved and relevant to the active session/task.
- Skills provide provider-neutral reusable workflow instructions. App skills live in `.skills/*.md`, workspace Codex skills are discovered from `.agents/skills/*/SKILL.md`, and the Skills drawer supports create-from-text, file import, enable/implicit/trust controls, diagnostics, and app-skill deletion.
- Memory is split into app-wide User Memory and work-session Project Memory. The Memory drawer can create, edit, pin, dismiss/reactivate, and delete both layers where applicable; executor prompts render User Memory before Project Memory across Codex CLI, Claude Code, AGY, and Ollama, including persistent Codex/Claude resume paths.
- Agent runs have a durable replay endpoint. `GET /api/work-sessions/{id}/runs/{agentRunId}/events` reconstructs run-specific events, tool runs, and artifacts after a browser reload or SSE disconnect.
- Static Codex runtime rules were moved out of per-task stdin prompts and into orchestrator-managed `AGENTS.md` sections. This keeps prompts shorter while preserving project-authored `AGENTS.md` content.
- `/api/health` now includes cached Codex doctor output: executable resolution, `codex --version`, auth/sandbox status, smoke execution, and a concise error field.
- Codex execution now fails early on broken CLI/preflight state instead of entering a task run that can only fail later.
- Real workspace diff capture now wraps every Codex run. Code changes are based on file snapshots instead of stdout parsing or hooks.
- Final summary cards now launch a changed-files/diff panel. The panel uses checkpoint git diff APIs for real per-file diffs and falls back to recorded change rows when older local state has no usable checkpoint repository.
- Repair tasks bypass the dependency installer. The installer also ignores script/command names such as `typecheck`, `lint`, `build`, `start`, and `test`, so verification repair cannot accidentally install `typecheck` as a package.
- Verification failure repair is bounded. The controller queues repair work for source, functional, and visual/render failures, reruns verification, tracks attempt counts and failure fingerprints, and escalates repeated failures with a higher-quality handoff.
- Verification transition decisions for `verifying -> executing`, `verifying -> blocked`, and `verifying -> completed` are isolated in a pure evaluator.
- Acceptance criteria now carry evidence (`unknown`, `satisfied`, or `failed`) from code changes, verification runs, agent summaries, or manual notes. Completion requires every original criterion to have evidence or be explicitly non-machine-verifiable.
- Event records now have priority (`low`, `normal`, `high`, `critical`). Verification failures, blockers, and handoffs can surface above routine progress.
- `emitEvent()` derives default priority and can deliver events to an optional webhook sink. Low-priority webhook events are batched; critical events are sent immediately.
- Render verification is now a hard completion gate for previewable apps. Source verification may pass first, but final completion waits for preview health, snapshot/screenshot capture, and runtime DOM/AX checks. A final preview failure updates the verification run to failed, emits a high-priority `verification.failed`, and queues a repair task with preview command, health failure, stdout/stderr tails, and snapshot artifact IDs when available.
- Snapshot evidence is captured from the generated app URL directly, not from the control-plane iframe. Screenshots are binary `screenshot` artifacts; DOM and bundle reports are bounded JSON `report` artifacts served through the artifact API.
- Preview failure telemetry is richer. `preview.failed` events now include failed health path, preview command, stdout tail, and stderr tail; the Preview pane shows failed-preview stdout in addition to stderr.
- Preview health checks are bounded per request and abortable through the shared operation registry. A single hanging `fetch` during final render validation can no longer wedge the controller past the overall health-check deadline.
- Preview readiness uses a two-phase deadline: while the server has not answered anything yet (connection refused), the process gets a 45s boot budget — compile-first dev scripts like `npm run build && npm run start` legitimately spend their first 10–30s not listening — and the strict 12s health window starts at the first HTTP response of any status. A process that exits still fails immediately.
- Preview health paths: filesystem-derived asset URLs (`public/styles.css` → `/styles.css`) apply only to `static-html`, where disk layout is the URL space. For server stacks the router owns the URL space, so `waitForHealth` discovers assets from the app itself: once `/` responds OK it extracts same-origin stylesheet/script references from the rendered HTML and probes those (cross-origin/data: skipped, relative URLs resolved). The gate demands exactly what the app declares it serves.
- Managed `AGENTS.md` rules forbid agent-side process leaks on the user's desktop: no detached/new-window spawns (PowerShell `Start-Process`, cmd `start`), no servers or listeners left running after the turn (in-task HTTP verification runs the exported app in-process on an ephemeral port, or foreground with a bounded timeout), and no streaming server output into workspace files as a monitoring channel (Windows 11 Notepad live-reloads such files, which looks like ghost typing).
- Client-side console logging includes more event context for accountability: event priority, context fields, payload keys, status, message, and reason are logged when SSE events arrive.
- A Codex hook ingestion endpoint accepts `PostToolUse` and `Stop`-style payloads and stores them as live progress events/tool runs. Hooks are treated as progress enrichment, not authoritative change capture.
- Compact orchestrator context is fed back into executor prompts: plan/task state, repair attempt, latest verification failure, recent changed files, and capped prior-run summaries across Codex CLI, Claude Code, AGY CLI, and Ollama. With `CROSS_PROVIDER_TRANSCRIPT=true`, provider switches create a distilled cross-provider handoff from transcript side files; raw reasoning is stored only as side-file input and never re-injected.
- Workspace analysis, stack resolution, and bootstrap now ignore orchestrator-owned `AGENTS.md`, preventing instruction files from making an otherwise empty workspace look non-empty.
- Node web preview detection no longer depends exclusively on `scripts.dev`; generated packages that expose only `start` can still preview.
- Express apps generated inside `.workspace` can serve explicit HTML routes without Express rejecting the path as a dotfile.
- Structural verification now checks that Express/static web apps include requested pages, shared asset paths, navigation links, active-link styling, and active-link JavaScript behavior.
- Structural verification no longer applies vanilla static HTML checks to bundler entries such as Vite or Next root `index.html`, nor to workspaces with any Node server surface (TS/root server entrypoints or a declared express/fastify/koa/hapi/hono/nest dependency), nor when the session's recorded stack decision is non-static — a scaffold-leftover root `index.html` next to a real server app is not the product surface.
- The stack is a recorded, visible, user-editable decision, not scattered regex inference. `WorkSessionRecord.stackDecision` carries `{stack, source: user|planner|heuristic|workspace, confidence, rationale}`; precedence is user > planner > heuristic. The scaffold-time heuristic records the initial decision (except that a no-signal request that would only hit `DEFAULT_PROJECT_STACK` now defers scaffolding so the provider-backed planner — not the default — picks the stack; see the deferral note above); the planner declares `targetStack` (+ `stackRationale`) in plan JSON (missing/invalid values degrade to the heuristic, never fail planning; a planner/heuristic disagreement OR a deferred (empty) workspace emits `plan.stack.mismatch` AND (re-)scaffolds the still-pristine workspace for the planner stack, so no foreign-stack scaffold files survive into execution); the plan card shows an inline grouped Stack dropdown (from `lib/shared/stack-catalog.ts`, the single source for the selectable stack list) that is editable until execution starts via the plan route's `set-stack` action; a user change re-scaffolds only a PRISTINE workspace (every non-ignored file is in the recorded `scaffoldManifest`) and emits `plan.stack.changed`. Structural verification selects check families from the recorded decision, with raw-text classification only as the legacy fallback for sessions without one.
- The stack/static suggestion heuristic is a weighted scoring engine (`lib/shared/stack-intent.ts` `resolveStackSuggestion`), not ordered keyword vetoes: product/component attribution (a static phrase scores by the noun it modifies — "plain HTML page" is product-level, "plain HTML forms" inside a server spec is component-level), one uniform anchoring rule for ambiguous tokens (express/go/rust/node/ruby count only with a tech-context neighbor, a build verb, or canonical form — never per-phrase carve-outs), negation stripping ("NOT React", "no backend" never name what they negate), and a tie-break preferring the non-static reading (fullstack-misread-as-static makes gates unsatisfiable; the reverse merely skips extra checks). Output is `{stack, confidence, signals, alternatives}` — a suggestion the planner and user override, not a verdict. The labeled evaluation corpus is data-driven (a dev-only fixture, not shipped in this tree); add cases to the corpus rather than special-casing classifier or validator code.
- Workspace analysis now recognizes public HTML pages and includes `public/` assets in important-file discovery.
- Runtime prompts now instruct Codex to preserve existing scaffold conventions and shared asset paths instead of inventing incompatible `/css` or `/js` directories.
- Dependency research runs immediately after plan approval so Codex starts from current package guidance rather than stale scaffold versions. For Node workspaces this updates declared npm dependencies such as `express`, `vite`, `react`, or `next` to current npm versions while honoring discovered peer constraints; for Python workspaces this pins simple `requirements.txt` entries such as `flask` or `django` to the current PyPI version. For generated Next workspaces this also modernizes linting to a source-scoped ESLint command instead of removed `next lint` or broad scaffold linting.
- Dependency tasks are handled by the orchestrator before Codex execution. The installer only extracts exact package specs from structured task text/imports/commands, avoids free-form prose token guessing, and resolves peer-compatible versions against the generated workspace's existing framework dependencies.
- Workspace execution safety is enforced at controller, project creation, workspace selection, bootstrap, dependency research/install, preview, verification, and provider dispatch boundaries. Unsafe implementation roots are blocked before any coding provider or mutating helper can act on them.
- Default managed demo workspaces are created under `WORKSPACE_ROOT`; the app-root verification flag no longer changes `Project.localRepoPath` or `WorkSession.activeWorktreePath`.
- Environment/control-plane failures and execution failures with no captured file changes block with explicit details instead of spawning generated-app repair tasks.
- Queued repair tasks are prioritized over unrelated downstream plan tasks, and execution-repair attempts are counted against the original failed task rather than nesting repair-of-repair chains indefinitely.
- Codex app-server interrupted turns are no longer blanket-classified as user aborts. The runtime records explicit abort reasons in app-server log artifact metadata; only those explicit abort/steering paths become `aborted` or `interrupted_by_user_steering`. Provider-side `interrupted` turns without an app abort reason become repairable runtime failures when they captured file changes.
- Legacy Codex app-server runs that were already persisted as aborted user runs can be recovered by the controller when the log artifact shows `transport=app-server`, `outcome=interrupted`, no `abortReason`, and captured code changes. The controller queues a normal execution repair task for those cases rather than leaving the session blocked without repair.
- Embedded DB writes use randomized temp files and retry missing-temp rename cases so concurrent/local filesystem oddities do not corrupt durable state.
- Planner prompts now tell dependency tasks to name exact package specs and avoid ranges that require upgrading existing framework/runtime dependencies unless the user explicitly requested those upgrades.
- Runtime prompts now prohibit undeclared imports/CSS imports and warn against browser-only module imports in prerendered Next.js routes unless isolated behind `next/dynamic` with `ssr: false`.
- Runtime prompts now ask generated CSS to avoid Autoprefixer-prone flexbox logical alignment values such as bare `start`/`end` when `flex-start`/`flex-end` is intended.
- Verification now falls back to Python-specific commands for Python workspaces when global verification commands are npm-only, discovers arbitrary Python script entrypoints, executes Python commands with structured argv on Windows, skips missing package scripts as verification-contract failures, and package import preflight catches undeclared source/CSS imports before handoff.
- The package-import preflight resolves local specifiers the way TypeScript does under NodeNext/ESM: a relative import written with a runtime extension (`./x.js`, `./x.jsx`, `./x.mjs`, `./x.cjs`) is accepted when the matching TypeScript source (`./x.ts`/`.tsx`/`.mts`/`.cts`) exists on disk. Without this mapping the check is unsatisfiable for any correct `"type": "module"` + NodeNext TypeScript app, because that configuration requires `.js` extensions in source imports. Genuinely missing modules still fail, and typecheck independently validates the real resolution in the same gate.
- Python preview no longer assumes `main.py`. It scores Python entrypoint candidates, prefers established entrypoints when present, captures matplotlib `plt.show()` output into preview PNGs, and keeps orchestrator metadata such as `AGENTS.md` out of visual output reports.
- Preview records are reconciled against live PIDs before starting new previews, and the iframe is keyed/versioned by preview ID to avoid stale embedded documents after restarts.
- Chat forks now distinguish current-head, checkpoint, and handoff fork points. Checkpoint and handoff forks use `materializeGitCheckpoint` instead of copying the latest workspace, and handoff forks pass `handoffId` from the Final summary card so the fork resumes from that handoff's historical state rather than from later work in the original chat.
- After a fork is created, the UI refreshes app state before selecting the forked work session, preventing a stale active-session pointer from leaving the composer inactive until a page reload.
- Flow control gives the user direct command over the execution loop instead of a single plan-approval gate followed by full autonomy. Per-session autonomy levels (`manual`/`checkpoint`/`supervised`/`full_auto`) gate task execution and verification inside `advanceController`; `WorkSessionRecord` carries `autonomyLevel`, `paused`, `awaitingStep`, and `nextActionLabel`, defaulted backward-compatibly during database normalization.
- A single `POST /api/work-sessions/{id}/control` endpoint handles `pause`, `resume`, `step`, `abort`, and `set-autonomy`. Step routes through `advanceController(id, { trigger: "step" })`; the auto-tick path uses the default `auto` trigger. Pause also signals active controller-owned operations so validation/preview startup stops promptly after the paused flag is persisted.
- Running provider processes and controller-owned operations can be aborted from the UI. Runtime adapters register provider runs in the process registry and pass an `AbortSignal` into `process-runner`, which tree-kills the process; controller ticks and preview startup register in the operation registry so Abort can stop validation/render-gate work even when no provider process is active.
- Controller file locks are recovered by checking the recorded PID as well as mtime. If a server process dies while holding a controller lock, the next controller acquisition removes the dead-PID lock instead of waiting for an arbitrary stale-lock age.
- Abort is durable before it is best-effort: if the session is in a running state such as `verifying`, the control route writes `currentState="canceled"` and closes any running verification record before signaling live provider processes or controller-owned operations. This covers restarted servers and Next dev hot reloads where the in-memory process/operation registry may be empty even though the database still says validation is running.
- The UI auto-tick now halts on any pending approval (previously only plan approvals), and additionally halts while paused, awaiting a step, or in manual mode.
- Python calculation/visualization runs are user-controlled. Generated Python scripts can be re-run with a chosen entrypoint, command-line arguments, piped stdin, environment variables, and matplotlib dpi/format/style from the Preview pane, turning a one-shot auto-detected run into a tweak-inputs/re-run loop. Run parameters are normalized server-side (`lib/shared/python-run.ts`), persisted on the work session, and threaded into the headless preview runner.
- Generation is steerable. A per-session steering note (set in the Run controls "Runtime" drawer) is injected into the planner and every executor prompt. Per-session runtime overrides are normalized server-side (`lib/shared/runtime-overrides.ts`) and persisted on the work session: Codex uses model, reasoning effort, service tier, sandbox, network, and timeout; Claude Code uses model, effort, service tier, and timeout; AGY uses model and timeout; Ollama uses model, temperature, context length, and timeout. The control API actions `set-runtime` and `set-steering` handle updates. The steering note also reaches a per-task nudge via `task.metadata.steeringNote` (foundation for per-task re-run with guidance).
- Ollama can now run both implementation and research sessions. Implementation uses the write-capable orchestrator loop and filesystem diff validation; read-only research uses a separate Ollama loop that only exposes inspection tools and writes the same report artifacts/chat summaries as spawned-agent research.
- Claude Code and AGY CLI can now run planning, implementation, and read-only research as spawned local agent providers. Both use auto-discovered binaries when their `*_BIN` env var is blank, register with the process registry for Abort, write long prompts into `.orchestrator`, and reuse the shared diff/verification/checkpoint pipeline. The Runtime drawer intentionally does not expose a context-window control for Claude or AGY; only Ollama has an adjustable context length. Claude Code does expose an Opus-only Fast service tier, applied through `/fast` when persistent sessions are enabled; AGY has no orchestrator-owned speed-tier control.


# UI and Layout Study

A quick orientation to the UI code. Read this, then go straight to the real files.

## Orientation notes

- **There is no `public/*.html`.** This is a React/Next app; the entire UI lives in `app/` + `components/`.
- **`app/page.tsx` is a 5-line stub** that just renders `<ChatApp />`. Same for `app/layout.tsx` (20 lines: metadata + the theme-bootstrap `<script>`).
- **Ignore `.workspace/` and `node_modules/`** when searching for UI code — `.workspace/` holds *generated* apps from past runs (their own `app/`, `components/`, `.html`), which pollute search results. Scope searches to top-level `app/` and `components/` only.
- **The big files are big.** `components/ChatApp.tsx` (~3,900 lines) and `app/globals.css` (~4,600 lines) are best read by section — grep the CSS section banners or the component/handler names — rather than whole.

## Where the UI actually lives

| File | Lines | Role |
|---|---|---|
| `app/page.tsx` | 5 | renders `<ChatApp />` |
| `app/layout.tsx` | 20 | metadata + inline `data-theme` bootstrap script (anti-FOUC) |
| `app/globals.css` | ~4600 | **all** styling — design tokens + every component's CSS (no CSS modules) |
| `components/ChatApp.tsx` | ~3900 | root component + sub-components `RunControls`, `ChatHistorySidebar`, `BrandMark` defined in the same file; holds `PublicAppState`, the SSE wiring, and the right-panel mode |
| `components/TimelineStream.tsx` | ~1300 | center conversation/timeline feed (bubbles + plan/verification/handoff cards, task actions) |
| `components/DetailDrawer.tsx` | ~2100 | right slide-over; polymorphic on `DrawerView.kind` (plan/verification/handoff/events/artifacts/runtime, ...) |
| `components/PreviewPane.tsx` | ~2200 | right pane mode: iframe preview, Python/R run-params panel, Experiment/Calibration/Inference panels |
| `components/ml/*` | ~1400 | ML workbench: `MlPreviewPane` (Training/Inference tabs), `MlTrainingDashboard`, `MlMetricChart` + pure `metric-chart-scale.ts` |
| `components/ChangedFilesPane.tsx` | ~340 | right pane mode: Final summary changed-file list + lazy per-file diff viewer |
| `components/ReportsPane.tsx` | ~75 | right pane mode: session report-artifact library |
| `components/SelectMenu.tsx` | ~160 | shared styled select control |
| `components/PhaseRail.tsx` | ~57 | horizontal phase stepper (SVG markers) |
| `components/ThemeToggle.tsx` | ~98 | 3-way light/auto/dark segmented toggle |

Styling is **plain global CSS with BEM-ish class names** (no Tailwind, no CSS-in-JS, no modules). globals.css is organized in clearly commented section banners (`/* === Chat history sidebar === */` etc.) — grep those banners to jump around.

## Layout skeleton (the mental model)

```
<main.app>                       full viewport, overflow hidden, no page scroll
├─ header.app-header             brand (animated BrandMark SVG + h1 + subtitle) | status-chip + ThemeToggle
└─ div.app-body                  CSS grid: [sidebar auto | workbench 1fr]
   ├─ ChatHistorySidebar         300px, collapses to 56px; history-* classes
   └─ section.workbench          flex column, gap 16
      ├─ .workbench-topbar       PhaseRail (left) + RunControls (right)
      ├─ .workspace-bar          active workspace path + Open / Use-generated
      ├─ .banner-error           conditional
      └─ .app-grid               two cols: chat-column | PreviewPane
         ├─ section.chat-column  grid rows: [TimelineStream 1fr | .composer auto]
         └─ PreviewPane          omitted when researchMode (.app-grid-research)
+ DetailDrawer                   right slide-over (drawer + drawer-shroud), conditional
+ modal-backdrop/.workspace-risk-dialog   conditional confirm dialog
```

Three zones: **left = history nav, center = chat/timeline, right = preview or changed-files inspection.** Everything is height-locked to the viewport; scrolling happens inside panels.

Right pane mode is owned by `ChatApp`: default is `PreviewPane` (`MlPreviewPane` for `python-ml` sessions); clicking "Changed files" on a Final summary/handoff card switches it to `ChangedFilesPane`, and the composer slash controls can switch it to `ReportsPane`. The changed-files pane is not a drawer and does not parse the handoff Markdown; it calls the handoff-scoped change APIs and returns to Preview via its header button.

## Class-name namespaces (for grepping CSS↔JSX)

- `app-*` shell, `history-*` sidebar, `workbench`/`workspace-*` middle frame
- `run-controls*` + `run-autonomy*` top-right controls
- `composer*` input area, `chip*`/`status-chip*` status pills
- `card*` + `task-*` + `stream*` + `activity*` + `milestone*` → TimelineStream
- `drawer*` + `field*` + `list-editor*` + `runtime*` + `plan-editor*` + `task-editor*` → DetailDrawer
- `pane*` + `python-run-*` → PreviewPane
- `phase*`/`marker-*` → PhaseRail, `brand-mark*` → BrandMark, `theme-toggle` → ThemeToggle

## Design system essentials

- **Theming:** light/dark token sets keyed on `[data-theme]` (top of globals.css). `layout.tsx` injects a script that sets `data-theme` before paint; ThemeToggle persists to `localStorage['cdl.theme']` (light | dark | system).
- **Palette:** light surfaces `#f5f7fb`/`#fff`, ink `#172033`, **blue accent `#2563eb`**; dark base `#0b0f17`, accent `#3b82f6`. Semantic trios success(green)/warning(amber)/danger(red), each `-fg`/`-soft`/`-border`.
- **Type:** system-ui sans for UI; monospace (JetBrains Mono) for code + slash commands.
- **Tokens:** layered `--shadow-panel/card/drawer`, `--focus-ring`/`--attn-ring`, 8–14px radii.
- **Buttons:** one base `<button>` style + variants `.primary`/`.ghost`/`.danger`/`.danger-text`/`.small` (combine freely, e.g. `"ghost small"`).
- **Motion:** BrandMark orbit + cursor-blink animations, all wrapped in `@media (prefers-reduced-motion: reduce)`.

## Domain framing that drives the UI

The whole layout is organized around the agent loop: **plan → approve → execute → verify → preview → handoff**, mirrored by PhaseRail (status) + RunControls (autonomy: manual/checkpoint/supervised/full_auto) + the timeline cards. State flows top-down from `ChatApp` via props; live updates arrive over SSE (`/api/events/stream`) and trigger an app-state refresh. `researchMode` (deliveryKind === "research") hides the PreviewPane and widens the chat column.

Timeline activity cards treat `WorkSessionState` as lifecycle state, not the full user-facing activity. `lib/shared/timeline.ts` first projects semantic events into activity labels/details through `ActivityKind` (`researching_repo`, `reading_files`, `editing_files`, `running_command`, `verifying`, `preview`, etc.) and only falls back to coarse labels like "Starting work" when no meaningful event exists. Runtime adapters should emit `tool.started`/`tool.completed`/`tool.failed` or `task.progress` with `activityKind`, `activityLabel`, and `activityDetail` when they know the operation; text/stdout classification is fallback only.

## Fast path to learn it

1. `components/ChatApp.tsx` — the render tree (search for the main `return (`; the map above comes from there).
2. `app/globals.css` section banners, top-to-bottom.
3. Then drill into TimelineStream / DetailDrawer / PreviewPane as needed.

Final summary changed-file inspection path: start in `TimelineStream`'s handoff card, follow `onOpenHandoffChanges` into `ChatApp`'s `rightPanel` state, then inspect `ChangedFilesPane` and the `/api/work-sessions/{id}/changes*` routes.
