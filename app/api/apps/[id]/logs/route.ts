import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth";
import { resolveLogsTarget } from "@/lib/data/console";
import * as logs from "@/lib/logs/session";
import { connectAgent } from "@/lib/infra/agent-client";

/**
 * Live runtime logs (`docker logs -f`) for an app's container, over plain HTTP.
 *
 *   GET    ?container=<name>&tail=<n> → SSE stream of the container's live output.
 *                                       The first event is `session` with the id.
 *   DELETE ?sessionId=<id>           → detach (kills our local logs client only).
 *
 * Output-only — there is no POST/stdin direction (logs are read-only). The
 * server-side session (lib/logs/session.ts) owns the `docker logs` child so the
 * idle reaper can reap it if the browser disconnects without a clean DELETE.
 */

// Long-lived stream; must run at request time on the Node runtime (spawns docker).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Queued-chunk ceiling before a stalled SSE client is cut off. The controller's
// default queuing strategy counts chunks, so desiredSize goes one more negative
// per undelivered enqueue; past this backlog we drop the connection instead of
// buffering the log firehose in memory without bound.
const MAX_QUEUED_CHUNKS = 1024;

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/apps/[id]/logs">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: appId } = await ctx.params;
  const target = request.nextUrl.searchParams.get("container") ?? undefined;
  // Default to the last 500 lines. A missing param must fall back, NOT seed 0 —
  // Number(null) is 0 (finite), which would request `--tail 0` (follow-only, no
  // history) and leave the viewer empty on an idle container. Only parse when
  // the param is actually present and numeric.
  const rawTail = request.nextUrl.searchParams.get("tail");
  const parsedTail = rawTail !== null ? Number(rawTail) : NaN;
  const tail = Number.isFinite(parsedTail)
    ? Math.min(Math.max(Math.trunc(parsedTail), 0), 5000)
    : 500;

  const resolved = await resolveLogsTarget(appId, target);
  if (!resolved.ok) {
    const status =
      resolved.reason === "not-found"
        ? 404
        : resolved.reason === "unreachable"
          ? 503
          : 409;
    return Response.json({ error: resolved.reason }, { status });
  }

  // Build the backing handle against the app's OWNING server's agent: it
  // streams the agent's FollowLogs (cleanup closes the gRPC client when the
  // session exits). On a dial failure, fail clearly with 503.
  let session;
  try {
    const conn = await connectAgent(resolved.server!.id);
    const handle = conn.followLogs(appId, resolved.instance.name, tail);
    session = logs.open(appId, resolved.instance.name, handle, () =>
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

      // NOT named "open" — EventSource reserves that event name (see attach route).
      send("session", session.id);

      // Streaming decoder so a multi-byte UTF-8 glyph split across two docker
      // chunks isn't mangled into � — partial bytes buffer until the rest lands.
      const decoder = new StringDecoder("utf8");
      unsubscribe = logs.subscribe(session, (chunk) => {
        try {
          const text = decoder.write(chunk);
          if (text) send("data", text);
        } catch {
          /* controller closed mid-flush; cleanup runs below */
        }
      });

      // A stream that FAILED (agent unreachable, container refused) is not the
      // same as a container that simply stopped talking, and the viewer must not
      // render both as a silent empty pane: send the curated reason first, then
      // close. One of unreachable | not-found | denied | failed.
      //
      // NOT named "error" — like "open", EventSource dispatches its own transport
      // errors under that name, so a server-sent `event: error` would arrive
      // indistinguishable from a dropped connection.
      session.onExit = (error) => {
        try {
          if (error) send("failure", error);
          send("exit", "");
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Browser navigated away / closed the tab: drop our subscription. The
      // session's idle reaper then kills the `docker logs` child. A signal that
      // aborted DURING the pre-start awaits never fires "abort" again — check
      // it explicitly so an already-gone client is cleaned up immediately.
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
  ctx: RouteContext<"/api/apps/[id]/logs">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: appId } = await ctx.params;
  const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";
  const session = sessionId ? logs.get(sessionId, appId) : undefined;
  if (session) logs.destroy(sessionId);
  return Response.json({ ok: true });
}
