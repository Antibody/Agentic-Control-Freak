import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getConfig } from "@/lib/server/config";
import { createArtifactRecord, mutateDatabase } from "@/lib/server/db/file-db";
import { redactSecrets } from "@/lib/server/secret-redaction";
import type { ArtifactKind, ArtifactRecord, Identifier, JsonObject } from "@/lib/shared/types";

function safeName(input: string): string {
  const sanitized = input
    .replace(/[^a-z0-9._-]/gi, "_")
    .replace(/\.{2,}/g, "_")
    .slice(0, 180);
  return sanitized.replace(/^[.]+$/, "").length === 0 ? "artifact" : sanitized;
}

export async function saveArtifact(input: {
  workSessionId: Identifier;
  kind: ArtifactKind;
  fileName: string;
  content: string | Buffer;
  metadata?: JsonObject;
}): Promise<ArtifactRecord> {
  const config = getConfig();
  const sessionDir = path.join(config.artifactsDir, input.workSessionId);
  await mkdir(sessionDir, { recursive: true });
  const safeFileName = safeName(input.fileName);
  const absolutePath = path.join(sessionDir, safeFileName);
  if (typeof input.content === "string") {
    await writeFile(absolutePath, redactSecrets(input.content), "utf8");
  } else {
    await writeFile(absolutePath, input.content);
  }

  return mutateDatabase((db) => {
    const artifact = createArtifactRecord({
      workSessionId: input.workSessionId,
      artifactKind: input.kind,
      storageUri: absolutePath,
      metadata: input.metadata ?? {},
    });
    db.artifacts.push(artifact);
    return artifact;
  });
}

export async function saveBinaryArtifact(input: {
  workSessionId: Identifier;
  kind: ArtifactKind;
  fileName: string;
  bytes: Uint8Array;
  metadata?: JsonObject;
}): Promise<ArtifactRecord> {
  return saveArtifact({
    workSessionId: input.workSessionId,
    kind: input.kind,
    fileName: input.fileName,
    content: Buffer.from(input.bytes),
    metadata: input.metadata,
  });
}

export async function readArtifactFile(artifact: ArtifactRecord): Promise<string> {
  return readFile(artifact.storageUri, "utf8");
}

export async function readArtifactBytes(artifact: ArtifactRecord): Promise<Buffer> {
  return readFile(artifact.storageUri);
}
