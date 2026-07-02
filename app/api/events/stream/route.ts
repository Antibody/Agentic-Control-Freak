import { NextRequest } from "next/server";
import { getDatabaseSnapshot } from "@/lib/server/db/file-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function encodeSse(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: NextRequest): Promise<Response> {
  const searchParams = request.nextUrl.searchParams;
  const workSessionId = searchParams.get("workSessionId");
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastEventId: string | null = null;
      let lastCreatedAt = "";
      let open = true;
      request.signal.addEventListener("abort", () => {
        open = false;
      });

      controller.enqueue(encoder.encode(encodeSse("connected", { ok: true })));

      while (open) {
        const db = await getDatabaseSnapshot();
        const events = workSessionId === null
          ? db.eventLog
          : db.eventLog.filter((event) => event.workSessionId === workSessionId);
        let nextEvents = events;
        if (lastEventId !== null) {
          const cursorIndex = events.findIndex((event) => event.id === lastEventId);
          nextEvents = cursorIndex >= 0
            ? events.slice(cursorIndex + 1)
            : events.filter((event) => event.createdAt > lastCreatedAt);
        }
        for (const event of nextEvents) {
          controller.enqueue(encoder.encode(encodeSse("event", event)));
        }
        const newestEvent = nextEvents.at(-1);
        if (newestEvent !== undefined) {
          lastEventId = newestEvent.id;
          lastCreatedAt = newestEvent.createdAt;
        }
        await delay(1000);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
