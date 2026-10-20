import "server-only";

import { Readable } from "node:stream";

import { archiveExt, removeUploads, storeUpload } from "../../deploy/upload";
import { blocker, type Note } from "../../migration/note";
import { sourceClient, type SourceCredential } from "../../migration/source";
import { setAppUpload } from "../apps/settings";
import type { SourceService } from "./source-tree";

// The archive is the app's source, so it lands with the app rather than in the data phase.
export async function landAppUpload(
  c: SourceCredential,
  svc: SourceService,
  appId: string,
  upload: { filename: string },
  notes: Note[],
): Promise<void> {
  const exportUpload = sourceClient(c).dataExport?.exportUpload;
  const ext = archiveExt(upload.filename);
  try {
    if (!exportUpload || !ext)
      throw new Error("it is not an archive Deplo can read");
    const body = Readable.toWeb(
      Readable.from(exportUpload({ kind: svc.kind, id: svc.id })),
    ) as ReadableStream<Uint8Array>;
    const stored = await storeUpload({
      appId,
      filename: upload.filename,
      ext,
      body,
    });
    await setAppUpload(appId, stored).catch(async (e) => {
      await removeUploads(appId);
      throw e;
    });
  } catch (e) {
    notes.push(
      blocker(
        `${upload.filename} could not be copied from {panel} (${e instanceof Error ? e.message : String(e)}). Upload it again here before deploying.`,
      ),
    );
  }
}
