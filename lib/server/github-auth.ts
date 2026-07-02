import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getConfig } from "@/lib/server/config";

const githubApiBase = "https://api.github.com";
const githubAuthBase = "https://github.com";

const githubOAuthScopes = ["repo", "workflow"];

async function writePrivateFile(filePath: string, data: string | Buffer): Promise<void> {
  await writeFile(filePath, data, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);
}

interface StoredGithubAuth {
  version: 1;
  account: GithubAccountStatus & {
    tokenCiphertext: string;
    tokenIv: string;
    tokenTag: string;
  };
}

export interface GithubAccountStatus {
  login: string;
  id: number;
  avatarUrl: string | null;
  htmlUrl: string;
  scopes: string[];
  source: "oauth" | "env";
  updatedAt: string;
}

export interface GithubAuthStatus {
  configured: boolean;
  clientId: string | null;
  account: GithubAccountStatus | null;
  requiredConfig: string | null;
}

export interface GithubToken {
  token: string;
  account: GithubAccountStatus;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface PollTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

function authFilePath(): string {
  return path.join(path.dirname(getConfig().dbFile), "github-auth.json");
}

function keyFilePath(): string {
  return path.join(path.dirname(getConfig().dbFile), "github-token.key");
}

function configuredClientId(): string | null {
  const value = process.env.GITHUB_CLIENT_ID?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

function normalizeScopes(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value.split(/[\s,]+/).map((scope) => scope.trim()).filter((scope) => scope.length > 0).sort();
}

async function encryptionKey(): Promise<Buffer> {
  const envKey = process.env.GITHUB_TOKEN_ENCRYPTION_KEY?.trim();
  if (envKey !== undefined && envKey.length > 0) {
    const raw = Buffer.from(envKey, /^[a-f0-9]{64}$/i.test(envKey) ? "hex" : "base64");
    if (raw.length === 32) {
      return raw;
    }
    throw new Error("GITHUB_TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as hex or base64.");
  }
  const keyPath = keyFilePath();
  const existing = await readFile(keyPath).catch(() => null);
  if (existing !== null && existing.length === 32) {
    await chmod(keyPath, 0o600).catch(() => undefined);
    return existing;
  }
  const key = randomBytes(32);
  await mkdir(path.dirname(keyPath), { recursive: true });
  await writePrivateFile(keyPath, key);
  return key;
}

async function encryptToken(token: string): Promise<{ tokenCiphertext: string; tokenIv: string; tokenTag: string }> {
  const key = await encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return {
    tokenCiphertext: ciphertext.toString("base64"),
    tokenIv: iv.toString("base64"),
    tokenTag: cipher.getAuthTag().toString("base64"),
  };
}

async function decryptToken(account: StoredGithubAuth["account"]): Promise<string> {
  const key = await encryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(account.tokenIv, "base64"));
  decipher.setAuthTag(Buffer.from(account.tokenTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(account.tokenCiphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function readStoredAuth(): Promise<StoredGithubAuth | null> {
  const authPath = authFilePath();
  const exists = await stat(authPath).then(() => true, () => false);
  if (!exists) {
    return null;
  }
  const parsed = await readFile(authPath, "utf8").then((content) => JSON.parse(content) as unknown, () => null);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { account?: { login?: unknown } }).account?.login !== "string"
  ) {
    return null;
  }
  return parsed as StoredGithubAuth;
}

async function writeStoredAuth(auth: StoredGithubAuth): Promise<void> {
  const authPath = authFilePath();
  await mkdir(path.dirname(authPath), { recursive: true });
  await writePrivateFile(authPath, JSON.stringify(auth, null, 2));
}

async function githubFetch<T>(url: string, init: RequestInit): Promise<{ body: T; scopes: string[] }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as T;
  const scopes = normalizeScopes(response.headers.get("x-oauth-scopes") ?? undefined);
  if (!response.ok) {
    const message = typeof (body as { message?: unknown }).message === "string" ? (body as { message: string }).message : response.statusText;
    throw new Error(`GitHub request failed: ${message}`);
  }
  return { body, scopes };
}

async function fetchUser(token: string): Promise<{ account: Omit<GithubAccountStatus, "source" | "updatedAt" | "scopes">; scopes: string[] }> {
  const { body, scopes } = await githubFetch<{
    login: string;
    id: number;
    avatar_url?: string | null;
    html_url: string;
  }>(`${githubApiBase}/user`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    account: {
      login: body.login,
      id: body.id,
      avatarUrl: body.avatar_url ?? null,
      htmlUrl: body.html_url,
    },
    scopes,
  };
}

export async function githubAuthStatus(): Promise<GithubAuthStatus> {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken !== undefined && envToken.length > 0) {
    const { account, scopes } = await fetchUser(envToken);
    return {
      configured: true,
      clientId: configuredClientId(),
      account: { ...account, scopes, source: "env", updatedAt: new Date().toISOString() },
      requiredConfig: null,
    };
  }
  const stored = await readStoredAuth();
  return {
    configured: configuredClientId() !== null,
    clientId: configuredClientId(),
    account: stored === null
      ? null
      : {
          login: stored.account.login,
          id: stored.account.id,
          avatarUrl: stored.account.avatarUrl,
          htmlUrl: stored.account.htmlUrl,
          scopes: stored.account.scopes,
          source: stored.account.source,
          updatedAt: stored.account.updatedAt,
        },
    requiredConfig: configuredClientId() === null ? "Set GITHUB_CLIENT_ID to enable GitHub device login." : null,
  };
}

export async function startGithubDeviceAuth(): Promise<DeviceCodeResponse> {
  const clientId = configuredClientId();
  if (clientId === null) {
    throw new Error("Set GITHUB_CLIENT_ID to enable GitHub login.");
  }
  const response = await fetch(`${githubAuthBase}/login/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, scope: githubOAuthScopes.join(" ") }),
  });
  const body = await response.json().catch(() => ({})) as DeviceCodeResponse & { error?: string; error_description?: string };
  if (!response.ok || typeof body.device_code !== "string") {
    throw new Error(body.error_description ?? body.error ?? "GitHub device authorization failed.");
  }
  return body;
}

export async function pollGithubDeviceAuth(deviceCode: string): Promise<{ status: "pending" | "slow_down" | "expired" | "complete"; account?: GithubAccountStatus; message?: string }> {
  const clientId = configuredClientId();
  if (clientId === null) {
    throw new Error("Set GITHUB_CLIENT_ID to enable GitHub login.");
  }
  const response = await fetch(`${githubAuthBase}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  const body = await response.json().catch(() => ({})) as PollTokenResponse;
  if (body.error === "authorization_pending") {
    return { status: "pending" };
  }
  if (body.error === "slow_down") {
    return { status: "slow_down" };
  }
  if (body.error === "expired_token") {
    return { status: "expired", message: body.error_description ?? "The GitHub login code expired." };
  }
  if (!response.ok || typeof body.access_token !== "string") {
    throw new Error(body.error_description ?? body.error ?? "GitHub authorization failed.");
  }
  const token = body.access_token;
  const { account, scopes } = await fetchUser(token);
  const storedAccount: GithubAccountStatus = {
    ...account,
    scopes: scopes.length > 0 ? scopes : normalizeScopes(body.scope),
    source: "oauth",
    updatedAt: new Date().toISOString(),
  };
  await writeStoredAuth({
    version: 1,
    account: {
      ...storedAccount,
      ...await encryptToken(token),
    },
  });
  return { status: "complete", account: storedAccount };
}

export async function clearGithubAuth(): Promise<void> {
  await rm(authFilePath(), { force: true }).catch(() => undefined);
}

export async function getGithubToken(): Promise<GithubToken> {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken !== undefined && envToken.length > 0) {
    const { account, scopes } = await fetchUser(envToken);
    return { token: envToken, account: { ...account, scopes, source: "env", updatedAt: new Date().toISOString() } };
  }
  const stored = await readStoredAuth();
  if (stored === null) {
    throw new Error("Connect GitHub before exporting.");
  }
  return {
    token: await decryptToken(stored.account),
    account: {
      login: stored.account.login,
      id: stored.account.id,
      avatarUrl: stored.account.avatarUrl,
      htmlUrl: stored.account.htmlUrl,
      scopes: stored.account.scopes,
      source: stored.account.source,
      updatedAt: stored.account.updatedAt,
    },
  };
}
