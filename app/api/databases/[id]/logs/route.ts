import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth";
import { resolveDatabaseLogsTarget } from "@/lib/data/database-console";
import * as logs from "@/lib/logs/session";
import { connectAgent } from "@/lib/infra/agent-client";

/**
 * Live runtime logs (`docker logs -f`) for a DATABASE container, over plain
 * HTTP — the database sibling of `/api/apps/[id]/logs` (same SSE framing, same
 * session plumbing; only the authorization/resolution seam differs).
 *
 *   GET    ?container=<name>&tail=<n> → SSE stream of the container's live output.
 *                                       The first event is `session` with the id.
 *   DELETE ?sessionId=<id>           → detach (kills our local logs client only).
 *
 * Output-only — logs are read-only. The server-side session
 * (lib/logs/session.ts) is scope-keyed by the database id here, exactly as the
 * app route keys it by app id (the key is opaque to the session layer).
 */

// Long-lived stream; must run at request time on the Node runtime.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Queued-chunk ceiling before a stalled SSE client is cut off. The controller's
// default queuing strategy counts chunks, so desiredSize goes one more negative
// per undelivered enqueue; past this backlog we drop the connection instead of
// buffering the log firehose in memory without bound.
const MAX_QUEUED_CHUNKS = 1024;

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/databases/[id]/logs">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: databaseId } = await ctx.params;
  const target = request.nextUrl.searchParams.get("container") ?? undefined;
  // Default to the last 500 lines; only parse the param when present and
  // numeric (Number(null) is 0, which would mean follow-only, no history).
  const rawTail = request.nextUrl.searchParams.get("tail");
  const parsedTail = rawTail !== null ? Number(rawTail) : NaN;
  const tail = Number.isFinite(parsedTail)
    ? Math.min(Math.max(Math.trunc(parsedTail), 0), 5000)
    : 500;

  const resolved = await resolveDatabaseLogsTarget(databaseId, target);
  if (!resolved.ok) {
    const status =
      resolved.reason === "not-found"
        ? 404
        : resolved.reason === "unreachable"
          ? 503
          : 409;
    return Response.json({ error: resolved.reason }, { status });
  }

  // Stream from the OWNING server's agent; a dial failure fails clearly.
  let session;
  try {
    const conn = await connectAgent(resolved.serverId);
    const handle = conn.followLogs(databaseId, resolved.instance.name, tail);
    session = logs.open(databaseId, resolved.instance.name, handle, () =>
      conn.close(),
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
        // Back-pressure: desiredSize is null once the stream errors/closes and
        // goes negative when the client stops reading. Skip writes on a dead
        // stream; cut off a stalled client rather than grow the heap unbounded.
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

      // NOT named "open" — EventSource reserves that event name.
      send("session", session.id);

      // Streaming decoder so a multi-byte UTF-8 glyph split across two docker
      // chunks isn't mangled into �.
      const decoder = new StringDecoder("utf8");
      unsubscribe = logs.subscribe(session, (chunk) => {
        try {
          const text = decoder.write(chunk);
          if (text) send("data", text);
        } catch {
          /* controller closed mid-flush; cleanup runs below */
        }
      });

      // Curated failure reason first, then close — never a silent empty pane.
      // NOT named "error" (EventSource dispatches transport errors there).
      session.onExit = (error) => {
        try {
          if (error) send("failure", error);
          send("exit", "");
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // A signal that aborted DURING the pre-start awaits never fires "abort"
      // again — check it explicitly so an already-gone client is cleaned up
      // immediately (the idle reaper then kills the backing).
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
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: databaseId } = await ctx.params;
  const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";
  const session = sessionId ? logs.get(sessionId, databaseId) : undefined;
  if (session) logs.destroy(sessionId);
  return Response.json({ ok: true });
}
