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
- If this workspace already contains a scaffold, keep its routing style and established asset paths.
- Do not import, require, dynamically import, or CSS-import any package that is not declared in package.json.
- Do not use classes or directives from a CSS framework unless that framework is already declared and configured in the workspace.
- For Next.js apps, browser-only modules that access window, document, navigator, canvas, maps, media APIs, or other DOM globals at module scope must not be imported directly by a prerendered route.
- For static or vanilla Node apps, use existing shared asset paths consistently across every HTML page instead of inventing new css/js directories.
`;

function managedBlock(): string {
  return `${beginMarker}\n${managedRules.trim()}\n${endMarker}`;
}

export async function ensureWorkspaceClaudeMd(workspacePath: string): Promise<void> {
  await assertSafeWorkspace(workspacePath, { operation: "Claude workspace instructions write" });
  const claudePath = path.join(workspacePath, "CLAUDE.md");
  await mkdir(workspacePath, { recursive: true });
  let existing = "";
  try {
    existing = await readFile(claudePath, "utf8");
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
  await writeFile(claudePath, `${next.trimEnd()}\n`, "utf8");
}
