import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth/current-user";
import { requireActiveTeamId } from "@/lib/membership";
import { resolveAttachTarget } from "@/lib/data/console";
import { requireAppCapability } from "@/lib/data/node-access";
import * as attach from "@/lib/attach/session";
import { connectAgent } from "@/lib/infra/agent-client/connect";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_QUEUED_CHUNKS = 1024;

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

  // Bind the session to the caller and active team; POST/DELETE re-check both, so the id alone never keeps a demoted caller writing to PID 1.
  const teamId = await requireActiveTeamId();

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
      let unsubscribe: () => void = () => {};
      const closeStream = () => {
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      const send = (event: string, data: string) => {
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

      send("session", session.id);

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
