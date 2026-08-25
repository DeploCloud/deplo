import { type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { isCrossSite, crossSiteRefused } from "@/lib/http/same-origin";
import { downloadBackupArtifact } from "@/lib/data/backups";
import { statusForBackupError } from "@/lib/backups/http-status";

/**
 * Download one backup artifact. Server destinations only: an S3 artifact would
 * mean pulling it out of the bucket and back through here to hand over a file the
 * operator can already fetch with their own credentials.
 */

// Long-lived streamed response; must run at request time on the Node runtime.
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
    // The data layer's message is the useful one ("not found", "no permission", "this
    // backup is in an S3 bucket") - surface it verbatim, under a status that means what
    // it says.
    const message = e instanceof Error ? e.message : String(e);
    return Response.json(
      { error: message },
      { status: statusForBackupError(message) },
    );
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // One chunk per pull: the stream's own backpressure then paces the agent,
      // so a slow client cannot make the control plane buffer the artifact.
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
      // The browser went away mid-download: stop the agent rather than letting
      // it read the rest of a multi-GB artifact into a socket nobody reads.
      void artifact.chunks.return(undefined);
      artifact.close();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${artifact.filename}"`,
      // A short stream now FAILS the download instead of saving a truncated
      // archive that looks complete, which is the right outcome for a backup.
      ...(artifact.sizeBytes !== null
        ? { "Content-Length": String(artifact.sizeBytes) }
        : {}),
      "Accept-Ranges": "none",
      "Cache-Control": "no-store",
    },
  });
}
