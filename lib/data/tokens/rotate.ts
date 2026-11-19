import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apiTokens } from "../../db/schema/control-plane/api-tokens";
import { requireInstanceAdmin } from "../../membership";
import { assertUser } from "../../auth/current-user";
import { type ApiTokenDTO, getToken } from "./listing";
import { cleanExpiry, defaultExpiry, mintSecret } from "./mint";
import { teamsReachedByTokens, tokenReach } from "./reach";
import {
  assertExpiryWithinActingToken,
  refuseConnectedClient,
  requireOwnOrSession,
} from "./acting-token";
import { trail } from "./activity-trail";

/**
 * Gives a token a new secret and a new expiry. Name, permissions, scope and
 * history stay; the old secret stops working on its next call, because
 * authentication reads the hash this replaces.
 */
export async function rotateToken(
  id: string,
  input: { expiresAt?: string | null } = {},
): Promise<{ raw: string; token: ApiTokenDTO }> {
  const { id: userId } = await assertUser();
  requireOwnOrSession(id);
  await refuseConnectedClient();

  const db = getDb();
  const row = (
    await db
      .select({
        name: apiTokens.name,
        scoped: apiTokens.scoped,
        instanceAdmin: apiTokens.instanceAdmin,
        oauthClientId: apiTokens.oauthClientId,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
      .limit(1)
  )[0];
  if (!row) throw new Error("Token not found");
  // Nobody holds a connected client's deplo_ secret; it authenticates through OAuth.
  if (row.oauthClientId)
    throw new Error(
      "This token belongs to a connected AI client. Disconnect it and connect again instead.",
    );
  // Keeping the instance-admin bit alive is itself an instance-admin action.
  if (row.instanceAdmin) await requireInstanceAdmin();

  // The expiry restarts from now, so rerolling also revives an expired token.
  const expiresAt =
    input.expiresAt === undefined
      ? await defaultExpiry()
      : cleanExpiry(input.expiresAt);
  await assertExpiryWithinActingToken(expiresAt);

  const reach = row.scoped
    ? ((await teamsReachedByTokens([id])).get(id) ?? []).map((t) => t.id)
    : (await tokenReach(userId)).map((t) => t.id);

  const { raw, prefix, tokenHash } = mintSecret();
  const changed = await db
    .update(apiTokens)
    .set({ tokenHash, prefix, expiresAt, lastUsedAt: null })
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
    .returning({ id: apiTokens.id });
  if (changed.length === 0) throw new Error("Token not found");

  await trail(reach, `Rerolled the ${row.name} API token`, "token_rotated");

  const token = await getToken(id);
  if (!token) throw new Error("Token not found");
  return { raw, token };
}
