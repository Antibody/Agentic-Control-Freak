import { getConfig } from "@/lib/server/config";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";
import { findAuthorizedPrincipal } from "@/lib/server/telegram-control/security";
import { createTelegramCallbackNonce, mutateTelegramControlState, readTelegramControlState } from "@/lib/server/telegram-control/state";
import { formatApproval, formatEventNotification } from "@/lib/server/telegram-control/format";
import type { ArtifactRecord, DomainEventName, EventRecord, Identifier, PublicAppState } from "@/lib/shared/types";
import type { TelegramNotification } from "@/lib/server/telegram-control/types";

const activityEventNames = new Set<DomainEventName>([
  "chat.message.received",
  "intent.classified",
  "plan.created",
  "task.started",
  "task.completed",
  "verification.started",
  "verification.passed",
  "preview.starting",
  "preview.ready",
  "handoff.created",
]);

function eventAllowed(eventName: DomainEventName): boolean {
  const config = getConfig();
  if (config.telegramControlSendPreviewScreenshots && eventName === "snapshot.completed") {
    return true;
  }
  return config.telegramControlNotifyEvents.includes(eventName) || (config.telegramControlActivityEvents && activityEventNames.has(eventName));
}

function isInternalProbePreviewEvent(event: EventRecord): boolean {
  if (!event.eventName.startsWith("preview.")) {
    return false;
  }
  const payload = event.payload as Record<string, unknown> | null | undefined;
  return payload?.mode === "probe";
}

function eventSortKey(event: EventRecord): string {
  return `${event.createdAt}:${event.id}`;
}

function afterCursor(events: EventRecord[], cursorId: Identifier | null): EventRecord[] {
  if (cursorId === null) {
    return events.slice(-1);
  }
  const index = events.findIndex((event) => event.id === cursorId);
  if (index < 0) {
    return events.slice(-20);
  }
  return events.slice(index + 1);
}

function payloadString(event: EventRecord, key: string): string {
  const value = event.payload[key];
  return typeof value === "string" ? value : "";
}

function screenshotArtifactForSnapshot(appState: PublicAppState, event: EventRecord): ArtifactRecord | null {
  const artifactId = payloadString(event, "screenshotArtifactId");
  if (artifactId.length === 0) {
    return null;
  }
  const artifact = appState.artifacts.find((candidate) => candidate.id === artifactId && candidate.workSessionId === event.workSessionId);
  if (artifact === undefined || artifact.artifactKind !== "screenshot") {
    return null;
  }
  const contentType = typeof artifact.metadata.contentType === "string" ? artifact.metadata.contentType : "";
  return contentType === "image/png" ? artifact : null;
}

function screenshotCaption(appState: PublicAppState, event: EventRecord): string {
  const session = event.workSessionId === null ? null : appState.workSessions.find((candidate) => candidate.id === event.workSessionId) ?? null;
  const chat = session === null ? null : appState.chatSessions.find((candidate) => candidate.id === session.chatSessionId) ?? null;
  const project = session === null ? null : appState.projects.find((candidate) => candidate.id === session.projectId) ?? null;
  const label = chat?.title ?? project?.name ?? session?.id ?? "Generated app";
  const previewId = payloadString(event, "previewId");
  return [
    "<b>Final preview screenshot</b>",
    `Session: ${label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`,
    previewId.length > 0 ? `Preview: <code>${previewId.slice(0, 8)}</code>` : "",
  ].filter(Boolean).join("\n");
}

function nonEmptyMessageText(value: string, fallback: string): string {
  return value.trim().length > 0 ? value : fallback;
}

export async function collectTelegramNotifications(): Promise<TelegramNotification[]> {
  const [telegramState, appState] = await Promise.all([readTelegramControlState(), getDatabaseSnapshot()]);
  const notifications: TelegramNotification[] = [];
  const activeBindings = telegramState.chatBindings.filter((binding) =>
    findAuthorizedPrincipal(telegramState, binding.telegramUserId) !== null
  );
  for (const binding of activeBindings) {
    const cursor = telegramState.eventCursors.find((candidate) => candidate.telegramChatId === binding.telegramChatId && candidate.workSessionId === binding.workSessionId) ?? null;
    const events = appState.eventLog
      .filter((event) => event.workSessionId === binding.workSessionId && eventAllowed(event.eventName) && !isInternalProbePreviewEvent(event))
      .sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)));
    for (const event of afterCursor(events, cursor?.lastEventId ?? null).slice(0, 10)) {
      if (event.eventName === "approval.requested" && event.aggregateId !== null) {
        const approval = appState.approvals.find((candidate) => candidate.id === event.aggregateId && candidate.status === "pending");
        if (approval !== undefined) {
          const text = nonEmptyMessageText(formatApproval(appState, approval), "<b>Approval requested</b>");
          const approveNonce = await createTelegramCallbackNonce({ telegramUserId: binding.telegramUserId, telegramChatId: binding.telegramChatId, action: "approve", targetId: approval.id });
          const rejectNonce = await createTelegramCallbackNonce({ telegramUserId: binding.telegramUserId, telegramChatId: binding.telegramChatId, action: "reject", targetId: approval.id });
          notifications.push({
            type: "message",
            chatId: binding.telegramChatId,
            eventId: event.id,
            eventName: event.eventName,
            parseMode: "HTML",
            text,
            buttons: [[
              { text: "Approve", callbackData: `tc:a:${approval.id}:${approveNonce}` },
              { text: "Reject", callbackData: `tc:r:${approval.id}:${rejectNonce}` },
            ]],
          });
          continue;
        }
      }
      if (event.eventName === "snapshot.completed" && getConfig().telegramControlSendPreviewScreenshots) {
        const artifact = screenshotArtifactForSnapshot(appState, event);
        if (artifact !== null) {
          notifications.push({
            type: "photo",
            chatId: binding.telegramChatId,
            eventId: event.id,
            eventName: event.eventName,
            parseMode: "HTML",
            caption: screenshotCaption(appState, event),
            artifactId: artifact.id,
            fileName: `preview-${artifact.id.slice(0, 8)}.png`,
          });
          continue;
        }
      }
      const text = nonEmptyMessageText(formatEventNotification(appState, event), `<b>${event.eventName}</b>`);
      notifications.push({
        type: "message",
        chatId: binding.telegramChatId,
        eventId: event.id,
        eventName: event.eventName,
        parseMode: "HTML",
        text,
      });
    }
  }
  return notifications;
}

export async function acknowledgeTelegramNotifications(input: { chatId: string; eventIds: string[] }): Promise<void> {
  if (input.eventIds.length === 0) {
    return;
  }
  const appState = await getDatabaseSnapshot();
  const latest = appState.eventLog
    .filter((event) => input.eventIds.includes(event.id))
    .sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)))
    .at(-1);
  if (latest === undefined) {
    return;
  }
  await mutateTelegramControlState((state) => {
    const binding = state.chatBindings.find((candidate) => candidate.telegramChatId === input.chatId);
    const workSessionId = latest.workSessionId ?? binding?.workSessionId ?? null;
    const cursor = state.eventCursors.find((candidate) => candidate.telegramChatId === input.chatId && candidate.workSessionId === workSessionId);
    if (cursor === undefined) {
      state.eventCursors.push({ telegramChatId: input.chatId, workSessionId, lastEventId: latest.id, updatedAt: new Date().toISOString() });
    } else {
      cursor.lastEventId = latest.id;
      cursor.updatedAt = new Date().toISOString();
    }
  });
}
