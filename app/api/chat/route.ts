import { NextRequest, NextResponse } from "next/server";
import { handleUserMessage } from "@/lib/server/workflow-controller";
import { saveBinaryArtifact } from "@/lib/server/artifacts";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import type { AppDatabase, ChatPostRequest, Identifier } from "@/lib/shared/types";
import type { UploadedAttachment, UploadedAttachmentKind } from "@/lib/server/chat-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ATTACHMENT_COUNT = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

const ALLOWED_ATTACHMENT_TYPES: Record<string, UploadedAttachmentKind> = {
  "image/png": "image",
  "image/jpeg": "image",
  "image/webp": "image",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "presentation",
  "text/csv": "spreadsheet",
  "application/vnd.ms-excel": "spreadsheet",
};

const EXTENSION_ATTACHMENT_TYPES: Record<string, { kind: UploadedAttachmentKind; mimeType: string }> = {
  ".png": { kind: "image", mimeType: "image/png" },
  ".jpg": { kind: "image", mimeType: "image/jpeg" },
  ".jpeg": { kind: "image", mimeType: "image/jpeg" },
  ".webp": { kind: "image", mimeType: "image/webp" },
  ".pdf": { kind: "pdf", mimeType: "application/pdf" },
  ".docx": { kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  ".xlsx": { kind: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  ".csv": { kind: "spreadsheet", mimeType: "text/csv" },
  ".pptx": { kind: "presentation", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};

function isChatPostRequest(value: unknown): value is ChatPostRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.content === "string" &&
    (candidate.projectId === undefined || typeof candidate.projectId === "string") &&
    (candidate.chatSessionId === undefined || typeof candidate.chatSessionId === "string")
  );
}

function contentTypeOf(request: NextRequest): string {
  return request.headers.get("content-type")?.toLowerCase() ?? "";
}

function fieldValue(form: FormData, key: string): string | undefined {
  const value = form.get(key);
  return typeof value === "string" ? value : undefined;
}

function resolveAttachmentType(file: File): { kind: UploadedAttachmentKind; mimeType: string } | null {
  const byMime = ALLOWED_ATTACHMENT_TYPES[file.type];
  if (byMime !== undefined) {
    const canonicalCsv = file.type === "application/vnd.ms-excel" && file.name.toLowerCase().endsWith(".csv");
    return { kind: byMime, mimeType: canonicalCsv ? "text/csv" : file.type };
  }
  const dot = file.name.lastIndexOf(".");
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  return EXTENSION_ATTACHMENT_TYPES[extension] ?? null;
}

function isValidImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png") {
    return bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a;
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === "image/webp") {
    return bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50;
  }
  return false;
}

function isZipSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function isPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;
}

function isLikelyCsv(bytes: Uint8Array): boolean {
  const sample = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString("utf8");
  return !sample.includes("\u0000") && (sample.includes(",") || sample.includes(";") || sample.includes("\t") || sample.includes("\n"));
}

function isValidAttachmentSignature(bytes: Uint8Array, mimeType: string, kind: UploadedAttachmentKind): boolean {
  if (kind === "image") {
    return isValidImageSignature(bytes, mimeType);
  }
  if (kind === "pdf") {
    return isPdfSignature(bytes);
  }
  if (kind === "document" || (kind === "spreadsheet" && mimeType !== "text/csv") || kind === "presentation") {
    return isZipSignature(bytes);
  }
  if (mimeType === "text/csv") {
    return isLikelyCsv(bytes);
  }
  return false;
}

function artifactRoleFor(kind: UploadedAttachmentKind): string {
  switch (kind) {
    case "image":
      return "user_uploaded_image";
    case "pdf":
      return "user_uploaded_pdf";
    case "document":
      return "user_uploaded_document";
    case "spreadsheet":
      return "user_uploaded_spreadsheet";
    case "presentation":
      return "user_uploaded_presentation";
  }
}

function resolveWorkSessionId(input: { projectId?: Identifier; chatSessionId?: Identifier }, db: AppDatabase): Identifier {
  const project = input.projectId !== undefined
    ? db.projects.find((candidate) => candidate.id === input.projectId)
    : db.projects[0];
  if (project === undefined) {
    throw new Error("Project not found for image upload.");
  }
  const chatSession = input.chatSessionId !== undefined
    ? db.chatSessions.find((candidate) => candidate.id === input.chatSessionId)
    : db.chatSessions.find((candidate) => candidate.projectId === project.id);
  if (chatSession === undefined) {
    throw new Error("Chat session not found for image upload.");
  }
  const workSession = db.workSessions.find((candidate) => candidate.projectId === project.id && candidate.chatSessionId === chatSession.id);
  if (workSession === undefined) {
    throw new Error("Work session not found for image upload.");
  }
  return workSession.id;
}

async function parseMultipartChatRequest(request: NextRequest): Promise<ChatPostRequest & { attachments: UploadedAttachment[] }> {
  const maxBodyBytes = MAX_ATTACHMENT_COUNT * MAX_DOCUMENT_BYTES + 4 * 1024 * 1024;
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new Error("Request body too large.");
  }
  const form = await request.formData();
  const content = fieldValue(form, "content") ?? "";
  const projectId = fieldValue(form, "projectId");
  const chatSessionId = fieldValue(form, "chatSessionId");
  const files = form
    .getAll("attachments[]")
    .filter((value): value is File => value instanceof File && value.size > 0);
  if (files.length > MAX_ATTACHMENT_COUNT) {
    throw new Error(`Too many attachments. Attach at most ${MAX_ATTACHMENT_COUNT}.`);
  }
  if (content.trim().length === 0 && files.length === 0) {
    throw new Error("Message content is empty.");
  }
  const db = await getDatabaseSnapshot();
  const workSessionId = resolveWorkSessionId({ projectId, chatSessionId }, db);
  const attachments: UploadedAttachment[] = [];
  for (const file of files) {
    const resolvedType = resolveAttachmentType(file);
    if (resolvedType === null) {
      throw new Error(`Unsupported attachment type: ${file.type || "unknown"}.`);
    }
    const { kind, mimeType } = resolvedType;
    const maxBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
    if (file.size > maxBytes) {
      throw new Error(`${file.name || "upload"} is too large. Maximum size is ${Math.round(maxBytes / (1024 * 1024))} MB.`);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isValidAttachmentSignature(bytes, mimeType, kind)) {
      throw new Error(`${file.name || "upload"} does not match its declared file type.`);
    }
    const artifact = await saveBinaryArtifact({
      workSessionId,
      kind: kind === "image" ? "image" : "file",
      fileName: file.name || "uploaded-attachment",
      bytes,
      metadata: {
        artifactRole: artifactRoleFor(kind),
        attachmentKind: kind,
        contentType: mimeType,
        originalName: file.name || "uploaded-attachment",
        byteSize: file.size,
      },
    });
    attachments.push({
      artifactId: artifact.id,
      kind,
      originalName: file.name || "uploaded-attachment",
      mimeType,
      byteSize: file.size,
    });
  }
  return { content, projectId, chatSessionId, attachments };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    if (contentTypeOf(request).includes("multipart/form-data")) {
      const body = await parseMultipartChatRequest(request);
      const result = await handleUserMessage(body);
      return NextResponse.json({ ok: true, data: result });
    }
    const body = (await request.json()) as unknown;
    if (!isChatPostRequest(body)) {
      return NextResponse.json({ ok: false, error: "Invalid chat request." }, { status: 400 });
    }
    const result = await handleUserMessage(body);
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown chat API error.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
