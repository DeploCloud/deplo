import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isCrossSite, crossSiteRefused } from "@/lib/http/same-origin";
import { resolveDatabaseLogsTarget } from "@/lib/data/database-console";
import * as logs from "@/lib/logs/session";
import { connectAgent } from "@/lib/infra/agent-client/connect";
import { parseLogWindow } from "@/lib/logs/window";
import { logMaxDays } from "@/lib/data/instance-settings/settings-store";

// Long-lived stream; must run at request time on the Node runtime.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_QUEUED_CHUNKS = 1024;

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/databases/[id]/logs">,
) {
  if (isCrossSite(request)) return crossSiteRefused();
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: databaseId } = await ctx.params;
  const target = request.nextUrl.searchParams.get("container") ?? undefined;
  // Number(null) is 0 (finite), so a missing param must fall back to 500, never `--tail 0` (follow-only, empty viewer).
  const rawTail = request.nextUrl.searchParams.get("tail");
  const parsedTail = rawTail !== null ? Number(rawTail) : NaN;
  const tail = Number.isFinite(parsedTail)
    ? Math.min(Math.max(Math.trunc(parsedTail), 0), 5000)
    : 500;
  const window = parseLogWindow(
    request.nextUrl.searchParams,
    await logMaxDays(),
  );

  const resolved = await resolveDatabaseLogsTarget(databaseId, target);
  if (!resolved.ok) {
    const status =
      resolved.reason === "not-found"
        ? 404
        : resolved.reason === "forbidden"
          ? 403
          : resolved.reason === "unreachable"
            ? 503
            : 409;
    return Response.json({ error: resolved.reason }, { status });
  }

  // Must stream from the database's OWNING server's agent, and a dial failure is a hard 503, never a local fallback.
  let session;
  try {
    const conn = await connectAgent(resolved.serverId);
    const handle = conn.followLogs(
      databaseId,
      resolved.instance.name,
      tail,
      window,
    );
    session = logs.open(
      databaseId,
      user.id,
      resolved.instance.name,
      handle,
      () => conn.close(),
    );
  } catch {
    return Response.json({ error: "unreachable" }, { status: 503 });
  }
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Assigned below once the subscription exists; closeStream needs it earlier.
      let unsubscribe: () => void = () => {};
      const closeStream = () => {
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (event: string, data: string) => {
        // desiredSize is null once the stream errored/closed and negative when the client stalled; cut it off rather than grow the heap.
        const size = controller.desiredSize;
        if (size === null) return;
        if (size < -MAX_QUEUED_CHUNKS) {
          closeStream();
          return;
        }
        // SSE frame: data is JSON so arbitrary log bytes survive newlines.
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // NOT named "open" - EventSource reserves that event name.
      send("session", session.id);

      // A multi-byte UTF-8 glyph split across two docker chunks is mangled without a streaming decoder.
      const decoder = new StringDecoder("utf8");
      unsubscribe = logs.subscribe(session, (chunk) => {
        try {
          const text = decoder.write(chunk);
          if (text) send("data", text);
        } catch {
          /* controller closed mid-flush; cleanup runs below */
        }
      });

      // NOT named "error" (EventSource dispatches transport errors there); the reason must precede exit, or the viewer shows a silent empty pane.
      session.onExit = (error) => {
        try {
          if (error) send("failure", error);
          send("exit", "");
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // A signal that aborted DURING the pre-start awaits never fires "abort" again, so check it explicitly (the idle reaper then kills the backing).
      if (request.signal.aborted) {
        closeStream();
        return;
      }
      request.signal.addEventListener("abort", closeStream);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx) so output streams in real time.
      "X-Accel-Buffering": "no",
    },
  });
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/databases/[id]/logs">,
) {
  if (isCrossSite(request)) return crossSiteRefused();
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: databaseId } = await ctx.params;
  const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";
  const session = sessionId ? logs.get(sessionId, databaseId) : undefined;
  // Only the opener may close it: a session id is otherwise a capability to cut short somebody else's stream, and the silence hides which ids are live.
  if (session && session.userId === user.id) logs.destroy(sessionId);
  return Response.json({ ok: true });
}
