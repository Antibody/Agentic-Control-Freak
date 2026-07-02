import type { JsonObject } from "@/lib/shared/types";


export interface ClaudeStructuredOutput {
  summary: string;
  filesChanged: string[];
  verificationSteps: string[];
  risks: string[];
  needsFollowup: boolean;
}

export interface ClaudeStreamTelemetry {
  summary: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  sessionId: string | null;
  compaction: boolean;
  reasoning: string[];
  initModel: string | null;
  initTools: string[] | null;
  initMcpServers: string[] | null;
  initPermissionMode: string | null;
  apiKeySource: string | null;
  cliVersion: string | null;
  rateLimited: boolean;
  rateLimitDetail: string | null;
  structured: ClaudeStructuredOutput | null;
  recoveredStructured: ClaudeStructuredOutput | null;
  resultSubtype: string | null;
  terminalReason: string | null;
  isError: boolean;
  apiErrorStatus: string | null;
  permissionDenials: Array<{ tool_name: string; tool_use_id: string; tool_input: Record<string, unknown> }>;
}

export function parseClaudeStructuredOutput(value: unknown): ClaudeStructuredOutput | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const summary = typeof record.summary === "string" ? record.summary : null;
  if (summary === null) return null;
  return {
    summary,
    filesChanged: (stringList(record.filesChanged) ?? []),
    verificationSteps: (stringList(record.verificationSteps) ?? []),
    risks: (stringList(record.risks) ?? []),
    needsFollowup: record.needsFollowup === true,
  };
}

function readableClaudeThinking(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || /encrypted|redacted/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function parseClaudeContentBlocks(value: unknown, out: ClaudeStreamTelemetry): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const block of value) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "thinking") {
      const thinking = readableClaudeThinking(record.thinking ?? record.text);
      if (thinking !== null) out.reasoning.push(thinking);
    }
    if (type === "tool_use" && record.name === "StructuredOutput" && out.recoveredStructured === null) {
      const recovered = parseClaudeStructuredOutput(record.input);
      if (recovered !== null) out.recoveredStructured = recovered;
    }
  }
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).name === "string") {
        return (entry as Record<string, unknown>).name as string;
      }
      return null;
    })
    .filter((entry): entry is string => entry !== null && entry.length > 0);
  return items.length > 0 ? items : [];
}

function parseClaudeInitEvent(event: Record<string, unknown>, out: ClaudeStreamTelemetry): void {
  if (typeof event.model === "string" && event.model.length > 0) out.initModel = event.model;
  if (typeof event.permissionMode === "string") out.initPermissionMode = event.permissionMode;
  if (typeof event.apiKeySource === "string") out.apiKeySource = event.apiKeySource;
  if (typeof event.claude_code_version === "string") out.cliVersion = event.claude_code_version;
  const tools = stringList(event.tools);
  if (tools !== null) out.initTools = tools;
  const mcp = stringList(event.mcp_servers);
  if (mcp !== null) out.initMcpServers = mcp;
}

function parseClaudeRateLimit(event: Record<string, unknown>, out: ClaudeStreamTelemetry): void {
  const info = typeof event.rate_limit_info === "object" && event.rate_limit_info !== null
    ? (event.rate_limit_info as Record<string, unknown>)
    : null;
  const status = info !== null && typeof info.status === "string" ? info.status : null;
  if (status !== null && status !== "allowed") {
    out.rateLimited = true;
    const kind = typeof info?.rateLimitType === "string" ? info.rateLimitType : "rate limit";
    out.rateLimitDetail = `${kind}: ${status}`;
  }
}

export function parseClaudeStreamJson(stdout: string): ClaudeStreamTelemetry {
  const out: ClaudeStreamTelemetry = {
    summary: null, inputTokens: null, outputTokens: null, costUsd: null, sessionId: null, compaction: false, reasoning: [],
    initModel: null, initTools: null, initMcpServers: null, initPermissionMode: null, apiKeySource: null, cliVersion: null,
    rateLimited: false, rateLimitDetail: null, structured: null, recoveredStructured: null, resultSubtype: null, terminalReason: null,
    isError: false, apiErrorStatus: null, permissionDenials: [],
  };
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line[0] !== "{") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof event.type === "string" ? event.type : "";
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    if (subtype.includes("compact") || event.compact_metadata !== undefined) out.compaction = true;
    if (typeof event.session_id === "string" && event.session_id.length > 0) out.sessionId = event.session_id;
    if (type === "system" && subtype === "init") parseClaudeInitEvent(event, out);
    if (type === "rate_limit_event") parseClaudeRateLimit(event, out);
    if (type.includes("retry") || subtype.includes("retry")) { out.rateLimited = true; out.rateLimitDetail = out.rateLimitDetail ?? "api retry"; }
    parseClaudeContentBlocks((event.message as JsonObject | undefined)?.content, out);
    parseClaudeContentBlocks(event.content, out);
    if (type === "result") {
      if (subtype.length > 0) out.resultSubtype = subtype;
      if (typeof event.terminal_reason === "string" && event.terminal_reason.length > 0) out.terminalReason = event.terminal_reason;
      if (event.is_error === true) out.isError = true;
      if (typeof event.api_error_status === "string" && event.api_error_status.length > 0) out.apiErrorStatus = event.api_error_status;
      if (typeof event.result === "string" && event.result.trim().length > 0) out.summary = event.result.trim();
      const structured = parseClaudeStructuredOutput(event.structured_output);
      if (structured !== null) out.structured = structured;
      if (Array.isArray(event.permission_denials)) {
        for (const d of event.permission_denials) {
          if (typeof d === "object" && d !== null && typeof (d as Record<string, unknown>).tool_name === "string") {
            const denial = d as Record<string, unknown>;
            out.permissionDenials.push({
              tool_name: denial.tool_name as string,
              tool_use_id: typeof denial.tool_use_id === "string" ? denial.tool_use_id : "",
              tool_input: (typeof denial.tool_input === "object" && denial.tool_input !== null ? denial.tool_input : {}) as Record<string, unknown>,
            });
          }
        }
      }
      if (typeof event.total_cost_usd === "number") out.costUsd = event.total_cost_usd;
      const usage = typeof event.usage === "object" && event.usage !== null ? (event.usage as Record<string, unknown>) : null;
      if (usage !== null) {
        if (typeof usage.input_tokens === "number") out.inputTokens = usage.input_tokens;
        if (typeof usage.output_tokens === "number") out.outputTokens = usage.output_tokens;
      }
    }
  }
  return out;
}
