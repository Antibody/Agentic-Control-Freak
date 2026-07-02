import { Buffer } from "node:buffer";
import { resolveGitBin } from "@/lib/server/runtime/git-resolver";
import { runProcess, type ProcessEnvironment } from "@/lib/server/runtime/process-runner";
import { redactSecrets } from "@/lib/server/secret-redaction";

export interface CloneResult {
  ok: boolean;
  message: string;
}

const DEFAULT_CLONE_TIMEOUT_MS = 600000;

function cloneTimeoutMs(): number {
  const raw = Number.parseInt(process.env.GIT_CLONE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CLONE_TIMEOUT_MS;
}

export function isLikelyHttpsGitUrl(rawUrl: string): boolean {
  const url = rawUrl.trim();
  if (url.startsWith("-")) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export function isGithubHost(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl.trim()).hostname.toLowerCase();
    return host === "github.com" || host.endsWith(".github.com");
  } catch {
    return false;
  }
}

export function cleanRepoUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return rawUrl.trim();
  }
}

export function repoNameFromUrl(rawUrl: string): string {
  try {
    const segments = new URL(rawUrl.trim()).pathname.split("/").filter((segment) => segment.length > 0);
    const last = segments.pop() ?? "repo";
    const name = last.replace(/\.git$/i, "");
    return name.length > 0 ? name : "repo";
  } catch {
    return "repo";
  }
}

export async function cloneRepository(input: {
  url: string;
  targetPath: string;
  branch?: string | null;
  token?: string | null;
  signal?: AbortSignal;
}): Promise<CloneResult> {
  if (!isLikelyHttpsGitUrl(input.url)) {
    return { ok: false, message: "Only https:// git URLs are supported." };
  }
  const gitBin = await resolveGitBin();
  const args = ["-c", "core.longpaths=true", "clone", "--no-tags"];
  const branch = input.branch?.trim();
  if (branch !== undefined && branch.length > 0) {
    args.push("--branch", branch, "--single-branch");
  }
  args.push("--", input.url, input.targetPath);

  const env: ProcessEnvironment = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  };

  if (input.token !== undefined && input.token !== null && input.token.length > 0 && isGithubHost(input.url)) {
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${input.token}`).toString("base64")}`;
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 = header;
    env.GIT_CONFIG_KEY_1 = "credential.helper";
    env.GIT_CONFIG_VALUE_1 = "";
  }

  const result = await runProcess({
    command: gitBin,
    args,
    cwd: process.cwd(),
    timeoutMs: cloneTimeoutMs(),
    env,
    signal: input.signal,
  });

  if (result.aborted) {
    return { ok: false, message: "Clone was canceled." };
  }
  if (result.timedOut) {
    return { ok: false, message: "Clone timed out." };
  }
  if (result.exitCode !== 0) {
    const detail = redactSecrets((result.stderr || result.stdout || "").trim()).slice(-600);
    return { ok: false, message: detail.length > 0 ? `git clone failed: ${detail}` : "git clone failed." };
  }
  return { ok: true, message: "ok" };
}
