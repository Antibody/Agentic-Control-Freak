import path from "node:path";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createSkillRecord, currentTimestamp, mutateDatabase, updateWorkSessionTimestamp } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import { discoverAppSkills, discoverWorkspaceCodexSkills, type DiscoveredSkill } from "@/lib/server/skills/skill-loader";
import type { Identifier, SkillRecord, WorkSessionRecord } from "@/lib/shared/types";

export interface ImportAppSkillInput {
  name: string;
  description?: string;
  body: string;
  allowImplicit?: boolean;
  fileNameHint?: string;
  preserveMarkdown?: boolean;
}

function sameSource(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sanitizeSkillSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug.length > 0 ? slug : "custom-skill";
}

function frontmatterValue(value: string): string {
  return `"${value.replace(/\r?\n/g, " ").replace(/"/g, "'").trim()}"`;
}

async function fileExists(pathname: string): Promise<boolean> {
  try {
    await access(pathname, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function uniqueAppSkillPath(slug: string): Promise<string> {
  const skillsDir = path.join(process.cwd(), ".skills");
  await mkdir(skillsDir, { recursive: true });
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const candidate = path.join(skillsDir, `${slug}${suffix}.md`);
    if (!(await fileExists(candidate))) return candidate;
  }
  throw new Error("Unable to allocate a unique skill file name.");
}

function isInsideDirectory(childPath: string, parentPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function renderAppSkillMarkdown(input: Required<Pick<ImportAppSkillInput, "name" | "body">> & Pick<ImportAppSkillInput, "description" | "allowImplicit">): string {
  const slug = sanitizeSkillSlug(input.name);
  const description = input.description?.trim() || `Custom skill: ${input.name.trim()}`;
  return [
    "---",
    `name: ${slug}`,
    `display_name: ${frontmatterValue(input.name)}`,
    `description: ${frontmatterValue(description)}`,
    `allow_implicit: ${input.allowImplicit === false ? "false" : "true"}`,
    "---",
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

export async function importAppSkill(input: ImportAppSkillInput): Promise<{ skill: SkillRecord; path: string }> {
  const rawName = input.name.trim();
  if (rawName.length === 0) {
    throw new Error("Skill name is required.");
  }
  if (input.body.trim().length === 0) {
    throw new Error("Skill instructions are required.");
  }
  const hint = input.fileNameHint?.replace(/\.md$/i, "") ?? rawName;
  const slug = sanitizeSkillSlug(hint);
  const targetPath = await uniqueAppSkillPath(slug);
  const content = input.preserveMarkdown === true && input.body.trimStart().startsWith("---")
    ? `${input.body.trim()}\n`
    : renderAppSkillMarkdown({
        name: rawName,
        description: input.description,
        body: input.body,
        allowImplicit: input.allowImplicit,
      });
  await writeFile(targetPath, content, "utf8");
  const skills = await refreshSkillRegistry();
  const skill = skills.find((candidate) => sameSource(candidate.sourcePath, targetPath));
  if (skill === undefined) {
    throw new Error("Skill file was written but could not be loaded.");
  }
  await emitEvent({
    workSessionId: null,
    eventName: "skill.imported",
    aggregateType: "skill",
    aggregateId: skill.id,
    payload: { name: skill.name, sourcePath: targetPath },
  });
  return { skill, path: targetPath };
}

function reconcileSkill(existing: SkillRecord, discovered: DiscoveredSkill): { changed: boolean; trustRequired: boolean } {
  const changed = existing.contentHash !== discovered.contentHash;
  existing.name = discovered.name;
  existing.description = discovered.description;
  existing.sourceType = discovered.sourceType;
  existing.sourceScope = discovered.sourceScope;
  existing.sourcePath = discovered.sourcePath;
  existing.contentHash = discovered.contentHash;
  existing.frontmatter = discovered.frontmatter;
  existing.bodyPreview = discovered.bodyPreview;
  existing.displayName = discovered.displayName;
  existing.shortDescription = discovered.shortDescription;
  existing.icon = discovered.icon;
  existing.color = discovered.color;
  existing.diagnostics = discovered.diagnostics;
  existing.updatedAt = currentTimestamp();
  existing.lastLoadedAt = currentTimestamp();
  if (changed && !discovered.trustedByDefault) {
    existing.trusted = false;
    existing.allowImplicit = false;
  }
  return { changed, trustRequired: changed && !existing.trusted };
}

export async function refreshSkillRegistry(input: { workSession?: WorkSessionRecord | null } = {}): Promise<SkillRecord[]> {
  const discovered = [
    ...await discoverAppSkills(),
    ...(input.workSession === undefined || input.workSession === null ? [] : await discoverWorkspaceCodexSkills(input.workSession.activeWorktreePath)),
  ];
  const events: Array<{ eventName: "skill.discovered" | "skill.changed" | "skill.trust_required"; skill: SkillRecord }> = [];
  const skills = await mutateDatabase((db) => {
    db.skills ??= [];
    for (const item of discovered) {
      const existing = db.skills.find((candidate) => sameSource(candidate.sourcePath, item.sourcePath));
      if (existing === undefined) {
        const record = createSkillRecord({
          name: item.name,
          description: item.description,
          sourceType: item.sourceType,
          sourceScope: item.sourceScope,
          sourcePath: item.sourcePath,
          enabled: item.diagnostics.length === 0,
          allowImplicit: item.trustedByDefault && item.allowImplicit && item.diagnostics.length === 0,
          trusted: item.trustedByDefault,
          contentHash: item.contentHash,
          frontmatter: item.frontmatter,
          bodyPreview: item.bodyPreview,
          displayName: item.displayName,
          shortDescription: item.shortDescription,
          icon: item.icon,
          color: item.color,
          diagnostics: item.diagnostics,
        });
        db.skills.push(record);
        events.push({ eventName: "skill.discovered", skill: { ...record } });
        if (!record.trusted) {
          events.push({ eventName: "skill.trust_required", skill: { ...record } });
        }
        continue;
      }
      const result = reconcileSkill(existing, item);
      if (result.changed) {
        events.push({ eventName: "skill.changed", skill: { ...existing } });
      }
      if (result.trustRequired) {
        events.push({ eventName: "skill.trust_required", skill: { ...existing } });
      }
    }
    if (input.workSession !== undefined && input.workSession !== null) {
      const session = db.workSessions.find((candidate) => candidate.id === input.workSession?.id);
      if (session !== undefined) updateWorkSessionTimestamp(session);
    }
    return db.skills.map((skill) => ({ ...skill }));
  });

  for (const event of events) {
    await emitEvent({
      workSessionId: input.workSession?.id ?? null,
      eventName: event.eventName,
      aggregateType: "skill",
      aggregateId: event.skill.id,
      payload: {
        name: event.skill.name,
        description: event.skill.description,
        sourceType: event.skill.sourceType,
        sourcePath: event.skill.sourcePath,
      },
    });
  }

  return skills;
}

export async function updateSkillSettings(input: {
  skillId: Identifier;
  enabled?: boolean;
  allowImplicit?: boolean;
  trusted?: boolean;
}): Promise<SkillRecord> {
  const skill = await mutateDatabase((db) => {
    const record = db.skills.find((candidate) => candidate.id === input.skillId);
    if (record === undefined) {
      throw new Error("Skill was not found.");
    }
    if (input.enabled !== undefined) record.enabled = input.enabled;
    if (input.allowImplicit !== undefined) record.allowImplicit = input.allowImplicit;
    if (input.trusted !== undefined) record.trusted = input.trusted;
    if (!record.trusted) record.allowImplicit = false;
    record.updatedAt = currentTimestamp();
    return { ...record };
  });
  await emitEvent({
    workSessionId: null,
    eventName: skill.enabled ? "skill.imported" : "skill.disabled",
    aggregateType: "skill",
    aggregateId: skill.id,
    payload: { name: skill.name, enabled: String(skill.enabled), allowImplicit: String(skill.allowImplicit), trusted: String(skill.trusted) },
  });
  return skill;
}

export async function deleteAppSkill(skillId: Identifier): Promise<SkillRecord> {
  const appSkillsDir = path.join(process.cwd(), ".skills");
  const deleted = await mutateDatabase((db) => {
    const index = db.skills.findIndex((candidate) => candidate.id === skillId);
    if (index < 0) {
      throw new Error("Skill was not found.");
    }
    const record = db.skills[index];
    if (record === undefined) {
      throw new Error("Skill was not found.");
    }
    if (record.sourceScope !== "app" || record.sourceType !== "app-md") {
      throw new Error("Only app-level imported skills can be deleted from this UI.");
    }
    if (!isInsideDirectory(record.sourcePath, appSkillsDir)) {
      throw new Error("Refusing to delete a skill file outside the app .skills directory.");
    }
    db.skills.splice(index, 1);
    return { ...record };
  });
  await rm(deleted.sourcePath, { force: true });
  await emitEvent({
    workSessionId: null,
    eventName: "skill.deleted",
    aggregateType: "skill",
    aggregateId: deleted.id,
    payload: { name: deleted.name, sourcePath: deleted.sourcePath },
  });
  return deleted;
}
