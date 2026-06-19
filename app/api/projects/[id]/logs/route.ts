import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth";
import { resolveLogsTarget } from "@/lib/data/console";
import * as logs from "@/lib/logs/session";

/**
 * Live runtime logs (`docker logs -f`) for a project's container, over plain HTTP.
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

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/logs">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId } = await ctx.params;
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

  const resolved = await resolveLogsTarget(projectId, target);
  if (!resolved.ok) {
    const status = resolved.reason === "not-found" ? 404 : 409;
    return Response.json({ error: resolved.reason }, { status });
  }

  const session = logs.open(projectId, resolved.instance.name, tail);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: string) => {
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
      const unsubscribe = logs.subscribe(session, (chunk) => {
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
      // session's idle reaper then kills the `docker logs` child.
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

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/projects/[id]/logs">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: projectId } = await ctx.params;
  const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";
  const session = sessionId ? logs.get(sessionId, projectId) : undefined;
  if (session) logs.destroy(sessionId);
  return Response.json({ ok: true });
}
