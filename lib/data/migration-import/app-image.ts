import "server-only";

import { connectAgent } from "../../infra/agent-client/connect";
import { blocker, type Note } from "../../migration/note";
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
  try {
    const dest = await connectAgent(app.serverId);
    try {
      const res = await dest.importImage(
        image,
        exportImage({ kind: svc.kind, id: svc.id }, image),
      );
      if (!res.ok) throw new Error(res.error || "the server here refused it");
    } finally {
      dest.close();
    }
    notes.push(
      `${image} is in no registry, only on {panel}'s server, so it was copied to this one. Push it to a registry to deploy it anywhere else.`,
    );
  } catch (e) {
    notes.push(
      blocker(
        `${image} is in no registry, only on {panel}'s server, and could not be copied here (${e instanceof Error ? e.message : String(e)}). Push it to a registry, or load it on this server, before deploying.`,
      ),
    );
  }
}
