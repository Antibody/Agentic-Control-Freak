export interface LocalApiGuardInput {
  hostHeader: string | null;
  originHeader: string | null;
  protocol: string;
}

export interface LocalApiGuardDecision {
  allowed: boolean;
  reason: string | null;
}

function hostnameFromHostHeader(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(1, end) : null;
  }
  const colon = trimmed.indexOf(":");
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
}

function isLoopbackHostname(hostname: string | null): boolean {
  if (hostname === null) {
    return false;
  }
  const host = hostname.toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const octets = host.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function originFromHost(protocol: string, hostHeader: string): string | null {
  const trimmedHost = hostHeader.trim();
  if (trimmedHost.length === 0) {
    return null;
  }
  const normalizedProtocol = protocol.endsWith(":") ? protocol : `${protocol}:`;
  try {
    return new URL(`${normalizedProtocol}//${trimmedHost}`).origin;
  } catch {
    return null;
  }
}

function originFromOriginHeader(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === "null") {
    return null;
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

export function evaluateLocalApiGuard(input: LocalApiGuardInput): LocalApiGuardDecision {
  const host = hostnameFromHostHeader(input.hostHeader);
  if (!isLoopbackHostname(host)) {
    return { allowed: false, reason: "non-loopback Host header." };
  }

  if (input.originHeader !== null) {
    const expectedOrigin = originFromHost(input.protocol, input.hostHeader ?? "");
    const actualOrigin = originFromOriginHeader(input.originHeader);
    if (expectedOrigin === null || actualOrigin === null || actualOrigin !== expectedOrigin) {
      return { allowed: false, reason: "cross-origin request to a local-only API." };
    }
  }

  return { allowed: true, reason: null };
}

