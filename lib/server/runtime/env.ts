import type { ProcessEnvironment } from "@/lib/server/runtime/process-runner";

const knownNoisyNpmConfigKeys = new Set([
  "npm_config_npm_globalconfig",
  "npm_config_verify_deps_before_run",
  "npm_config__jsr_registry",
]);

function shouldDropInheritedEnvKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "node_env" ||
    normalized === "next_runtime" ||
    normalized === "turbopack" ||
    normalized.startsWith("next_private_") ||
    knownNoisyNpmConfigKeys.has(normalized)
  );
}

const sensitiveEnvExactKeys = new Set([
  "github_token",
  "github_token_encryption_key",
  "github_token_key",
  "github_client_id",
  "event_webhook_url",
  "telegram_bot_token",
  "telegram_control_worker_token",
]);

function isSensitiveEnvKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (sensitiveEnvExactKeys.has(normalized)) {
    return true;
  }
  return (
    (normalized.startsWith("github_") || normalized.startsWith("telegram_")) &&
    (normalized.includes("token") || normalized.includes("secret") || normalized.includes("encryption"))
  );
}

const ambientCloudSecretExactKeys = new Set(
  [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AZURE_CLIENT_SECRET",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "DATABASE_URL",
    "PGPASSWORD",
    "STRIPE_SECRET_KEY",
  ].map((key) => key.toUpperCase()),
);

function isAmbientCloudSecretKey(key: string): boolean {
  return ambientCloudSecretExactKeys.has(key.toUpperCase());
}

function applyOverrides(env: ProcessEnvironment, overrides: ProcessEnvironment): void {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
}

export function createSanitizedProcessEnv(overrides: ProcessEnvironment = {}): ProcessEnvironment {
  const env: ProcessEnvironment = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (shouldDropInheritedEnvKey(key) || isSensitiveEnvKey(key) || isAmbientCloudSecretKey(key)) {
      continue;
    }
    env[key] = value;
  }

  applyOverrides(env, overrides);

  return env;
}

const agentEnvExactKeys = new Set(
  [
    "PATH", "PATHEXT", "PWD", "OLDPWD", "SHELL", "TERM", "COLORTERM", "TZ",
    "LANG", "LANGUAGE", "TMPDIR", "TEMP", "TMP", "HOME", "USER", "LOGNAME", "HOSTNAME", "DISPLAY",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "FTP_PROXY", "NODE_OPTIONS", "NODE_PATH",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
    "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
    "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432", "PUBLIC", "ALLUSERSPROFILE",
    "COMPUTERNAME", "USERDOMAIN", "USERNAME", "SESSIONNAME", "NUMBER_OF_PROCESSORS", "OS",
    "PSMODULEPATH", "DRIVERDATA",
  ].map((key) => key.toUpperCase()),
);

const agentEnvPrefixes = [
  "LC_", "XDG_", "PROCESSOR_",
  "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "GEMINI_", "GOOGLE_", "VERTEX_",
  "AGY_", "ANTIGRAVITY_", "OLLAMA_", "AZURE_OPENAI_", "R_",
];

const agentEnvDeniedExactKeys = new Set(["GOOGLE_APPLICATION_CREDENTIALS"]);

function isAllowedAgentEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (agentEnvDeniedExactKeys.has(upper)) {
    return false;
  }
  return agentEnvExactKeys.has(upper) || agentEnvPrefixes.some((prefix) => upper.startsWith(prefix));
}

export function createAgentProcessEnv(overrides: ProcessEnvironment = {}): ProcessEnvironment {
  const env: ProcessEnvironment = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isSensitiveEnvKey(key) || shouldDropInheritedEnvKey(key)) {
      continue;
    }
    if (isAllowedAgentEnvKey(key)) {
      env[key] = value;
    }
  }

  applyOverrides(env, overrides);

  return env;
}

const mlSecretEnvKeys = new Set(
  [
    "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGINGFACE_TOKEN",
    "WANDB_API_KEY", "WANDB_BASE_URL", "COMET_API_KEY", "NEPTUNE_API_TOKEN",
    "KAGGLE_KEY", "KAGGLE_USERNAME", "OPENAI_API_KEY", "REPLICATE_API_TOKEN",
  ].map((key) => key.toUpperCase()),
);

function isMlSecretEnvKey(key: string): boolean {
  return mlSecretEnvKeys.has(key.toUpperCase());
}

export function createMlJobProcessEnv(
  overrides: ProcessEnvironment = {},
  options: { allowSecrets?: boolean } = {},
): ProcessEnvironment {
  const env = createSanitizedProcessEnv();

  if (options.allowSecrets !== true) {
    for (const key of Object.keys(env)) {
      if (isMlSecretEnvKey(key)) {
        delete env[key];
      }
    }
  }

  applyOverrides(env, overrides);

  return env;
}
