import { type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { downloadBackupArtifact } from "@/lib/data/backups";

/**
 * Download one backup artifact.
 *
 *   GET /api/backups/<runId>/download → the decrypted .tar.gz / .dump.gz
 *
 * A Route Handler rather than a GraphQL field for the same reason
 * `/api/apps/[id]/upload` is one: an artifact is arbitrarily large, so it has to
 * stream rather than be a field in a JSON response. Cookie auth like every other
 * REST exception, then straight back into the normal gates —
 * `downloadBackupArtifact` resolves the run team-scoped and requires
 * `restore_backups` on its own target, because handing someone a dump gives them
 * every byte the target holds.
 *
 * Server destinations only: an S3 artifact would mean pulling it out of the
 * bucket and back through here to hand over a file the operator can already
 * fetch with their own credentials.
 *
 * NO RANGE SUPPORT, deliberately. The agent decrypts the age stream on the way
 * out, and an age stream is not seekable — so a byte range would mean decrypting
 * from zero and discarding the prefix. `Accept-Ranges: none` says so rather than
 * letting a download manager assume resume works and produce a corrupt file.
 */

// Long-lived streamed response; must run at request time on the Node runtime.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  ctx: RouteContext<"/api/backups/[runId]/download">,
) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { runId } = await ctx.params;

  let artifact: Awaited<ReturnType<typeof downloadBackupArtifact>>;
  try {
    artifact = await downloadBackupArtifact(runId);
  } catch (e) {
    // The data layer's message is the useful one ("not found", "no permission",
    // "this backup is in an S3 bucket") — surface it verbatim.
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
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
      "Accept-Ranges": "none",
      "Cache-Control": "no-store",
    },
  });
}
