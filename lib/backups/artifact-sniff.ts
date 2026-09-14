import zlib from "node:zlib";

import { looksEncrypted, looksGzip } from "./artifact-format";
import type { BackupTargetKind } from "../types/backup";

// SNIFF_HEAD_BYTES - how much of the upload is buffered for these checks.
export const SNIFF_HEAD_BYTES = 128 * 1024;

const TAR_MAGIC_OFFSET = 257;
const TAR_MAGIC = "ustar";

// A CAP, not a target: 128 KiB of gzip can inflate to hundreds of megabytes.
const UNPACKED_LIMIT = 4096;

export interface SniffedArtifact {
  encrypted: boolean;
}

// sniffArtifact - inspect an uploaded artifact's head; throws a message for the operator.
export async function sniffArtifact(
  head: Buffer,
  opts: { kind: BackupTargetKind; recoveryKey: string },
): Promise<SniffedArtifact> {
  if (head.length === 0) throw new Error("That file is empty.");

  const encrypted = looksEncrypted(head);
  if (!encrypted && !looksGzip(head))
    throw new Error(
      "That file is not a backup artifact. Upload the file a backup produced: " +
        "the .tar.gz / .dump.gz Deplo downloads, or the .age file sitting at " +
        "the destination.",
    );

  const compressed = encrypted
    ? await decryptHead(head, opts.recoveryKey)
    : head;
  const unpacked = await gunzipHead(compressed);
  const isTar = looksTar(unpacked);

  if (opts.kind === "app" && !isTar)
    throw new Error(
      "That is not an app backup. An app's artifact is a tar archive of its " +
        "volumes and files; this is not one. If it is a database dump, restore " +
        "it from that database's Backups tab.",
    );
  if (opts.kind === "database" && isTar)
    throw new Error(
      "That is an app backup, not a database dump. Restore it from that app's " +
        "Backups tab.",
    );

  return { encrypted };
}

function looksTar(unpacked: Buffer): boolean {
  return (
    unpacked.length >= TAR_MAGIC_OFFSET + TAR_MAGIC.length &&
    unpacked
      .subarray(TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + TAR_MAGIC.length)
      .toString("latin1") === TAR_MAGIC
  );
}

async function decryptHead(head: Buffer, recoveryKey: string): Promise<Buffer> {
  const key = recoveryKey.trim();
  if (!key)
    throw new Error(
      "That file is encrypted. Paste the recovery key of the destination it came from.",
    );

  // Lazy, so importing this module does not pull the crypto library in.
  const age = await import("age-encryption");
  const decrypter = new age.Decrypter();
  try {
    decrypter.addIdentity(key);
  } catch {
    throw new Error(
      "That is not a recovery key. A recovery key is one line beginning with " +
        "AGE-SECRET-KEY-1.",
    );
  }

  let plain: ReadableStream<Uint8Array>;
  try {
    plain = await decrypter.decrypt(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(head);
          c.close();
        },
      }),
    );
  } catch {
    throw new Error(
      "That recovery key does not open this file. Check it is the key of the " +
        "destination this artifact came from.",
    );
  }

  const reader = plain.getReader();
  const parts: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
  } catch {
    // Expected past the head: the last chunk is cut in half and cannot authenticate.
  }
  return Buffer.concat(parts);
}

function gunzipHead(compressed: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let total = 0;
    const gun = zlib.createGunzip();
    const done = () =>
      resolve(Buffer.concat(parts).subarray(0, UNPACKED_LIMIT));
    gun.on("data", (chunk: Buffer) => {
      parts.push(chunk);
      total += chunk.length;
      if (total >= UNPACKED_LIMIT) gun.destroy();
    });
    // A truncated stream is the normal case here, not a failure.
    gun.on("error", done);
    gun.on("end", done);
    gun.on("close", done);
    gun.end(compressed);
  });
}
