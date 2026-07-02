
import { parsePortValue, readControlPlaneRuntimeFile } from "./control-plane-port.mjs";

export const MIN_WORKER_TOKEN_LENGTH = 24;

function isLoopbackHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function validateAppUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`TELEGRAM_CONTROL_APP_URL is not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`TELEGRAM_CONTROL_APP_URL must be http(s); got ${url.protocol}`);
  }
  if (!isLoopbackHostname(url.hostname) && url.protocol !== "https:") {
    throw new Error(
      `Refusing to send the Telegram worker token to a non-loopback URL over http (${rawUrl}). ` +
        "Point TELEGRAM_CONTROL_APP_URL at 127.0.0.1/localhost, or use https for a remote app.",
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

function validateWorkerToken(rawToken) {
  const token = rawToken?.trim();
  if (!token) {
    throw new Error("TELEGRAM_CONTROL_WORKER_TOKEN is required.");
  }
  if (token.length < MIN_WORKER_TOKEN_LENGTH) {
    throw new Error(
      `TELEGRAM_CONTROL_WORKER_TOKEN is too short (${token.length} chars; need >= ${MIN_WORKER_TOKEN_LENGTH}). ` +
        'Generate a strong one, e.g. `node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"`.',
    );
  }
  return token;
}

function deriveDefaultAppUrl() {
  const envPort = parsePortValue(process.env.CONTROL_PLANE_PORT);
  if (envPort !== null) {
    return `http://127.0.0.1:${envPort}`;
  }
  const runtime = readControlPlaneRuntimeFile();
  if (runtime && typeof runtime.baseUrl === "string") {
    return runtime.baseUrl;
  }
  return "http://127.0.0.1:3000";
}

export function resolveTelegramEndpoint() {
  const appUrl = validateAppUrl(process.env.TELEGRAM_CONTROL_APP_URL ?? deriveDefaultAppUrl());
  const workerToken = validateWorkerToken(process.env.TELEGRAM_CONTROL_WORKER_TOKEN);
  return { appUrl, workerToken };
}
