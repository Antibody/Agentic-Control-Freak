import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { JsonObject, SkillSourceScope, SkillSourceType } from "@/lib/shared/types";

export interface DiscoveredSkill {
  name: string;
  description: string;
  sourceType: SkillSourceType;
  sourceScope: SkillSourceScope;
  sourcePath: string;
  allowImplicit: boolean;
  trustedByDefault: boolean;
  contentHash: string;
  frontmatter: JsonObject;
  body: string;
  bodyPreview: string;
  displayName: string | null;
  shortDescription: string | null;
  icon: string | null;
  color: string | null;
  diagnostics: string[];
}

async function directoryExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function hashContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseScalar(value: string): string | boolean {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function parseFrontmatter(raw: string): { frontmatter: JsonObject; body: string; diagnostics: string[] } {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim(), diagnostics: ["Missing YAML frontmatter."] };
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) {
    return { frontmatter: {}, body: normalized.trim(), diagnostics: ["Unclosed YAML frontmatter."] };
  }
  const yaml = normalized.slice(4, end).trim();
  const body = normalized.slice(end + 4).trim();
  const frontmatter: JsonObject = {};
  const diagnostics: string[] = [];
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (match === null) {
      diagnostics.push(`Ignored unsupported frontmatter line: ${trimmed.slice(0, 80)}`);
      continue;
    }
    const key = match[1] ?? "";
    if (key.length === 0) continue;
    frontmatter[key] = parseScalar(match[2] ?? "");
  }
  return { frontmatter, body, diagnostics };
}

function stringField(frontmatter: JsonObject, key: string): string | null {
  const value = frontmatter[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function booleanField(frontmatter: JsonObject, key: string, fallback: boolean): boolean {
  const value = frontmatter[key];
  return typeof value === "boolean" ? value : fallback;
}

async function loadMarkdownSkill(input: {
  filePath: string;
  sourceType: SkillSourceType;
  sourceScope: SkillSourceScope;
  trustedByDefault: boolean;
}): Promise<DiscoveredSkill | null> {
  const raw = await readFile(input.filePath, "utf8").catch(() => null);
  if (raw === null) return null;
  const parsed = parseFrontmatter(raw);
  const fallbackName = sanitizeName(path.basename(input.filePath).replace(/\.md$/i, ""));
  const name = sanitizeName(stringField(parsed.frontmatter, "name") ?? fallbackName);
  const description = stringField(parsed.frontmatter, "description") ?? "";
  const diagnostics = [...parsed.diagnostics];
  if (name.length === 0) diagnostics.push("Skill name is empty.");
  if (description.length === 0) diagnostics.push("Skill description is missing.");
  if (parsed.body.trim().length === 0) diagnostics.push("Skill body is empty.");

  return {
    name,
    description: description || "No description provided.",
    sourceType: input.sourceType,
    sourceScope: input.sourceScope,
    sourcePath: path.resolve(input.filePath),
    allowImplicit: booleanField(parsed.frontmatter, "allow_implicit", input.sourceType === "app-md"),
    trustedByDefault: input.trustedByDefault,
    contentHash: hashContent(raw),
    frontmatter: parsed.frontmatter,
    body: parsed.body,
    bodyPreview: parsed.body.replace(/\s+/g, " ").trim().slice(0, 320),
    displayName: stringField(parsed.frontmatter, "display_name"),
    shortDescription: stringField(parsed.frontmatter, "short_description"),
    icon: stringField(parsed.frontmatter, "icon"),
    color: stringField(parsed.frontmatter, "color"),
    diagnostics,
  };
}

export async function discoverAppSkills(appRoot = process.cwd()): Promise<DiscoveredSkill[]> {
  const skillsDir = path.join(appRoot, ".skills");
  if (!(await directoryExists(skillsDir))) {
    return [];
  }
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => path.join(skillsDir, entry.name))
    .sort((a, b) => a.localeCompare(b));
  const loaded = await Promise.all(files.map((filePath) =>
    loadMarkdownSkill({ filePath, sourceType: "app-md", sourceScope: "app", trustedByDefault: true })
  ));
  return loaded.filter((skill): skill is DiscoveredSkill => skill !== null);
}

export async function discoverWorkspaceCodexSkills(workspacePath: string): Promise<DiscoveredSkill[]> {
  const root = path.resolve(workspacePath);
  const skillsDir = path.join(root, ".agents", "skills");
  if (!(await directoryExists(skillsDir))) {
    return [];
  }
  const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDir, entry.name, "SKILL.md"))
    .sort((a, b) => a.localeCompare(b));
  const loaded = await Promise.all(files.map((filePath) =>
    loadMarkdownSkill({ filePath, sourceType: "codex-skill", sourceScope: "workspace", trustedByDefault: false })
  ));
  return loaded.filter((skill): skill is DiscoveredSkill => skill !== null);
}

export async function readSkillBody(sourcePath: string, expectedHash?: string): Promise<string> {
  const raw = await readFile(sourcePath, "utf8");
  if (expectedHash !== undefined && hashContent(raw) !== expectedHash) {
    throw new Error("Skill content changed since trust verification; refusing to inject.");
  }
  return parseFrontmatter(raw).body.trim();
}
