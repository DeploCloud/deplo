import "server-only";

import { cache } from "@/lib/request-cache";

import { and, eq, exists, sql } from "drizzle-orm";

import { getDb } from "./db/client";
import { passkey as passkeyTable } from "./db/schema/auth";
import { users as usersTable } from "./db/schema/control-plane/identity";
import { passkeyRelyingParty } from "./public-url";
import {
  currentSessionAuthMethod,
  currentSessionId,
} from "./auth/current-user";

export const holdsAPasskey = (userIdColumn: typeof usersTable.id) => {
  const rp = passkeyRelyingParty();
  if (!rp) return sql<boolean>`false`;
  return exists(
    getDb()
      .select({ one: passkeyTable.id })
      .from(passkeyTable)
      .where(
        and(
          eq(passkeyTable.userId, userIdColumn),
          eq(passkeyTable.rpId, rp.rpId),
        ),
      ),
  );
};

export const userHasPasskey = cache(
  async (userId: string): Promise<boolean> => {
    const rp = passkeyRelyingParty();
    if (!rp) return false;
    const rows = await getDb()
      .select({ id: passkeyTable.id })
      .from(passkeyTable)
      .where(
        and(eq(passkeyTable.userId, userId), eq(passkeyTable.rpId, rp.rpId)),
      )
      .limit(1);
    return rows.length > 0;
  },
);

export async function passkeyCountsForThisRequest(): Promise<boolean> {
  const sessionId = await currentSessionId();
  if (!sessionId) return true;
  return (await currentSessionAuthMethod()) === "passkey";
}
