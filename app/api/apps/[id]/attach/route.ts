import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth";
import { requireActiveTeamId, requireCapability } from "@/lib/membership";
import { resolveAttachTarget } from "@/lib/data/console";
import { requireFolderCapabilityForApp } from "@/lib/data/folder-access";
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

// Queued-chunk ceiling before a stalled SSE client is cut off. The controller's
// default queuing strategy counts chunks, so desiredSize goes one more negative
// per undelivered enqueue; past this backlog we drop the connection instead of
// buffering the container's output in memory without bound.
const MAX_QUEUED_CHUNKS = 1024;

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

  // Bind the session to the principal + active team that opened it (resolveAttachTarget
  // just proved both hold `deploy` on this app). POST/DELETE re-check against these so
  // the id alone can never keep a swapped-out or demoted caller writing to PID 1.
  const teamId = await requireActiveTeamId();

  // Build the backing against the OWNING server's agent: the agent's bidi Attach
  // gives a real PTY for tty:true containers and plain pipes otherwise (cleanup
  // closes the gRPC client). A dial failure fails clearly.
  const tty = resolved.instance.tty;
  let session;
  try {
    const conn = await connectAgent(resolved.server!.id);
    const handle = conn.attach(appId, resolved.instance.name, tty, cols, rows);
    session = attach.open(appId, teamId, user.id, resolved.instance.name, handle, () =>
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

      // Browser navigated away / closed the tab: drop our subscription. The
      // session's idle reaper then kills the docker attach child. A signal that
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

  // The GET authorised this session for one principal holding `deploy`. Re-check
  // both on every write — same user, still holding the capability — so a demoted
  // member (or anyone else who got hold of the id) can't keep typing into PID 1.
  if (!(await stillAuthorized(appId, session, user.id)))
    return Response.json({ error: "Forbidden" }, { status: 403 });

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

/**
 * Re-authorise an in-flight attach session against the CALLER, not just the
 * session id. A session is bound to the user + active team that opened it (with
 * `deploy`); this re-runs that exact gate — same principal, still a member of the
 * owning team, still holding `deploy` on the app AND its folder — so a demoted or
 * swapped-out member can't keep driving PID 1 for the session's remaining TTL.
 * DB-only checks (no per-keystroke agent round trip); any throw ⇒ not authorised.
 */
async function stillAuthorized(
  appId: string,
  session: attach.AttachSession,
  userId: string,
): Promise<boolean> {
  if (session.userId !== userId) return false;
  try {
    const { teamId } = await requireCapability("deploy");
    if (teamId !== session.teamId) return false;
    await requireFolderCapabilityForApp(appId, "deploy");
    return true;
  } catch {
    return false;
  }
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
  if (session) {
    // Detach is a mutation on someone's live session: gate it exactly like a
    // write, so a demoted/foreign caller can't tear down a session on id alone.
    if (!(await stillAuthorized(appId, session, user.id)))
      return Response.json({ error: "Forbidden" }, { status: 403 });
    attach.destroy(sessionId);
  }
  return Response.json({ ok: true });
}
