import "server-only";

import { connectAgent } from "../../infra/agent-client/connect";
import { DeploTooOldError } from "../../migration/deplo/client";
import { blocker, type Note } from "../../migration/note";
import { errorMessage } from "../../utils";
import { sourceClient, type SourceCredential } from "../../migration/source";
import { checkImageExists } from "../../registry/client";
import type { SourceService } from "./source-tree";

// An image no registry has was built or loaded on the old server itself, so it goes with the app.
export async function landSourceImage(
  c: SourceCredential,
  svc: SourceService,
  app: { serverId: string },
  image: string,
  notes: Note[],
): Promise<void> {
  const exportImage = sourceClient(c).dataExport?.exportImage;
  if (!exportImage) return;
  if ((await checkImageExists(image)).status !== "absent") return;
  // The server here may only say the stream broke; what the source answered is the reason.
  let refused: unknown = null;
  const chunks = (async function* () {
    try {
      yield* exportImage({ kind: svc.kind, id: svc.id }, image);
    } catch (e) {
      refused = e;
      throw e;
    }
  })();
  try {
    const dest = await connectAgent(app.serverId);
    try {
      const res = await dest.importImage(image, chunks);
      if (!res.ok) throw new Error(res.error || "the server here refused it");
    } finally {
      dest.close();
    }
    notes.push(
      `${image} is in no registry, only on {panel}'s server, so it was copied to this one. Push it to a registry to deploy it anywhere else.`,
    );
  } catch (e) {
    const why = refused ?? e;
    notes.push(
      blocker(
        why instanceof DeploTooOldError
          ? `${image} is in no registry, only on {panel}'s server, and ${why.message}. Push it to a registry and add that under Registries, or update {panel} and run the migration again, before deploying.`
          : `${image} is in no registry, only on {panel}'s server, and could not be copied here (${errorMessage(why, String(why))}). Push it to a registry and add that under Registries before deploying.`,
      ),
    );
  }
}
