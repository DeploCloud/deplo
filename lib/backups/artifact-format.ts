/**
 * How a backup artifact announces itself in its first bytes.
 *
 * Shared by the BROWSER (the restore-from-file dialog asks for a recovery key
 * only when the picked file is actually encrypted) and the CONTROL PLANE (which
 * refuses a file that is not an artifact at all). Deliberately free of any Node
 * import so it bundles for the client - the real inspection, which needs zlib
 * and the age library, lives in `artifact-sniff.ts` and is server-side.
 */

/**
 * age's header line: plaintext, always first, and the same in every version of
 * the format we write. An artifact whose first bytes are this is encrypted and
 * cannot be read without the destination's recovery key.
 */
export const AGE_MAGIC = "age-encryption.org/v1\n";

/** How many bytes a caller must read before {@link looksEncrypted} can answer. */
export const ARTIFACT_MAGIC_BYTES = AGE_MAGIC.length;

/** Whether these first bytes are the start of an age-encrypted artifact. */
export function looksEncrypted(head: Uint8Array): boolean {
  if (head.length < AGE_MAGIC.length) return false;
  for (let i = 0; i < AGE_MAGIC.length; i++) {
    if (head[i] !== AGE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Whether these first bytes are gzip - which every unencrypted artifact is: an
 * app is a `.tar.gz`, a database a `.dump.gz` / `.sql.gz` / `.rdb.gz` /
 * `.archive.gz`, and Deplo's own Download hands over the decrypted gzip.
 */
export function looksGzip(head: Uint8Array): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}
