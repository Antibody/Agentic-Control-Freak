import { createEvent, mutateDatabase } from "@/lib/server/db/file-db";
import { eventText } from "@/lib/server/text-bounds";
import { redactSecrets } from "@/lib/server/secret-redaction";
import type { DomainEventName, EventContext, EventPriority, EventProducer, Identifier, JsonObject } from "@/lib/shared/types";

export type DomainEventPayload =
  | { eventName: "verification.failed"; payload: { summary: string; commands: string; [key: string]: unknown } }
  | { eventName: "verification.passed"; payload: { summary: string; commands: string; [key: string]: unknown } }
  | { eventName: "session.blocked"; payload: { reason: string; [key: string]: unknown } }
  | { eventName: "handoff.created"; payload: { reason: string; [key: string]: unknown } }
  | { eventName: "code.change.detected"; payload: { filePath: string; changeKind: string; [key: string]: unknown } }
  | { eventName: DomainEventName; payload: JsonObject };

let lowPriorityWebhookBatch: string[] = [];
let lowPriorityWebhookTimer: ReturnType<typeof setTimeout> | null = null;

export interface EmitEventInput {
  workSessionId: Identifier | null;
  eventName: DomainEventName;
  aggregateType: string;
  aggregateId: Identifier | null;
  payload: JsonObject;
  priority?: EventPriority;
  producer?: EventProducer;
  context?: EventContext;
}

function priorityForEvent(eventName: DomainEventName): EventPriority {
  if (eventName === "session.failed" || eventName === "session.blocked" || eventName === "handoff.created") {
    return "critical";
  }
  if (eventName.endsWith(".failed") || eventName === "approval.requested") {
    return "high";
  }
  if (
    eventName === "task.progress" ||
    eventName.startsWith("chat.message.stream.") ||
    eventName === "agent.process.output.delta" ||
    eventName === "verification.command.output.delta" ||
    eventName === "experiment.metric" ||
    eventName === "experiment.phase"
  ) {
    return "low";
  }
  return "normal";
}

function postWebhook(webhookUrl: string, body: string): void {
  fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => undefined);
}

function enqueueWebhookDelivery(webhookUrl: string, priority: EventPriority, body: string): void {
  if (priority !== "low") {
    postWebhook(webhookUrl, body);
    return;
  }

  lowPriorityWebhookBatch.push(body);
  if (lowPriorityWebhookTimer !== null) {
    return;
  }
  lowPriorityWebhookTimer = setTimeout(() => {
    const events = lowPriorityWebhookBatch.map((entry) => JSON.parse(entry) as JsonObject);
    lowPriorityWebhookBatch = [];
    lowPriorityWebhookTimer = null;
    postWebhook(webhookUrl, JSON.stringify({ batched: true, events }));
  }, 2000);
}

function sanitizePayload(value: unknown, depth = 0): JsonObject[string] {
  if (depth > 8) {
    return "[truncated: maximum payload depth exceeded]";
  }
  if (typeof value === "string") {
    return eventText(redactSecrets(value));
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitizePayload(entry, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value).slice(0, 80)) {
      result[key] = sanitizePayload(entry, depth + 1);
    }
    return result;
  }
  return String(value);
}


const coalescableStreamEvents = new Set<string>([
  "agent.process.output.delta",
  "verification.command.output.delta",
]);
const streamDeltaFlushMs = 1500;
const streamDeltaFlushChars = 3500;

