import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatToolDef } from "@/lib/server/runtime/chat-model-client";
import { ollamaToolDefinitionsForMode } from "@/lib/server/runtime/tool-catalog";
import { decideToolPolicy } from "@/lib/server/runtime/tool-policy";
import type { ToolPolicyMode } from "@/lib/shared/types";


const MAX_READ_CHARS = 60_000;
const MAX_WRITE_BYTES = 2_000_000;
const MAX_LIST_ENTRIES = 400;

const ignoredListNames = new Set([
  ".git",
  ".agy",
  ".antigravity",
  ".antigravitycli",
  ".gemini",
  ".next",
  ".orchestrator",
  "node_modules",
  "__pycache__",
  "dist",
  "build",
  ".turbo",
]);

export interface ToolExecution {
  name: string;
  ok: boolean;
  result: string;
  mutatedPath: string | null;
}

export interface FinishSignal {
  summary: string;
}

function resolveInsideWorkspace(workspaceRoot: string, requested: unknown): string | null {
  if (typeof requested !== "string" || requested.trim().length === 0) {
    return null;
  }
  const cleaned = requested.trim().replace(/^[/\\]+/, "");
  const resolved = path.resolve(workspaceRoot, cleaned);
  const rootResolved = path.resolve(workspaceRoot);
  const a = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const b = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  if (a !== b && !a.startsWith(b + path.sep)) {
    return null;
  }
  return resolved;
}

function relativeLabel(workspaceRoot: string, absolute: string): string {
  return path.relative(workspaceRoot, absolute).split(path.sep).join("/") || ".";
}

async function isRealpathInsideWorkspace(workspaceRoot: string, target: string): Promise<boolean> {
  let rootReal: string;
  try {
    rootReal = await realpath(workspaceRoot);
  } catch {
    rootReal = path.resolve(workspaceRoot);
  }
  const b = process.platform === "win32" ? rootReal.toLowerCase() : rootReal;
  let probe = path.resolve(target);
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = await realpath(probe);
      const a = process.platform === "win32" ? real.toLowerCase() : real;
      return a === b || a.startsWith(b + path.sep);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return false;
      }
      probe = parent;
    }
  }
  return false;
}

function stripSelfLabelLines(content: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const labelLine = new RegExp(`^${escaped}:[ \\t]*\\r?\\n`);
  let next = content;
  while (labelLine.test(next)) {
    next = next.replace(labelLine, "");
  }
  return next;
}

export function ollamaToolDefinitions(): ChatToolDef[] {
  return ollamaToolDefinitionsForMode("execute");
}

export async function readWorkspaceFileRaw(workspaceRoot: string, requested: string): Promise<string | null> {
  const target = resolveInsideWorkspace(workspaceRoot, requested);
  if (target === null || !(await isRealpathInsideWorkspace(workspaceRoot, target))) {
    return null;
  }
  try {
    const fileStat = await stat(target);
    if (!fileStat.isFile()) {
      return null;
    }
    const content = await readFile(target, "utf8");
    return content.length > MAX_READ_CHARS ? `${content.slice(0, MAX_READ_CHARS)}\n... [truncated ${content.length - MAX_READ_CHARS} chars]` : content;
  } catch {
    return null;
  }
}

