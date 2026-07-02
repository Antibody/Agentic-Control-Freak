import { NextResponse } from "next/server";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { readAppState } from "@/lib/server/db/file-db";
import { resolveCodexCliBin } from "@/lib/server/runtime/codex-cli-resolver";
import { runCodexDoctor } from "@/lib/server/runtime/codex-doctor";
import { runOllamaDoctor } from "@/lib/server/runtime/ollama-doctor";
import { resolveClaudeCodeBin } from "@/lib/server/runtime/claude-code-resolver";
import { runClaudeCodeDoctor } from "@/lib/server/runtime/claude-code-doctor";
import { resolveAgyCliBin } from "@/lib/server/runtime/agy-cli-resolver";
import { runAgyDoctor } from "@/lib/server/runtime/agy-doctor";
import { runMlDoctor } from "@/lib/server/runtime/ml-doctor";
import { resolvePackageManagerCommand, type PackageManagerName } from "@/lib/server/runtime/package-manager-resolver";
import { resolvePythonCommand } from "@/lib/server/runtime/python-resolver";
import { getPolyglotToolchainDiagnostics } from "@/lib/server/toolchains/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function workspaceRootWritable(workspaceRoot: string): Promise<boolean> {
  const probe = path.join(workspaceRoot, `.health-write-probe-${process.pid}-${Date.now()}`);
  try {
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(probe, "ok", "utf8");
    await unlink(probe);
    return true;
  } catch {
    await unlink(probe).catch(() => undefined);
    return false;
  }
}

async function safePackageResolution(packageManager: PackageManagerName): Promise<unknown> {
  try {
    return await resolvePackageManagerCommand(packageManager);
  } catch (error) {
    return { command: packageManager, error: error instanceof Error ? error.message : "Unable to resolve package manager." };
  }
}

export async function GET(): Promise<NextResponse> {
  const config = getConfig();
  const [state, codex, claude, antigravity, ollama, ml, python, packageManagers, polyglotToolchains, workspaceWritable] = await Promise.all([
    readAppState(),
    config.agentProvider === "codex-cli" || config.plannerProvider === "codex-cli"
      ? runCodexDoctor()
      : resolveCodexCliBin().then((executable) => ({
          available: false,
          executable,
          version: null,
          authenticated: false,
          sandboxAccepted: false,
          smokeExecPassed: false,
          error: "Codex CLI is not the configured agent or planner provider.",
          checkedAt: new Date().toISOString(),
        })),
    config.agentProvider === "claude-code"
      ? runClaudeCodeDoctor()
      : resolveClaudeCodeBin().then((executable) => ({
          available: false,
          executable,
          version: null,
          authenticated: null,
          smokeExecPassed: false,
          error: "Claude Code is not the configured agent provider.",
          checkedAt: new Date().toISOString(),
        })),
    config.agentProvider === "antigravity-cli"
      ? runAgyDoctor()
      : resolveAgyCliBin().then((executable) => ({
          available: false,
          executable,
          version: null,
          authenticated: null,
          smokeExecPassed: false,
          error: "AGY CLI is not the configured agent provider.",
          checkedAt: new Date().toISOString(),
        })),
    runOllamaDoctor().catch((error: unknown) => ({
      available: false,
      baseUrl: config.ollamaBaseUrl,
      version: null,
      modelCount: 0,
      defaultModelPresent: false,
      error: error instanceof Error ? error.message : "Unable to reach Ollama.",
      checkedAt: new Date().toISOString(),
    })),
    runMlDoctor().catch((error: unknown) => ({
      enabled: config.mlPipelineEnabled,
      available: false,
      error: error instanceof Error ? error.message : "Unable to run ML doctor.",
      checkedAt: new Date().toISOString(),
    })),
    resolvePythonCommand(),
    Promise.all(["npm", "pnpm", "yarn", "bun"].map((packageManager) => safePackageResolution(packageManager as PackageManagerName))),
    getPolyglotToolchainDiagnostics(),
    workspaceRootWritable(config.workspaceRoot),
  ]);
  return NextResponse.json({
    ok: config.agentProvider === "codex-cli"
      ? codex.available && codex.smokeExecPassed
      : config.agentProvider === "claude-code"
        ? claude.available && claude.smokeExecPassed
        : config.agentProvider === "antigravity-cli"
          ? antigravity.available && antigravity.smokeExecPassed
          : true,
    data: {
      appEnv: config.appEnv,
      agentProvider: config.agentProvider,
      dbFile: config.dbFile,
      workspaceRoot: config.workspaceRoot,
      workspaceRootWritable: workspaceWritable,
      artifactsDir: config.artifactsDir,
      platform: {
        os: process.platform,
        arch: process.arch,
        release: os.release(),
        node: process.version,
        pathEntryCount: (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry.trim().length > 0).length,
      },
      projects: state.projects.length,
      workSessions: state.workSessions.length,
      events: state.eventLog.length,
      codex,
      claude,
      antigravity,
      ollama,
      ml,
      python,
      packageManagers,
      polyglotToolchains,
    },
  });
}
