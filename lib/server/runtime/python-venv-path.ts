import path from "node:path";
import { createHash } from "node:crypto";
import { getConfig } from "@/lib/server/config";


const LONGEST_VENV_SUFFIX = 170;
const SAFE_PATH_LIMIT = 250;

export function workspaceVenvDir(workspacePath: string): string {
  const inWorkspace = path.join(workspacePath, ".venv");
  if (process.platform !== "win32") {
    return inWorkspace;
  }
  if (inWorkspace.length + LONGEST_VENV_SUFFIX <= SAFE_PATH_LIMIT) {
    return inWorkspace;
  }
  const hash = createHash("sha256").update(path.resolve(workspacePath)).digest("hex").slice(0, 12);
  return path.join(getConfig().venvRoot, hash, ".venv");
}