export async function executeWorkspaceTool(input: {
  workspaceRoot: string;
  name: string;
  args: Record<string, unknown>;
  mode?: ToolPolicyMode;
}): Promise<ToolExecution> {
  const { workspaceRoot, name, args } = input;
  const mode = input.mode ?? "execute";
  const decision = decideToolPolicy({ mode, toolName: name });
  if (!decision.allowed) {
    return { name, ok: false, result: `Error: ${decision.reason}`, mutatedPath: null };
  }

  if (name === "finish") {
    return { name, ok: true, result: "Acknowledged finish.", mutatedPath: null };
  }

  if (name === "list_dir") {
    const target = resolveInsideWorkspace(workspaceRoot, typeof args.path === "string" && args.path.trim().length > 0 ? args.path : ".");
    if (target === null || !(await isRealpathInsideWorkspace(workspaceRoot, target))) {
      return { name, ok: false, result: "Error: path is outside the workspace and was rejected.", mutatedPath: null };
    }
    try {
      const entries = await readdir(target, { withFileTypes: true });
      const lines = entries
        .filter((entry) => !(entry.isDirectory() && ignoredListNames.has(entry.name)))
        .slice(0, MAX_LIST_ENTRIES)
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
      const label = relativeLabel(workspaceRoot, target);
      return { name, ok: true, result: lines.length > 0 ? `${label}:\n${lines.join("\n")}` : `${label}: (empty)`, mutatedPath: null };
    } catch (error) {
      return { name, ok: false, result: `Error listing directory: ${error instanceof Error ? error.message : String(error)}`, mutatedPath: null };
    }
  }

  if (name === "read_file") {
    const target = resolveInsideWorkspace(workspaceRoot, args.path);
    if (target === null || !(await isRealpathInsideWorkspace(workspaceRoot, target))) {
      return { name, ok: false, result: "Error: path is missing or outside the workspace.", mutatedPath: null };
    }
    try {
      const fileStat = await stat(target);
      if (!fileStat.isFile()) {
        return { name, ok: false, result: "Error: path is not a file.", mutatedPath: null };
      }
      const content = await readFile(target, "utf8");
      const bounded = content.length > MAX_READ_CHARS ? `${content.slice(0, MAX_READ_CHARS)}\n... [truncated ${content.length - MAX_READ_CHARS} chars]` : content;
      return { name, ok: true, result: `${relativeLabel(workspaceRoot, target)}:\n${bounded}`, mutatedPath: null };
    } catch (error) {
      return { name, ok: false, result: `Error reading file: ${error instanceof Error ? error.message : String(error)}`, mutatedPath: null };
    }
  }

  if (name === "write_file") {
    const target = resolveInsideWorkspace(workspaceRoot, args.path);
    if (target === null || !(await isRealpathInsideWorkspace(workspaceRoot, target))) {
      return { name, ok: false, result: "Error: path is missing or outside the workspace.", mutatedPath: null };
    }
    const label = relativeLabel(workspaceRoot, target);
    const content = stripSelfLabelLines(typeof args.content === "string" ? args.content : "", label);
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
      return { name, ok: false, result: "Error: file content exceeds the maximum allowed size.", mutatedPath: null };
    }
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return { name, ok: true, result: `Wrote ${label} (${Buffer.byteLength(content, "utf8")} bytes).`, mutatedPath: label };
    } catch (error) {
      return { name, ok: false, result: `Error writing file: ${error instanceof Error ? error.message : String(error)}`, mutatedPath: null };
    }
  }

  if (name === "delete_file") {
    const target = resolveInsideWorkspace(workspaceRoot, args.path);
    if (target === null || !(await isRealpathInsideWorkspace(workspaceRoot, target))) {
      return { name, ok: false, result: "Error: path is missing or outside the workspace.", mutatedPath: null };
    }
    try {
      await rm(target, { force: true });
      const label = relativeLabel(workspaceRoot, target);
      return { name, ok: true, result: `Deleted ${label}.`, mutatedPath: label };
    } catch (error) {
      return { name, ok: false, result: `Error deleting file: ${error instanceof Error ? error.message : String(error)}`, mutatedPath: null };
    }
  }

  return { name, ok: false, result: `Error: unknown tool '${name}'.`, mutatedPath: null };
}


export interface EnvelopeAction {
  kind: "write" | "read" | "delete" | "list" | "finish";
  path?: string;
  content?: string;
  summary?: string;
}

const writeBlockPattern = /<<<WRITE\s+([^\n>]+?)\s*>>>+[ \t]*\r?\n?([\s\S]*?)(?:<<<END>>>+|(?=<<<(?:WRITE|READ|DELETE|LIST|FINISH))|$)/g;
const simpleDirectivePattern = /<<<(READ|DELETE|LIST)\s+([^\n>]+?)\s*>>>+/g;
const finishPattern = /<<<FINISH>>>+\r?\n?([\s\S]*?)(?:<<<END>>>+|$)/;

export function parseEnvelopeActions(content: string): EnvelopeAction[] {
  const actions: EnvelopeAction[] = [];
  let match: RegExpExecArray | null;

  writeBlockPattern.lastIndex = 0;
  while ((match = writeBlockPattern.exec(content)) !== null) {
    actions.push({ kind: "write", path: match[1].trim(), content: match[2] });
  }

  simpleDirectivePattern.lastIndex = 0;
  while ((match = simpleDirectivePattern.exec(content)) !== null) {
    const kind = match[1].toLowerCase() as "read" | "delete" | "list";
    actions.push({ kind, path: match[2].trim() });
  }

  const finishMatch = finishPattern.exec(content);
  if (finishMatch !== null) {
    actions.push({ kind: "finish", summary: finishMatch[1].trim() });
  }

  return actions;
}

export function extractLargestCodeBlock(content: string): string | null {
  const fence = /```[a-zA-Z0-9.+-]*[ \t]*\r?\n([\s\S]*?)```/g;
  let best: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(content)) !== null) {
    if (best === null || match[1].length > best.length) {
      best = match[1];
    }
  }
  if (best === null) {
    return null;
  }
  const trimmed = best.replace(/\s+$/, "");
  return trimmed.trim().length > 0 ? trimmed : null;
}

export function envelopeActionToTool(action: EnvelopeAction): { name: string; args: Record<string, unknown> } {
  switch (action.kind) {
    case "write":
      return { name: "write_file", args: { path: action.path ?? "", content: action.content ?? "" } };
    case "read":
      return { name: "read_file", args: { path: action.path ?? "" } };
    case "delete":
      return { name: "delete_file", args: { path: action.path ?? "" } };
    case "list":
      return { name: "list_dir", args: { path: action.path ?? "." } };
    case "finish":
      return { name: "finish", args: { summary: action.summary ?? "" } };
  }
}
