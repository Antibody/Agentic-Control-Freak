import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const root = path.resolve(args.get("--root") ?? process.cwd());
const host = args.get("--host") ?? "127.0.0.1";
const port = Number(args.get("--port") ?? "3100");

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".pdf", "application/pdf"],
]);

function hostnameFromHostHeader(value) {
  if (typeof value !== "string") {
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

function isLoopbackHost(hostHeader) {
  const hostname = hostnameFromHostHeader(hostHeader);
  if (hostname === null) {
    return false;
  }
  const value = hostname.toLowerCase();
  if (value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const octets = value.split(".");
  if (octets.length !== 4 || octets[0] !== "127") {
    return false;
  }
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function hasDotSegment(relativePath) {
  return relativePath.split(/[/\\]+/).some((segment) => segment.startsWith("."));
}

function resolveRequestPath(url) {
  const parsed = new URL(url, `http://${host}:${port}`);
  const decoded = decodeURIComponent(parsed.pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (hasDotSegment(relative)) {
    return null;
  }
  const resolved = path.resolve(root, relative);
  const rootRelative = path.relative(root, resolved);
  if (rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) {
    return null;
  }
  if (existsSync(resolved) && statSync(resolved).isDirectory()) {
    return path.join(resolved, "index.html");
  }
  return resolved;
}

function isRealpathInsideRoot(resolved) {
  try {
    const rootReal = realpathSync(root);
    const real = realpathSync(resolved);
    const a = process.platform === "win32" ? real.toLowerCase() : real;
    const b = process.platform === "win32" ? rootReal.toLowerCase() : rootReal;
    return a === b || a.startsWith(b + path.sep);
  } catch {
    return false;
  }
}

const server = createServer((request, response) => {
  if (!isLoopbackHost(request.headers.host ?? null)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  const resolved = resolveRequestPath(request.url ?? "/");
  if (resolved === null) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  if (!isRealpathInsideRoot(resolved)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes.get(path.extname(resolved).toLowerCase()) ?? "application/octet-stream",
  });
  createReadStream(resolved).pipe(response);
});

server.listen(port, host, () => {
  const script = fileURLToPath(import.meta.url);
  console.log(`Static preview server running at http://${host}:${port}`);
  console.log(`Serving ${root}`);
  console.log(`Script ${script}`);
});
