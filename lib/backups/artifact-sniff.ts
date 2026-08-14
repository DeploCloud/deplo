import zlib from "node:zlib";

import { looksEncrypted, looksGzip } from "./artifact-format";
import type { BackupTargetKind } from "../types";

/**
 * Everything the control plane can learn about an UPLOADED artifact before it
 * lets a restore start - from its first bytes alone.
 *
 * This exists because of what the agent does the moment a restore begins: it
 * stops the stack, then WIPES the target's volumes and untars into them, and it
 * only restores the `volumes/<name>/` entries whose name matches the target it
 * was given. So a file that is not what the operator thinks it is does not fail
 * harmlessly - the wrong artifact empties every volume and puts nothing back.
 * Every check that can be made here is one the agent never has to reach.
 *
 * Three questions, in order, all answered from the head of the stream:
 *
 *  1. Is it an artifact at all? age header or gzip magic, or it is refused.
 *  2. Does this recovery key open it? age parses its header (and tries every
 *     identity against it) before handing back a stream, so this costs the ~200
 *     bytes of the header rather than the artifact - and a wrong key is refused
 *     while the target is still untouched.
 *  3. Is it the right SHAPE for this target? An app's artifact is a tar; a
 *     database dump is not. That one bit separates the two mix-ups that would
 *     otherwise be silent and destructive.
 *
 * Pure apart from `zlib` and a lazily-imported age: no I/O, no database, no
 * agent - which is what makes it testable on hand-built buffers.
 */

/**
 * How much of the upload is buffered for the checks above.
 *
 * age encrypts in 64 KiB chunks and only authenticates a chunk once it is whole,
 * so a prefix shorter than one chunk decrypts to nothing. 128 KiB guarantees a
 * full chunk for any artifact bigger than that, and IS the whole artifact for
 * anything smaller.
 */
export const SNIFF_HEAD_BYTES = 128 * 1024;

/** The tar magic sits at offset 257 of the first header block (POSIX/ustar). */
const TAR_MAGIC_OFFSET = 257;
const TAR_MAGIC = "ustar";

/**
 * How much decompressed head we keep. We need byte 262, so 4 KiB is generous -
 * and it is a CAP, not a target: 128 KiB of gzip can inflate to hundreds of
 * megabytes, and an uploaded file is not trusted input.
 */
const UNPACKED_LIMIT = 4096;

export interface SniffedArtifact {
  /** Whether the artifact is age-encrypted, and so travels to the agent as is. */
  encrypted: boolean;
}

/**
 * Inspect the head of an uploaded artifact. Returns what the caller needs to
 * build the restore, or throws with a message meant for the operator - the UI
 * surfaces it verbatim.
 */
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

  const compressed = encrypted ? await decryptHead(head, opts.recoveryKey) : head;
  const unpacked = await gunzipHead(compressed);
  const isTar = looksTar(unpacked);

  // Both directions, because both happen and both are destructive. Each message
  // names where the file DOES belong, so the answer is one click away.
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

/** Whether the decompressed head starts with a tar header block. */
function looksTar(unpacked: Buffer): boolean {
  return (
    unpacked.length >= TAR_MAGIC_OFFSET + TAR_MAGIC.length &&
    unpacked
      .subarray(TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + TAR_MAGIC.length)
      .toString("latin1") === TAR_MAGIC
  );
}

/**
 * Decrypt as much of the head as the key and the truncation allow.
 *
 * The two failures here are the ones an operator actually hits - a key that is
 * not a key, and a key from the wrong destination - and both are answered
 * before anything on any host is touched.
 */
async function decryptHead(head: Buffer, recoveryKey: string): Promise<Buffer> {
  const key = recoveryKey.trim();
  if (!key)
    throw new Error(
      "That file is encrypted. Paste the recovery key of the destination it came from.",
    );

  // Lazily, so merely importing this module does not pull the crypto library in
  // - the same reason `generateAgeKeypair` does it in lib/data/destinations.ts.
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
    // Expected on anything bigger than the head: the last chunk we handed over
    // is cut in half, so it cannot authenticate ("invalid tag"). The whole
    // chunks that came out before it are what these checks read.
  }
  return Buffer.concat(parts);
}

/**
 * Inflate the first {@link UNPACKED_LIMIT} bytes of a gzip head. Never throws:
 * a truncated stream is the normal case here, and a head that inflates to
 * nothing simply fails the tar check above.
 */
function gunzipHead(compressed: Buffer): Promise<Buffer> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let total = 0;
    const gun = zlib.createGunzip();
    // Whichever of the three ends us first wins; a promise settles once, so the
    // stragglers are no-ops. `destroy()` on a full head is the usual one.
    const done = () => resolve(Buffer.concat(parts).subarray(0, UNPACKED_LIMIT));
    gun.on("data", (chunk: Buffer) => {
      parts.push(chunk);
      total += chunk.length;
      if (total >= UNPACKED_LIMIT) gun.destroy();
    });
    // A truncated stream ("unexpected end of file") is the normal case, not a
    // failure: the bytes it already inflated are the ones being inspected.
    gun.on("error", done);
    gun.on("end", done);
    gun.on("close", done);
    gun.end(compressed);
  });
}
