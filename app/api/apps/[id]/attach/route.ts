import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth";
import { resolveAttachTarget } from "@/lib/data/console";
import * as attach from "@/lib/attach/session";
import { connectAgent } from "@/lib/infra/agent-client";

/**
 * Interactive `docker attach` to an app's running container, over plain HTTP.
 *
 *   GET    ?container=<name>[&cols=&rows=]
 *                                → SSE stream of the container's live PID 1 output.
 *                                The first event is `session` with the session id.
 *                                cols/rows seed the pty size (tty containers).
 *   POST   { sessionId, data }            → forward a keystroke chunk to stdin.
 *   POST   { sessionId, resize:{cols,rows} } → resize the pty (tty containers).
 *   DELETE ?sessionId=<id>     → detach (kills our local attach client only).
 *
 * Output and input are separate requests against one server-side session (see
 * lib/attach/session.ts): full-duplex without a WebSocket layer. `--sig-proxy`
 * is off in the spawn, so disconnecting never signals the container.
 */

// Long-lived stream; must run at request time on the Node runtime (spawns docker).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/apps/[id]/attach">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: appId } = await ctx.params;
  const params = request.nextUrl.searchParams;
  const target = params.get("container") ?? undefined;
  // The client's terminal knows its own size before it opens the stream, so it
  // seeds the pty here — no more hardcoded 80×24 that wraps every TUI wrong.
  const cols = clampDim(params.get("cols"), 80, 500);
  const rows = clampDim(params.get("rows"), 24, 300);

  const resolved = await resolveAttachTarget(appId, target);
  if (!resolved.ok) {
    const status =
      resolved.reason === "not-found"
        ? 404
        : resolved.reason === "unreachable"
          ? 503
          : 409;
    return Response.json({ error: resolved.reason }, { status });
  }

  // Build the backing against the OWNING server's agent: the agent's bidi Attach
  // gives a real PTY for tty:true containers and plain pipes otherwise (cleanup
  // closes the gRPC client). A dial failure fails clearly.
  const tty = resolved.instance.tty;
  let session;
  try {
    const conn = await connectAgent(resolved.server!.id);
    const handle = conn.attach(appId, resolved.instance.name, tty, cols, rows);
    session = attach.open(appId, resolved.instance.name, handle, () =>
      conn.close(),
    );
  } catch {
    return Response.json({ error: "unreachable" }, { status: 503 });
  }
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: string) => {
        // SSE frame: data is JSON so arbitrary container bytes survive newlines.
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // NOT named "open": EventSource has a reserved built-in `open` event
      // (connection established, data undefined) that a custom `open` listener
      // would also catch — JSON.parse(undefined) then throws on the client.
      send("session", session.id);

      // A streaming decoder so a UTF-8 character split across two docker chunks
      // (or the garage logs' multi-byte glyphs) isn't mangled into � — partial
      // bytes are buffered until the rest arrives.
      const decoder = new StringDecoder("utf8");
      const unsubscribe = attach.subscribe(session, (chunk) => {
        try {
          const text = decoder.write(chunk);
          if (text) send("data", text);
        } catch {
          /* controller closed mid-flush; cleanup runs below */
        }
      });

      session.onExit = () => {
        try {
          send("exit", "");
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Browser navigated away / closed the tab: drop our subscription. The
      // session's idle reaper then kills the docker attach child.
      const onAbort = () => {
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", onAbort);
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

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/apps/[id]/attach">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: appId } = await ctx.params;
  let body: { sessionId?: unknown; data?: unknown; resize?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const data = typeof body.data === "string" ? body.data : "";
  if (!sessionId) return Response.json({ error: "Missing sessionId" }, { status: 400 });

  const session = attach.get(sessionId, appId);
  if (!session) return Response.json({ error: "No such session" }, { status: 404 });

  // A resize frame carries no stdin bytes: apply it to the pty and return. The
  // terminal posts one on every fit (mount + container resize).
  const resize = parseResize(body.resize);
  if (resize) {
    session.handle.resize?.(resize.cols, resize.rows);
    return Response.json({ ok: true });
  }

  session.handle.write(data);
  return Response.json({ ok: true });
}

/** A query-string dimension → a sane pty size, clamped so a bad client can't ask
 *  for a 10⁶-column pty. Empty/invalid falls back to `fallback`. */
function clampDim(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

/** Validate a POSTed `{cols,rows}` resize payload into clamped integers, or null. */
function parseResize(raw: unknown): { cols: number; rows: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const { cols, rows } = raw as { cols?: unknown; rows?: unknown };
  const c = Number(cols);
  const r = Number(rows);
  if (!Number.isFinite(c) || !Number.isFinite(r) || c <= 0 || r <= 0) return null;
  return { cols: Math.min(Math.floor(c), 500), rows: Math.min(Math.floor(r), 300) };
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/apps/[id]/attach">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: appId } = await ctx.params;
  const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";
  const session = sessionId ? attach.get(sessionId, appId) : undefined;
  if (session) attach.destroy(sessionId);
  return Response.json({ ok: true });
}
