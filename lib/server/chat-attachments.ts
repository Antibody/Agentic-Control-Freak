import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { renderUntrustedSource } from "@/lib/server/source-context";
import { boundedText } from "@/lib/server/text-bounds";
import type { ArtifactRecord, ChatAttachment, Identifier, WorkSessionRecord } from "@/lib/shared/types";

export type UploadedAttachmentKind = ChatAttachment["kind"];

export interface UploadedAttachment {
  artifactId: Identifier;
  kind: UploadedAttachmentKind;
  originalName: string;
  mimeType: string;
  byteSize: number;
}

export type UploadedImageAttachment = UploadedAttachment;

export interface PendingMaterializedAttachment {
  artifact: ArtifactRecord;
  attachment: ChatAttachment;
}

function sanitizeFileStem(input: string): string {
  const base = path.basename(input).replace(/\.[^.\\/]+$/, "");
  const safe = base.replace(/[^a-z0-9._-]/gi, "_").replace(/_+/g, "_").slice(0, 80);
  return safe.length > 0 ? safe : "attachment";
}

function extensionForMime(mimeType: string, fallbackName: string): string {
  const existing = path.extname(fallbackName).toLowerCase().replace(/[^.a-z0-9]/g, "");
  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "application/pdf":
      return ".pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return ".xlsx";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return ".pptx";
    case "text/csv":
      return ".csv";
    default:
      return existing.length > 0 ? existing : ".bin";
  }
}

function safeAttachmentFileName(input: UploadedAttachment, ordinal: number): string {
  return `${String(ordinal).padStart(2, "0")}-${input.artifactId.slice(0, 8)}-${sanitizeFileStem(input.originalName)}${extensionForMime(input.mimeType, input.originalName)}`;
}

function extractedFileName(fileName: string): string {
  return `${fileName}.extracted.md`;
}

export function buildChatAttachmentRecords(input: {
  workSession: WorkSessionRecord;
  messageId: Identifier;
  uploads: UploadedAttachment[];
  artifacts: ArtifactRecord[];
}): { attachments: ChatAttachment[]; materialize: PendingMaterializedAttachment[] } {
  const materialize: PendingMaterializedAttachment[] = [];
  const attachments = input.uploads.map((upload, index) => {
    const artifact = input.artifacts.find((candidate) => candidate.id === upload.artifactId);
    if (artifact === undefined) {
      throw new Error(`Uploaded attachment artifact ${upload.artifactId} was not found.`);
    }
    const fileName = safeAttachmentFileName(upload, index + 1);
    const workspacePath = path.join(".orchestrator", "attachments", input.messageId, fileName);
    const extractedWorkspacePath = upload.kind === "image"
      ? null
      : path.join(".orchestrator", "attachments", input.messageId, extractedFileName(fileName));
    const attachment: ChatAttachment = {
      id: `${input.messageId}:${upload.kind}:${index + 1}`,
      artifactId: upload.artifactId,
      kind: upload.kind,
      originalName: upload.originalName,
      mimeType: upload.mimeType,
      byteSize: upload.byteSize,
      workspacePath,
      absolutePath: path.join(input.workSession.activeWorktreePath, workspacePath),
      extractedWorkspacePath,
      extractedAbsolutePath: extractedWorkspacePath === null ? null : path.join(input.workSession.activeWorktreePath, extractedWorkspacePath),
      extractedSummary: null,
    };
    materialize.push({ artifact, attachment });
    return attachment;
  });
  return { attachments, materialize };
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlTexts(xml: string): string[] {
  const out: string[] = [];
  for (const match of xml.matchAll(/<[^:>]*:?t(?:\s[^>]*)?>([\s\S]*?)<\/[^:>]*:?t>/g)) {
    const text = decodeXmlEntities(match[1].replace(/<[^>]+>/g, "")).trim();
    if (text.length > 0) out.push(text);
  }
  return out;
}

function normalizeLines(lines: string[], limit = 160): string {
  return lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .slice(0, limit)
    .join("\n");
}

const MAX_ZIP_ENTRY_DECOMPRESSED_BYTES = 12 * 1024 * 1024;

type JSZipStreamHelper = {
  on(event: "data", callback: (data: string) => void): JSZipStreamHelper;
  on(event: "error", callback: (error: unknown) => void): JSZipStreamHelper;
  on(event: "end", callback: () => void): JSZipStreamHelper;
  resume(): JSZipStreamHelper;
};

async function zipText(zip: JSZip, name: string): Promise<string | null> {
  const file = zip.file(name);
  if (file === null) {
    return null;
  }
  const stream = (file as unknown as { internalStream(type: "string"): JSZipStreamHelper }).internalStream("string");
  return await new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    let size = 0;
    let truncated = false;
    stream
      .on("data", (data: string) => {
        if (truncated) {
          return;
        }
        size += data.length;
        if (size > MAX_ZIP_ENTRY_DECOMPRESSED_BYTES) {
          truncated = true;
          resolve(chunks.join(""));
          return;
        }
        chunks.push(data);
      })
      .on("error", (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))))
      .on("end", () => {
        if (!truncated) {
          resolve(chunks.join(""));
        }
      })
      .resume();
  });
}

