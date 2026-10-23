import { deriveKey, sha256Hex } from "../../crypto";

// Hashed from DEPLO_SECRET, so two instances never share it and it reveals nothing about any key.
export function instanceFingerprint(): string {
  return sha256Hex(deriveKey("migration-instance").toString("hex")).slice(
    0,
    32,
  );
}
