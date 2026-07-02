import { getConfig } from "@/lib/server/config";
import { runProcess } from "@/lib/server/runtime/process-runner";

let cachedGitBin: string | null = null;

export async function resolveGitBin(): Promise<string> {
  if (cachedGitBin !== null) {
    return cachedGitBin;
  }
  const configured = getConfig().gitBin.trim();
  const candidate = configured.length > 0 ? configured : "git";
  const result = await runProcess({
    command: candidate,
    args: ["--version"],
    cwd: process.cwd(),
    timeoutMs: 10000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`Git is required for checkpoints but was not available: ${result.stderr || result.stdout || candidate}`);
  }
  cachedGitBin = candidate;
  return candidate;
}