async function extractDocxMarkdown(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const parts = [
    "word/document.xml",
    "word/comments.xml",
    "word/footnotes.xml",
    "word/endnotes.xml",
  ];
  const sections: string[] = [];
  for (const part of parts) {
    const xml = await zipText(zip, part);
    if (xml === null) continue;
    const lines = normalizeLines(xmlTexts(xml));
    if (lines.length > 0) {
      sections.push(`## ${part}\n\n${lines}`);
    }
  }
  return sections.length > 0 ? sections.join("\n\n") : "No text could be extracted from this DOCX file.";
}

async function extractXlsxMarkdown(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const sharedXml = await zipText(zip, "xl/sharedStrings.xml") ?? "";
  const sharedStrings = Array.from(sharedXml.matchAll(/<si[\s\S]*?<\/si>/g)).map((match) => xmlTexts(match[0]).join(""));
  const sheetEntries = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, 20);
  const sections: string[] = [];
  for (const sheetName of sheetEntries) {
    const xml = await zipText(zip, sheetName);
    if (xml === null) continue;
    const rows: string[] = [];
    for (const rowMatch of xml.matchAll(/<row\b[\s\S]*?<\/row>/g)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[0].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1];
        const body = cellMatch[2];
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? "";
        const rawValue = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        const inline = xmlTexts(body).join("");
        const value = type === "s"
          ? sharedStrings[Number(rawValue)] ?? rawValue
          : inline.length > 0 ? inline : decodeXmlEntities(rawValue);
        cells.push(value.replace(/\|/g, "\\|").trim());
      }
      if (cells.some((cell) => cell.length > 0)) {
        rows.push(`| ${cells.join(" | ")} |`);
      }
      if (rows.length >= 80) break;
    }
    sections.push(`## ${sheetName}\n\n${rows.length > 0 ? rows.join("\n") : "No non-empty rows found in bounded extraction."}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : "No worksheet text could be extracted from this XLSX file.";
}

async function extractPptxMarkdown(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const slideEntries = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .slice(0, 80);
  const sections: string[] = [];
  for (const slideName of slideEntries) {
    const xml = await zipText(zip, slideName);
    if (xml === null) continue;
    const lines = normalizeLines(xmlTexts(xml), 80);
    sections.push(`## ${slideName}\n\n${lines.length > 0 ? lines : "No text found on this slide."}`);
  }
  return sections.length > 0 ? sections.join("\n\n") : "No slide text could be extracted from this PPTX file.";
}

function extractCsvMarkdown(bytes: Buffer): string {
  const text = bytes.toString("utf8").replace(/\0/g, "");
  const lines = text.split(/\r?\n/).slice(0, 120);
  return `CSV preview, first ${lines.length} line(s):\n\n\`\`\`csv\n${lines.join("\n")}\n\`\`\``;
}

function extractPdfLooseText(bytes: Buffer): string {
  const latin = bytes.toString("latin1");
  const strings: string[] = [];
  for (const match of latin.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)) {
    const text = match[1]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n")
      .replace(/\\t/g, " ")
      .replace(/\\([()\\])/g, "$1")
      .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length >= 3 && /[a-zA-Z]/.test(text)) strings.push(text);
    if (strings.length >= 220) break;
  }
  const body = normalizeLines(strings, 220);
  return body.length > 0
    ? `Best-effort PDF text scrape. Verify against the original PDF for layout and missing text.\n\n${body}`
    : "No text could be scraped safely from this PDF. Use the original PDF path for inspection.";
}

function extractionHeader(attachment: ChatAttachment): string {
  return [
    `# Extracted Attachment: ${attachment.originalName}`,
    "",
    `Kind: ${attachment.kind}`,
    `MIME: ${attachment.mimeType}`,
    `Original path: ${attachment.absolutePath}`,
    `Workspace-relative original path: ${attachment.workspacePath}`,
    "",
  ].join("\n");
}