interface StreamDeltaBuffer {
  template: EmitEventInput;
  texts: string[];
  chars: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const streamDeltaBuffers = new Map<string, StreamDeltaBuffer>();
let persistChain: Promise<void> = Promise.resolve();

function enqueuePersist(work: () => Promise<void>): Promise<void> {
  const next = persistChain.then(work, work);
  persistChain = next.catch(() => undefined);
  return next;
}

function streamDeltaKey(input: EmitEventInput, stream: string): string {
  const command = typeof input.payload.command === "string" ? input.payload.command : "";
  return [input.workSessionId ?? "global", input.eventName, input.aggregateType, input.aggregateId ?? "", command, stream].join("|");
}

function flushStreamDeltaBuffer(key: string): Promise<void> {
  const buffer = streamDeltaBuffers.get(key);
  if (buffer === undefined) {
    return Promise.resolve();
  }
  streamDeltaBuffers.delete(key);
  if (buffer.timer !== null) {
    clearTimeout(buffer.timer);
  }
  const mergedText = buffer.texts.join("");
  if (mergedText.length === 0) {
    return Promise.resolve();
  }
  const stream = typeof buffer.template.payload.stream === "string" ? buffer.template.payload.stream : "stdout";
  const merged: EmitEventInput = {
    ...buffer.template,
    payload: {
      ...buffer.template.payload,
      text: mergedText,
      message: `${stream}: ${mergedText}`,
    },
  };
  return enqueuePersist(() => persistEvent(merged));
}

function flushAllStreamDeltaBuffers(): Promise<void> {
  const keys = [...streamDeltaBuffers.keys()];
  return Promise.all(keys.map((key) => flushStreamDeltaBuffer(key))).then(() => undefined);
}

function bufferStreamDelta(input: EmitEventInput, text: string): void {
  const stream = typeof input.payload.stream === "string" ? input.payload.stream : "stdout";
  const key = streamDeltaKey(input, stream);
  let buffer = streamDeltaBuffers.get(key);
  if (buffer === undefined) {
    buffer = { template: input, texts: [], chars: 0, timer: null };
    streamDeltaBuffers.set(key, buffer);
  }
  buffer.texts.push(text);
  buffer.chars += text.length;
  if (buffer.chars >= streamDeltaFlushChars) {
    void flushStreamDeltaBuffer(key);
    return;
  }
  if (buffer.timer === null) {
    buffer.timer = setTimeout(() => {
      void flushStreamDeltaBuffer(key);
    }, streamDeltaFlushMs);
  }
}

export async function emitEvent(input: EmitEventInput): Promise<void> {
  const text = typeof input.payload.text === "string" ? input.payload.text : null;
  if (coalescableStreamEvents.has(input.eventName) && text !== null) {
    bufferStreamDelta(input, text);
    return;
  }
  await flushAllStreamDeltaBuffers();
  await enqueuePersist(() => persistEvent(input));
}

/**
 * Emit several events as ONE persisted batch (a single file-lock acquisition + one DB write). Use this for
 * high-frequency producers such as a metrics poll that flushes many experiment.metric lines at once: emitting
 * them one-by-one rewrites the whole DB per event and saturates the global file lock on long runs, starving
 * other readers/writers (e.g. the /api/app-state poll) until they time out. Bypasses stream-delta coalescing,
 * so pass only non-coalescable events (metric/phase markers), which is what batch callers produce.
 */
export async function emitEvents(inputs: EmitEventInput[]): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  await flushAllStreamDeltaBuffers();
  await enqueuePersist(() => persistEvents(inputs));
}

async function persistEvent(input: EmitEventInput): Promise<void> {
  await persistEvents([input]);
}

async function persistEvents(inputs: EmitEventInput[]): Promise<void> {
  if (inputs.length === 0) {
    return;
  }
  const webhookUrl = process.env.EVENT_WEBHOOK_URL?.trim();
  const webhookEnabled = webhookUrl !== undefined && webhookUrl.length > 0;
  const deliveries: Array<{ priority: EventPriority; body: string }> = [];
  await mutateDatabase((db) => {
    for (const input of inputs) {
      const payload = sanitizePayload(input.payload) as JsonObject;
      const workSession = input.workSessionId === null
        ? undefined
        : db.workSessions.find((candidate) => candidate.id === input.workSessionId);
      const project = workSession === undefined
        ? undefined
        : db.projects.find((candidate) => candidate.id === workSession.projectId);
      const priority = input.priority ?? priorityForEvent(input.eventName);
      const event = createEvent({
        workSessionId: input.workSessionId,
        projectId: workSession?.projectId ?? null,
        chatSessionId: workSession?.chatSessionId ?? null,
        eventName: input.eventName,
        priority,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        producer: input.producer ?? { module: "workflow-controller" },
        context: {
          repoName: project?.slug,
          branch: workSession?.activeBranch,
          worktreePath: workSession?.activeWorktreePath,
          planId: workSession?.activePlanId ?? undefined,
          ...input.context,
        },
        payload,
      });
      db.eventLog.push(event);
      if (webhookEnabled) {
        deliveries.push({
          priority,
          body: JSON.stringify({
            id: event.id,
            eventName: input.eventName,
            priority,
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            workSessionId: input.workSessionId,
            payload,
          }),
        });
      }
    }
  });

  if (webhookEnabled && webhookUrl !== undefined) {
    for (const delivery of deliveries) {
      enqueueWebhookDelivery(webhookUrl, delivery.priority, delivery.body);
    }
  }
}
