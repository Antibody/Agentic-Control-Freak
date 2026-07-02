#!/usr/bin/env node

import path from "node:path";

const WORKTREE = (process.env.CLAUDE_PERM_WORKTREE ?? "").trim();
const AUTONOMY = (process.env.CLAUDE_PERM_AUTONOMY ?? "").trim();
const MUTATING_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function log(message) {
  process.stderr.write(`[claude-permission-server] ${message}\n`);
}

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function isInsideWorktree(target) {
  if (WORKTREE.length === 0) return false; // cannot enforce without context → fail closed for mutations
  const resolvedRoot = path.resolve(WORKTREE);
  const resolvedTarget = path.resolve(WORKTREE, target);
  let rel = path.relative(resolvedRoot, resolvedTarget);
  if (process.platform === "win32") {
    rel = rel.toLowerCase();
  }
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function decide(toolName, input) {
  if (!MUTATING_TOOLS.has(toolName)) {
    return { behavior: "allow", updatedInput: input };
  }
  const candidates = [input?.file_path, input?.notebook_path, input?.path].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  for (const candidate of candidates) {
    if (!isInsideWorktree(candidate)) {
      log(`DENY ${toolName} → ${candidate} (outside worktree ${WORKTREE})`);
      return {
        behavior: "deny",
        message: `Blocked by orchestrator policy: ${toolName} targets a path outside the active workspace (${candidate}). Keep all edits inside the work-session workspace.`,
      };
    }
  }
  return { behavior: "allow", updatedInput: input };
}

function handleToolCall(message) {
  const args = message.params?.arguments ?? {};
  const toolName = typeof args.tool_name === "string" ? args.tool_name : "";
  const input = args.input ?? {};
  let decision;
  try {
    decision = decide(toolName, input);
  } catch (error) {
    log(`policy error (failing closed / deny): ${error instanceof Error ? error.message : String(error)}`);
    decision = {
      behavior: "deny",
      message: "Blocked by orchestrator policy: the permission gate could not evaluate this tool call. Retry, or keep edits inside the work-session workspace.",
    };
  }
  send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(decision) }] } });
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "orchestrator", version: "1.0.0" },
        },
      });
    } else if (message.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "approve",
              description: "Orchestrator permission gate: approve or deny a tool call.",
              inputSchema: {
                type: "object",
                properties: { tool_name: { type: "string" }, input: { type: "object" } },
              },
            },
          ],
        },
      });
    } else if (message.method === "tools/call") {
      handleToolCall(message);
    } else if (message.method === "notifications/initialized") {
    } else if (message.id !== undefined) {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
});

log(`started (worktree=${WORKTREE || "<none>"}, autonomy=${AUTONOMY || "<none>"})`);