async function extractAttachmentMarkdown(attachment: ChatAttachment, bytes: Buffer): Promise<string> {
  try {
    let body: string;
    if (attachment.kind === "document") {
      body = await extractDocxMarkdown(bytes);
    } else if (attachment.kind === "spreadsheet") {
      body = attachment.mimeType === "text/csv" ? extractCsvMarkdown(bytes) : await extractXlsxMarkdown(bytes);
    } else if (attachment.kind === "presentation") {
      body = await extractPptxMarkdown(bytes);
    } else if (attachment.kind === "pdf") {
      body = extractPdfLooseText(bytes);
    } else {
      body = "No extraction is needed for image attachments.";
    }
    return `${extractionHeader(attachment)}${boundedText(body, 120000)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown extraction error";
    return `${extractionHeader(attachment)}Extraction failed: ${message}\n\nUse the original file path for inspection.`;
  }
}

export async function materializeChatAttachments(items: PendingMaterializedAttachment[]): Promise<void> {
  for (const item of items) {
    await mkdir(path.dirname(item.attachment.absolutePath), { recursive: true });
    await copyFile(item.artifact.storageUri, item.attachment.absolutePath);
    if (item.attachment.extractedAbsolutePath !== null) {
      const bytes = await readFile(item.artifact.storageUri);
      const extracted = await extractAttachmentMarkdown(item.attachment, bytes);
      await writeFile(item.attachment.extractedAbsolutePath, extracted, "utf8");
      item.attachment.extractedSummary = boundedText(extracted.replace(/\s+/g, " ").trim(), 400);
    }
  }
}

export async function attachmentsForWorkSession(workSession: WorkSessionRecord): Promise<ChatAttachment[]> {
  const db = await getDatabaseSnapshot();
  const attachments: ChatAttachment[] = [];
  for (const message of db.chatMessages) {
    if (message.chatSessionId !== workSession.chatSessionId || message.role !== "user") continue;
    for (const attachment of message.attachments ?? []) {
      attachments.push(attachment);
    }
  }
  return attachments;
}

export async function imageAttachmentsForWorkSession(workSession: WorkSessionRecord): Promise<ChatAttachment[]> {
  return (await attachmentsForWorkSession(workSession)).filter((attachment) => attachment.kind === "image");
}

function labelForAttachment(kind: ChatAttachment["kind"]): string {
  switch (kind) {
    case "pdf":
      return "PDF";
    case "document":
      return "Document";
    case "spreadsheet":
      return "Spreadsheet";
    case "presentation":
      return "Presentation";
    case "image":
      return "Image";
  }
}

export async function attachmentPromptBlock(workSession: WorkSessionRecord): Promise<string> {
  const attachments = await attachmentsForWorkSession(workSession);
  if (attachments.length === 0) return "";
  const lines = attachments.map((attachment, index) => [
    `- ${labelForAttachment(attachment.kind)} ${index + 1}: ${attachment.absolutePath}`,
    `  Workspace-relative path: ${attachment.workspacePath}`,
    `  MIME: ${attachment.mimeType}`,
    `  Original file name: ${attachment.originalName}`,
    attachment.extractedAbsolutePath !== null ? `  Extracted Markdown: ${attachment.extractedAbsolutePath}` : "",
  ].filter((line) => line.length > 0).join("\n"));
  return renderUntrustedSource({
    sourceType: "attachment",
    sourceId: workSession.id,
    title: "User attached files",
    content: `Attached files from the user:\n${lines.join("\n")}\nUse extracted Markdown for document/spreadsheet/presentation/PDF content when present. Use original files for fidelity and images as visual input/reference material.`,
    maxChars: 12000,
  });
}

export async function userRequestWithAttachmentBlock(workSession: WorkSessionRecord): Promise<string> {
  const block = await attachmentPromptBlock(workSession);
  return block.length > 0 ? `${workSession.lastUserMessage}\n\n${block}` : workSession.lastUserMessage;
}

export async function codexExecImageArgs(workSession: WorkSessionRecord): Promise<string[]> {
  const attachments = await imageAttachmentsForWorkSession(workSession);
  return attachments.flatMap((attachment) => ["-i", attachment.absolutePath]);
}

export async function codexAppServerInputItems(prompt: string, workSession: WorkSessionRecord): Promise<Array<Record<string, unknown>>> {
  const attachments = await imageAttachmentsForWorkSession(workSession);
  return [
    { type: "text", text: prompt, text_elements: [] },
    ...attachments.map((attachment) => ({ type: "localImage", path: attachment.absolutePath })),
  ];
}
