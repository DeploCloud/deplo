import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb, type DbTx, type DrizzleClient } from "../db/client";
import { account as accountTable } from "../db/schema/auth";
import { createLocalAccountIssuer } from "better-auth";
import { hashPassword, verifyPassword } from "../crypto";
import { newId } from "../ids";

export const CREDENTIAL_ISSUER = createLocalAccountIssuer("credential");

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
  if (updated.length === 0) await insertCredentialAccount(db, userId, password);
}
