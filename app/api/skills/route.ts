import { NextRequest, NextResponse } from "next/server";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { importAppSkill, refreshSkillRegistry } from "@/lib/server/skills/skill-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const maxSkillImportFiles = 8;
const maxSkillImportBytes = 512 * 1024;

function extensionFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

function skillNameFromFileName(name: string): string {
  const base = name.replace(/\.[^.]+$/, "").trim();
  return base.length > 0 ? base : "Imported skill";
}

function assertSupportedSkillFile(file: File): void {
  const extension = extensionFromName(file.name);
  const mime = file.type.toLowerCase();
  if (extension !== ".md" && extension !== ".markdown" && extension !== ".txt" && mime !== "text/markdown" && mime !== "text/plain") {
    throw new Error(`Unsupported skill file: ${file.name || "unnamed"}. Use Markdown or plain text.`);
  }
  if (file.size > maxSkillImportBytes) {
    throw new Error(`Skill file is too large: ${file.name || "unnamed"}. Limit is 512 KB.`);
  }
}

export async function GET(): Promise<NextResponse> {
  const skills = await refreshSkillRegistry();
  return NextResponse.json({ ok: true, data: { skills } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("multipart/form-data")) {
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > maxSkillImportFiles * 1024 * 1024) {
        throw new Error("Request body too large.");
      }
      const form = await request.formData();
      const files = [...form.getAll("files[]"), ...form.getAll("skillFiles[]")]
        .filter((entry): entry is File => entry instanceof File);
      if (files.length === 0) {
        throw new Error("Choose at least one Markdown or text file.");
      }
      if (files.length > maxSkillImportFiles) {
        throw new Error(`Import at most ${maxSkillImportFiles} skill files at once.`);
      }
      const imported = [];
      for (const file of files) {
        assertSupportedSkillFile(file);
        const body = Buffer.from(await file.arrayBuffer()).toString("utf8");
        imported.push(await importAppSkill({
          name: skillNameFromFileName(file.name),
          description: `Imported from ${file.name || "uploaded file"}.`,
          body,
          fileNameHint: file.name,
          allowImplicit: true,
          preserveMarkdown: extensionFromName(file.name) === ".md" || extensionFromName(file.name) === ".markdown",
        }));
      }
      const skills = await refreshSkillRegistry();
      return NextResponse.json({ ok: true, data: { imported: imported.map((entry) => entry.skill), skills } });
    }

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.action === "create") {
      const imported = await importAppSkill({
        name: typeof body.name === "string" ? body.name : "",
        description: typeof body.description === "string" ? body.description : undefined,
        body: typeof body.body === "string" ? body.body : "",
        allowImplicit: typeof body.allowImplicit === "boolean" ? body.allowImplicit : true,
      });
      const skills = await refreshSkillRegistry();
      return NextResponse.json({ ok: true, data: { skill: imported.skill, skills } });
    }

    const workSessionId = typeof body.workSessionId === "string" ? body.workSessionId : null;
    const db = await getDatabaseSnapshot();
    const workSession = workSessionId === null ? null : db.workSessions.find((candidate) => candidate.id === workSessionId) ?? null;
    const skills = await refreshSkillRegistry({ workSession });
    return NextResponse.json({ ok: true, data: { skills } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to refresh skills." }, { status: 500 });
  }
}
