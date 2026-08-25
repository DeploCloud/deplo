import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth";
import { resolveLogsTarget } from "@/lib/data/console";
import * as logs from "@/lib/logs/session";
import { connectAgent } from "@/lib/infra/agent-client";
import { parseLogWindow } from "@/lib/logs/window";
import { logMaxDays } from "@/lib/data/instance-settings";

/**
 * Live runtime logs (`docker logs -f`) for an app's container, over plain HTTP.
 * The first event is `session` with the id.
 */

// Long-lived stream; must run at request time on the Node runtime (spawns docker).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Queued-chunk ceiling before a stalled SSE client is cut off.
const MAX_QUEUED_CHUNKS = 1024;

/**
 * Belt-and-braces CSRF check: refuse a request whose `Origin` points at another
 * site.
 */
function isCrossSite(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    "";
  return originHost !== host;
}

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/apps/[id]/logs">,
) {
  if (isCrossSite(request))
    return Response.json(
      { error: "Cross-site request refused" },
      { status: 403 },
    );

  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: appId } = await ctx.params;
  const target = request.nextUrl.searchParams.get("container") ?? undefined;
  // Default to the last 500 lines. A missing param must fall back, NOT seed 0 —
  // Number(null) is 0 (finite), which would request `--tail 0` (follow-only, no
  // history) and leave the viewer empty on an idle container.
  const rawTail = request.nextUrl.searchParams.get("tail");
  const parsedTail = rawTail !== null ? Number(rawTail) : NaN;
  const tail = Number.isFinite(parsedTail)
    ? Math.min(Math.max(Math.trunc(parsedTail), 0), 5000)
    : 500;
  // How far back to reach and whether to prefix each line with its write time.
  const window = parseLogWindow(
    request.nextUrl.searchParams,
    await logMaxDays(),
  );

  const resolved = await resolveLogsTarget(appId, target);
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

  // Build the backing handle against the app's OWNING server's agent: it
  // streams the agent's FollowLogs (cleanup closes the gRPC client when the
  // session exits). On a dial failure, fail clearly with 503.
  let session;
  try {
    const conn = await connectAgent(resolved.server!.id);
    const handle = conn.followLogs(appId, resolved.instance.name, tail, window);
    session = logs.open(appId, user.id, resolved.instance.name, handle, () =>
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

      // A stream that FAILED (agent unreachable, container refused) is not the same as a
      // container that simply stopped talking, and the viewer must not render both as a
      // silent empty pane: send the curated reason first, then close.
      session.onExit = (error) => {
        try {
          if (error) send("failure", error);
          send("exit", "");
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Browser navigated away / closed the tab: drop our subscription. A signal that
      // aborted DURING the pre-start awaits never fires "abort" again — check it
      // explicitly so an already-gone client is cleaned up immediately.
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
  // Only the principal that opened it may close it: a session id is otherwise a
  // capability anyone can use to cut short somebody else's live log stream.
  // Silent either way — a stranger learns nothing about which ids are live.
  if (session && session.userId === user.id) logs.destroy(sessionId);
  return Response.json({ ok: true });
}
