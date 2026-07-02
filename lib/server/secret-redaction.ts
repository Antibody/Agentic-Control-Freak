export function redactSecrets(text: string): string {
  if (text.length === 0) {
    return text;
  }
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<redacted-private-key>")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<redacted-api-key>")
    .replace(/\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g, "<redacted-github-token>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted-github-token>")
    .replace(/\bhf_[A-Za-z0-9]{20,}\b/g, "<redacted-huggingface-token>")
    .replace(/\b\d{6,}:AA[A-Za-z0-9_-]{20,}\b/g, "<redacted-telegram-token>")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<redacted-slack-token>")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted-aws-key>")
    .replace(/\bya29\.[0-9A-Za-z._-]{20,}/g, "<redacted-google-oauth-token>")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "<redacted-google-api-key>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/g, "Bearer <redacted>")
    .replace(
      /\b(authorization|bearer|token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|encryption[_-]?key)(\s*[:=]\s*)["']?[^"'\s,;]+/gi,
      (_match, label: string, separator: string) => `${label}${separator}<redacted>`,
    );
}
