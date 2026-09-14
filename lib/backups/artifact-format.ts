// AGE_MAGIC - age's header line; an artifact starting with it is encrypted.
export const AGE_MAGIC = "age-encryption.org/v1\n";

// ARTIFACT_MAGIC_BYTES - how many bytes a caller must read before looksEncrypted answers.
export const ARTIFACT_MAGIC_BYTES = AGE_MAGIC.length;

// looksEncrypted - whether these first bytes start an age-encrypted artifact.
export function looksEncrypted(head: Uint8Array): boolean {
  if (head.length < AGE_MAGIC.length) return false;
  for (let i = 0; i < AGE_MAGIC.length; i++) {
    if (head[i] !== AGE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

// looksGzip - whether these first bytes are gzip, which every unencrypted artifact is.
export function looksGzip(head: Uint8Array): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}
