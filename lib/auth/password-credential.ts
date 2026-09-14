import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb, type DbTx, type DrizzleClient } from "../db/client";
import { account as accountTable } from "../db/schema/auth";
import { createLocalAccountIssuer } from "better-auth";
import { hashPassword, verifyPassword } from "../crypto";
import { newId } from "../ids";

// CREDENTIAL_ISSUER is `account.issuer`, required since Better Auth 1.7.0, which
// keys an account on `(issuer, accountId)`.
export const CREDENTIAL_ISSUER = createLocalAccountIssuer("credential");

// insertCredentialAccount writes the `credential` provider row for a user. `account_id`
// is the provider's own subject id; for `credential` that is the user id, matching the
// 0055 backfill.
export async function insertCredentialAccount(
  db: DrizzleClient | DbTx,
  userId: string,
  password: string,
): Promise<void> {
  await db.insert(accountTable).values({
    id: newId("bacc"),
    userId,
    accountId: userId,
    providerId: "credential",
    issuer: CREDENTIAL_ISSUER,
    password: await hashPassword(password),
  });
}

// verifyUserPassword is the re-auth step in front of every sensitive account action
// (change email / change password / transfer ownership / enable or disable 2FA).
export async function verifyUserPassword(
  userId: string,
  password: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ password: accountTable.password })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.userId, userId),
        eq(accountTable.providerId, "credential"),
      ),
    )
    .limit(1);
  const stored = rows[0]?.password;
  if (!stored) return false;
  return await verifyPassword(password, stored);
}

// setUserPassword replaces a user's stored credential (admin reset + the recover script).
export async function setUserPassword(
  userId: string,
  password: string,
  tx?: DbTx,
): Promise<void> {
  const db = tx ?? getDb();
  const updated = await db
    .update(accountTable)
    .set({ password: await hashPassword(password), updatedAt: new Date() })
    .where(
      and(
        eq(accountTable.userId, userId),
        eq(accountTable.providerId, "credential"),
      ),
    )
    .returning({ id: accountTable.id });
  // An account created before it had a credential row (or one whose provider row
  // was deleted) still needs a password to be settable.
  if (updated.length === 0) await insertCredentialAccount(db, userId, password);
}
