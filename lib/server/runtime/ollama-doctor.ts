import { createOllamaClient } from "@/lib/server/runtime/ollama-client";
import type { ChatModelDoctorResult } from "@/lib/server/runtime/chat-model-client";

let cached: { expiresAt: number; result: ChatModelDoctorResult } | null = null;
const ttlMs = 30_000;

export async function runOllamaDoctor(): Promise<ChatModelDoctorResult> {
  const now = Date.now();
  if (cached !== null && cached.expiresAt > now) {
    return cached.result;
  }
  const result = await createOllamaClient().doctor();
  cached = { expiresAt: now + ttlMs, result };
  return result;
}
