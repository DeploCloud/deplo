import "server-only";

import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";

import { deriveKey, encryptSecret, tryDecryptSecret } from "../../crypto";
import type { MoveKey } from "../../deplo-move/tables";

// The same string lib/auth/better-auth.ts hands Better Auth as its secret.
function betterAuthKey(): string {
  return deriveKey("better-auth").toString("hex");
}

// Null when the value will not open under this Deplo's key.
export async function openValue(
  key: MoveKey,
  sealed: string,
): Promise<string | null> {
  if (key === "secrets") {
    const res = tryDecryptSecret(sealed);
    return res.ok ? res.value : null;
  }
  try {
    return await symmetricDecrypt({ key: betterAuthKey(), data: sealed });
  } catch {
    return null;
  }
}

export async function sealValue(key: MoveKey, plain: string): Promise<string> {
  if (key === "secrets") return encryptSecret(plain);
  return symmetricEncrypt({ key: betterAuthKey(), data: plain });
}

// NULL and "" mean "none" in every re-keyed column, and stay exactly that.
export function isSealed(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

// drizzle's execute answers with the driver's shape: node-postgres and pglite both carry `rows`.
export function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] } | null)?.rows ?? []) as T[];
}
