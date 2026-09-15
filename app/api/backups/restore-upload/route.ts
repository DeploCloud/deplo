import { type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { isCrossSite, crossSiteRefused } from "@/lib/http/same-origin";
import { prepareUploadRestore } from "@/lib/data/backups/upload-restore";
import { statusForBackupError } from "@/lib/backups/http-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (isCrossSite(request)) return crossSiteRefused();
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const appId = request.nextUrl.searchParams.get("app");
  const databaseId = request.nextUrl.searchParams.get("database");
  if (Boolean(appId) === Boolean(databaseId)) {
    return Response.json(
      { error: "Name exactly one app or database to restore" },
      { status: 400 },
    );
  }
  if (!request.body) {
    return Response.json({ error: "No file was uploaded" }, { status: 400 });
  }

  let restore: Awaited<ReturnType<typeof prepareUploadRestore>>;
  try {
    restore = await prepareUploadRestore({
      kind: appId ? "app" : "database",
      targetId: (appId ?? databaseId)!,
      recoveryKey: request.headers.get("x-recovery-key") ?? "",
      body: request.body,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json(
      { error: message },
      { status: statusForBackupError(message) },
    );
  }

  const events = restore.events;
  const encoder = new TextEncoder();
  const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) {
          controller.close();
          return;
        }
        const event = next.value;
        controller.enqueue(
          event.result
            ? line({ ok: event.result.ok, error: event.result.error })
            : line({
                level: event.log?.level ?? "info",
                text: event.log?.text ?? "",
              }),
        );
      } catch (e) {
        controller.enqueue(
          line({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          }),
        );
        controller.close();
      }
    },
    cancel() {
      void events.return(undefined);
      // A generator abandoned before its first next() runs no finally, so cleanup needs this too.
      void restore.abandon();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
