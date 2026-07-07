import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth";
import { resolveAttachTarget } from "@/lib/data/console";
import * as attach from "@/lib/attach/session";
import { connectAgent } from "@/lib/infra/agent-client";

/**
 * Interactive `docker attach` to a service's running container, over plain HTTP.
 *
 *   GET    ?container=<name>   → SSE stream of the container's live PID 1 output.
 *                                The first event is `session` with the session id.
 *   POST   { sessionId, data } → forward a keystroke chunk to the container stdin.
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
  ctx: RouteContext<"/api/services/[id]/attach">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: serviceId } = await ctx.params;
  const target = request.nextUrl.searchParams.get("container") ?? undefined;

  const resolved = await resolveAttachTarget(serviceId, target);
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
    const handle = conn.attach(serviceId, resolved.instance.name, tty, 80, 24);
    session = attach.open(serviceId, resolved.instance.name, handle, () =>
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
  ctx: RouteContext<"/api/services/[id]/attach">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: serviceId } = await ctx.params;
  let body: { sessionId?: unknown; data?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const data = typeof body.data === "string" ? body.data : "";
  if (!sessionId) return Response.json({ error: "Missing sessionId" }, { status: 400 });

  const session = attach.get(sessionId, serviceId);
  if (!session) return Response.json({ error: "No such session" }, { status: 404 });

  session.handle.write(data);
  return Response.json({ ok: true });
}

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/services/[id]/attach">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: serviceId } = await ctx.params;
  const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";
  const session = sessionId ? attach.get(sessionId, serviceId) : undefined;
  if (session) attach.destroy(sessionId);
  return Response.json({ ok: true });
}
