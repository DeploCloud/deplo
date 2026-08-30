// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { isCrossSite, crossSiteRefused } from "@/lib/http/same-origin";
import { prepareUploadRestore } from "@/lib/data/backups";
import { statusForBackupError } from "@/lib/backups/http-status";

/**
 * Restore an app or a database from an artifact the operator uploads. It is used
 * for this request and nothing else: never stored, never logged, never written to
 * the Activity trail.
 */

// Long-lived streamed response; must run at request time on the Node runtime.
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
    // Everything that can refuse has refused by here - the capability, another restore
    // already running, the file itself, the key.
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
        // The stream already carries a 200, so a failure this late is a last
        // line rather than a status. The data layer settles the app's status and
        // records the failure on its own way out.
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
      // The browser went away mid-restore. Returning into the generator is what
      // runs its cleanup: the agent connection closes, the target comes off
      // "restoring", and the interruption is recorded rather than left hanging.
      void events.return(undefined);
      // .unless nothing ever pulled from it, in which case there is no `finally` to
      // return into - a generator abandoned before its first `next()` runs none of its
      // body.
      void restore.abandon();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Disable proxy buffering (nginx) so the log lines arrive as they happen.
      "X-Accel-Buffering": "no",
    },
  });
}
