import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return null;
  }
  const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
  if (match === null) {
    return null;
  }
  const key = match[1];
  let value = match[2] ?? "";
  if (value.startsWith('"')) {
    const end = value.lastIndexOf('"');
    value = end > 0 ? value.slice(1, end) : value.slice(1);
    value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"');
  } else if (value.startsWith("'")) {
    const end = value.lastIndexOf("'");
    value = end > 0 ? value.slice(1, end) : value.slice(1);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return { key, value };
}

export function loadEnvFiles(cwd = process.cwd()) {
  const shellKeys = new Set(Object.keys(process.env));
  for (const fileName of [".env", ".env.local"]) {
    const filePath = path.join(cwd, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const parsed = parseEnvLine(line);
      if (parsed === null || shellKeys.has(parsed.key)) {
        continue;
      }
      process.env[parsed.key] = parsed.value;
    }
  }
}
