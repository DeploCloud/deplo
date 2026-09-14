import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth/current-user";
import { requireActiveTeamId } from "@/lib/membership";
import { resolveAttachTarget } from "@/lib/data/console";
import { requireAppCapability } from "@/lib/data/node-access";
import * as attach from "@/lib/attach/session";
import { connectAgent } from "@/lib/infra/agent-client/connect";

// `--sig-proxy` is off in the agent's spawn, so disconnecting never signals the container.

// Long-lived stream; must run at request time on the Node runtime (spawns docker).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Cut a stalled SSE client off rather than let the queue grow the heap unbounded.
const MAX_QUEUED_CHUNKS = 1024;

// Belt-and-braces CSRF check: refuse a request whose `Origin` points at another site.
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
  ctx: RouteContext<"/api/apps/[id]/attach">,
) {
  if (isCrossSite(request))
    return Response.json(
      { error: "Cross-site request refused" },
      { status: 403 },
    );

  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: appId } = await ctx.params;
  const params = request.nextUrl.searchParams;
  const target = params.get("container") ?? undefined;
  // The client seeds the pty size: a hardcoded 80×24 wrapped every TUI wrong.
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

  // Bind the session to the caller + active team; POST/DELETE re-check against these, so the id alone never keeps a demoted caller writing to PID 1.
  const teamId = await requireActiveTeamId();

  // The OWNING server's agent bidi Attach gives a real PTY for tty:true containers, plain pipes otherwise.
  const tty = resolved.instance.tty;
  let session;
  try {
    const conn = await connectAgent(resolved.server!.id);
    const handle = conn.attach(appId, resolved.instance.name, tty, cols, rows);
    session = attach.open(
      appId,
      teamId,
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
        } catch {}
      };
      const send = (event: string, data: string) => {
        // desiredSize is null once the stream errors/closes and goes negative when the client stops reading.
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

      // NOT named "open": EventSource's built-in `open` event carries no data, so a custom listener JSON.parse(undefined)s.
      send("session", session.id);

      // Streaming decoder: a UTF-8 character split across two chunks is otherwise mangled into �.
      const decoder = new StringDecoder("utf8");
      unsubscribe = attach.subscribe(session, (chunk) => {
        try {
          const text = decoder.write(chunk);
          if (text) send("data", text);
        } catch {}
      });

      session.onExit = () => {
        try {
          send("exit", "");
          controller.close();
        } catch {}
      };

      // A signal that aborted DURING the pre-start awaits never fires "abort" again.
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
  if (!sessionId)
    return Response.json({ error: "Missing sessionId" }, { status: 400 });

  const session = attach.get(sessionId, appId);
  if (!session)
    return Response.json({ error: "No such session" }, { status: 404 });

  // Re-check caller + capability on every write, so the session id alone is never enough.
  if (!(await stillAuthorized(appId, session, user.id)))
    return Response.json({ error: "Forbidden" }, { status: 403 });

  const resize = parseResize(body.resize);
  if (resize) {
    session.handle.resize?.(resize.cols, resize.rows);
    return Response.json({ ok: true });
  }

  session.handle.write(data);
  return Response.json({ ok: true });
}

// Re-authorise an in-flight attach session against the CALLER, not just the session id.
async function stillAuthorized(
  appId: string,
  session: attach.AttachSession,
  userId: string,
): Promise<boolean> {
  if (session.userId !== userId) return false;
  try {
    const { teamId } = await requireAppCapability(appId, "open_app_console");
    if (teamId !== session.teamId) return false;
    return true;
  } catch {
    return false;
  }
}

// Clamped so a bad client can't ask for a 10⁶-column pty.
function clampDim(raw: string | null, fallback: number, max: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

function parseResize(raw: unknown): { cols: number; rows: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const { cols, rows } = raw as { cols?: unknown; rows?: unknown };
  const c = Number(cols);
  const r = Number(rows);
  if (!Number.isFinite(c) || !Number.isFinite(r) || c <= 0 || r <= 0)
    return null;
  return {
    cols: Math.min(Math.floor(c), 500),
    rows: Math.min(Math.floor(r), 300),
  };
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
    // Detach is a mutation on a live session: gate it exactly like a write.
    if (!(await stillAuthorized(appId, session, user.id)))
      return Response.json({ error: "Forbidden" }, { status: 403 });
    attach.destroy(sessionId);
  }
  return Response.json({ ok: true });
}
