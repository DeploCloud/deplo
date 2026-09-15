import { type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/current-user";
import { isCrossSite, crossSiteRefused } from "@/lib/http/same-origin";
import { downloadBackupArtifact } from "@/lib/data/backups/download";
import { statusForBackupError } from "@/lib/backups/http-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/backups/[runId]/download">,
) {
  if (isCrossSite(request)) return crossSiteRefused();
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await ctx.params;

  let artifact: Awaited<ReturnType<typeof downloadBackupArtifact>>;
  try {
    artifact = await downloadBackupArtifact(runId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json(
      { error: message },
      { status: statusForBackupError(message) },
    );
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await artifact.chunks.next();
        if (next.done) {
          controller.close();
          artifact.close();
          return;
        }
        controller.enqueue(new Uint8Array(next.value));
      } catch (e) {
        artifact.close();
        controller.error(e);
      }
    },
    cancel() {
      void artifact.chunks.return(undefined);
      artifact.close();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${artifact.filename}"`,
      ...(artifact.sizeBytes !== null
        ? { "Content-Length": String(artifact.sizeBytes) }
        : {}),
      "Accept-Ranges": "none",
      "Cache-Control": "no-store",
    },
  });
}
