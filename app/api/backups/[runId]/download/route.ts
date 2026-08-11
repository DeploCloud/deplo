import { type NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth";
import { downloadBackupArtifact } from "@/lib/data/backups";
import { statusForBackupError } from "@/lib/backups/http-status";

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
 *
 * `Content-Length` IS sent, whenever the run recorded one. Without it a browser
 * has no total to compare against: no size, no percentage, no time remaining —
 * a download that reads as if it will never end, on a file that can genuinely
 * take a quarter of an hour. It comes from the run's `decryptedSizeBytes` and
 * never from `sizeBytes`, which is the artifact as stored, age layer and all.
 * A run taken before the agent reported it has none, and then this behaves as it
 * always did rather than advertising a length that would be a few hundred KB
 * too long — which the browser would sit and wait for forever.
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
    // "this backup is in an S3 bucket") — surface it verbatim, under a status
    // that means what it says. Everything used to be a 400, so a browser, a
    // proxy log and a script all read "you sent a bad request" for a run that
    // exists and a permission the caller does not have.
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: message }, { status: statusForBackupError(message) });
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
      // archive that looks complete — which is the right outcome for a backup.
      ...(artifact.sizeBytes !== null
        ? { "Content-Length": String(artifact.sizeBytes) }
        : {}),
      "Accept-Ranges": "none",
      "Cache-Control": "no-store",
    },
  });
}
