import { type NextRequest } from "next/server";
import { StringDecoder } from "node:string_decoder";
import { getCurrentUser } from "@/lib/auth/current-user";
import { resolveLogsTarget } from "@/lib/data/console";
import * as logs from "@/lib/logs/session";
import { connectAgent } from "@/lib/infra/agent-client/connect";
import { parseLogWindow } from "@/lib/logs/window";
import { logMaxDays } from "@/lib/data/instance-settings/settings-store";

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
  const rawTail = request.nextUrl.searchParams.get("tail");
  const parsedTail = rawTail !== null ? Number(rawTail) : NaN;
  const tail = Number.isFinite(parsedTail)
    ? Math.min(Math.max(Math.trunc(parsedTail), 0), 5000)
    : 500;
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
      unsubscribe = logs.subscribe(session, (chunk) => {
        try {
          const text = decoder.write(chunk);
          if (text) send("data", text);
        } catch {}
      });

      session.onExit = (error) => {
        try {
          if (error) send("failure", error);
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

export async function DELETE(
  request: NextRequest,
  ctx: RouteContext<"/api/apps/[id]/logs">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id: appId } = await ctx.params;
  const sessionId = request.nextUrl.searchParams.get("sessionId") ?? "";
  const session = sessionId ? logs.get(sessionId, appId) : undefined;
  if (session && session.userId === user.id) logs.destroy(sessionId);
  return Response.json({ ok: true });
}
