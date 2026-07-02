import { createUserMemoryRecord, currentTimestamp, getDatabaseSnapshot, mutateDatabase } from "@/lib/server/db/file-db";
import { emitEvent } from "@/lib/server/events";
import type { Identifier, UserMemoryRecord, UserMemoryStatus } from "@/lib/shared/types";

const maxPromptUserMemories = 12;

function normalizeMemoryText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function memoryKey(input: string): string {
  return normalizeMemoryText(input).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function emitUserMemoryChanged(action: string): Promise<void> {
  await emitEvent({
    workSessionId: null,
    eventName: "user.memory.changed",
    aggregateType: "user_memory",
    aggregateId: null,
    payload: { action },
    producer: { module: "user-memory" },
    context: {},
  });
}

export async function listUserMemories(): Promise<UserMemoryRecord[]> {
  const db = await getDatabaseSnapshot();
  return db.userMemories
    .slice()
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export async function renderUserMemoryPromptBlock(): Promise<string> {
  const memories = (await listUserMemories())
    .filter((memory) => memory.status === "active")
    .slice(0, maxPromptUserMemories);
  if (memories.length === 0) return "";
  const now = currentTimestamp();
  const ids = new Set(memories.map((memory) => memory.id));
  await mutateDatabase((db) => {
    for (const memory of db.userMemories) {
      if (ids.has(memory.id)) memory.lastInjectedAt = now;
    }
  });
  return [
    "Trusted user memory:",
    "These are app-wide operator preferences and durable personal context. Apply them across projects unless the current user request explicitly supersedes them.",
    ...memories.map((memory) => `- ${memory.content}`),
  ].join("\n");
}

export async function createUserMemory(input: { content: string; status?: UserMemoryStatus; pinned?: boolean }): Promise<UserMemoryRecord> {
  const content = normalizeMemoryText(input.content);
  if (content.length < 3) throw new Error("User memory content is required.");
  const record = await mutateDatabase((db) => {
    const existing = new Set(db.userMemories.map((memory) => memoryKey(memory.content)));
    if (existing.has(memoryKey(content))) throw new Error("A matching user memory already exists.");
    const memory = createUserMemoryRecord({
      content,
      status: input.status ?? "active",
      pinned: input.pinned ?? false,
    });
    db.userMemories.push(memory);
    return memory;
  });
  await emitUserMemoryChanged("created");
  return record;
}

export async function updateUserMemory(input: {
  memoryId: Identifier;
  content?: string;
  status?: UserMemoryStatus;
  pinned?: boolean;
}): Promise<UserMemoryRecord> {
  const updated = await mutateDatabase((db) => {
    const memory = db.userMemories.find((candidate) => candidate.id === input.memoryId);
    if (memory === undefined) throw new Error("User memory was not found.");
    if (input.content !== undefined) memory.content = normalizeMemoryText(input.content);
    if (input.status !== undefined) memory.status = input.status;
    if (input.pinned !== undefined) memory.pinned = input.pinned;
    memory.updatedAt = currentTimestamp();
    return { ...memory };
  });
  await emitUserMemoryChanged("updated");
  return updated;
}

export async function deleteUserMemory(memoryId: Identifier): Promise<void> {
  await mutateDatabase((db) => {
    db.userMemories = db.userMemories.filter((memory) => memory.id !== memoryId);
  });
  await emitUserMemoryChanged("deleted");
}
