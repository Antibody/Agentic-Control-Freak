const DEFAULT_USER_TEXT_LIMIT = 1600;
const DEFAULT_EVENT_TEXT_LIMIT = 4000;
const TRUNCATION_NOTICE = "\n\n[truncated; full output is available in artifacts]";

export function boundedText(input: string, maxChars = DEFAULT_USER_TEXT_LIMIT): string {
  const normalized = input.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const suffixBudget = TRUNCATION_NOTICE.length;
  const prefixLength = Math.max(0, maxChars - suffixBudget);
  return `${normalized.slice(0, prefixLength).trimEnd()}${TRUNCATION_NOTICE}`;
}

export function chatSummary(input: string): string {
  return boundedText(input, DEFAULT_USER_TEXT_LIMIT);
}

export function eventText(input: string): string {
  return boundedText(input, DEFAULT_EVENT_TEXT_LIMIT);
}

export function tailExcerpt(input: string, maxChars = 900): string {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return normalized.slice(-maxChars).trimStart();
}
