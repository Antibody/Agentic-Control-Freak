import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface ProviderSettings {
  path: string;
  data: Record<string, unknown>;
  exists: boolean;
  error: string | null;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringSetting(settings: ProviderSettings | null, key: string): string | null {
  const value = settings?.data[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function agySettingsPath(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

export async function readProviderSettings(pathname: string): Promise<ProviderSettings> {
  try {
    const raw = await readFile(pathname, "utf8");
    return { path: pathname, data: objectRecord(JSON.parse(raw) as unknown), exists: true, error: null };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") {
      return { path: pathname, data: {}, exists: false, error: null };
    }
    const message = error instanceof Error ? error.message : "Unable to read provider settings.";
    return { path: pathname, data: {}, exists: false, error: message };
  }
}

export async function writeProviderSettings(pathname: string, data: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}
