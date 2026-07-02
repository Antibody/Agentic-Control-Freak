import { NextRequest, NextResponse } from "next/server";
import { deleteAppSkill, updateSkillSettings } from "@/lib/server/skills/skill-registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const skill = await updateSkillSettings({
      skillId: params.id,
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      allowImplicit: typeof body.allowImplicit === "boolean" ? body.allowImplicit : undefined,
      trusted: typeof body.trusted === "boolean" ? body.trusted : undefined,
    });
    return NextResponse.json({ ok: true, data: skill });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to update skill." }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  try {
    const params = await context.params;
    const skill = await deleteAppSkill(params.id);
    return NextResponse.json({ ok: true, data: skill });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unable to delete skill." }, { status: 500 });
  }
}
