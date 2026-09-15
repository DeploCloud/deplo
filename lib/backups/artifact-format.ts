export const AGE_MAGIC = "age-encryption.org/v1\n";

export const ARTIFACT_MAGIC_BYTES = AGE_MAGIC.length;

export function looksEncrypted(head: Uint8Array): boolean {
  if (head.length < AGE_MAGIC.length) return false;
  for (let i = 0; i < AGE_MAGIC.length; i++) {
    if (head[i] !== AGE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

export function looksGzip(head: Uint8Array): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}
