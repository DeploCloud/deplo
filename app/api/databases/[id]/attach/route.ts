import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth";
import { resolveDatabaseAttachTarget } from "@/lib/data/database-console";
import * as attach from "@/lib/attach/session";
import { connectAgent } from "@/lib/infra/agent-client";

/**
 * Interactive `docker attach` to a DATABASE's running container, over plain
 * HTTP — the database sibling of `/api/apps/[id]/attach` (same SSE framing,
 * same session plumbing). The resolve seam gates on `manage_infra`: stdin into
 * the live engine is an infra-class operation.
 *
 *   GET    ?container=<name>[&cols=&rows=]
 *                                → SSE stream of the container's live PID 1 output.
 *   POST   { sessionId, data }            → forward a keystroke chunk to stdin.
 *   POST   { sessionId, resize:{cols,rows} } → resize the pty (tty containers).
 *   DELETE ?sessionId=<id>     → detach (kills our local attach client only).
 */

// Long-lived stream; must run at request time on the Node runtime.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Queued-chunk ceiling before a stalled SSE client is cut off. The controller's
// default queuing strategy counts chunks, so desiredSize goes one more negative
// per undelivered enqueue; past this backlog we drop the connection instead of
// buffering the container's output in memory without bound.
const MAX_QUEUED_CHUNKS = 1024;

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/databases/[id]/attach">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: databaseId } = await ctx.params;
  const params = request.nextUrl.searchParams;
  const target = params.get("container") ?? undefined;
  const cols = clampDim(params.get("cols"), 80, 500);
  const rows = clampDim(params.get("rows"), 24, 300);

  const resolved = await resolveDatabaseAttachTarget(databaseId, target);
  if (!resolved.ok) {
    const status =
      resolved.reason === "not-found"
        ? 404
        : resolved.reason === "unreachable"
          ? 503
          : 409;
    return Response.json({ error: resolved.reason }, { status });
  }

  const tty = resolved.instance.tty;
  let session;
  try {
    const conn = await connectAgent(resolved.serverId);
    const handle = conn.attach(databaseId, resolved.instance.name, tty, cols, rows);
    session = attach.open(databaseId, resolved.instance.name, handle, () =>
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
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      // NOT named "open": EventSource reserves that event name.
      send("session", session.id);

      const decoder = new StringDecoder("utf8");
      unsubscribe = attach.subscribe(session, (chunk) => {
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
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/databases/[id]/attach">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: databaseId } = await ctx.params;
  let body: { sessionId?: unknown; data?: unknown; resize?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const data = typeof body.data === "string" ? body.data : "";
  if (!sessionId)
    return Response.json({ error: "Missing sessionId" }, { status: 400 });

  const session = attach.get(sessionId, databaseId);
  if (!session)
    return Response.json({ error: "No such session" }, { status: 404 });

  const resize = parseResize(body.resize);
  if (resize) {
    session.handle.resize?.(resize.cols, resize.rows);
    return Response.json({ ok: true });
  }

  session.handle.write(data);
  return Response.json({ ok: true });
}

/** A query-string dimension → a sane pty size (a bad client can't ask for a
 *  10⁶-column pty). Empty/invalid falls back to `fallback`. */
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
  ctx: RouteContext<"/api/databases/[id]/attach">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: databaseId } = await ctx.params;
  const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";
  const session = sessionId ? attach.get(sessionId, databaseId) : undefined;
  if (session) attach.destroy(sessionId);
  return Response.json({ ok: true });
}
