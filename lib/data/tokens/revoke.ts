import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apiTokens } from "../../db/schema/control-plane/api-tokens";
import {
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
} from "../../db/schema/auth";
import { assertUser } from "../../auth/current-user";
import { requireOwnOrSession } from "./acting-token";
import { teamsReachedByTokens, tokenReach } from "./reach";
import { trail } from "./activity-trail";

// revokeToken - the credential is gone, everywhere. Only its owner can: a team
// takes access away by changing the member, not the token.
export async function revokeToken(id: string): Promise<void> {
  const { id: userId } = await assertUser();
  requireOwnOrSession(id);

  // Read the reach BEFORE the row goes: afterwards there is nothing left to ask.
  // (Also before any transaction - this helper queries on its own connection and
  // pglite deadlocks if that happens inside one.)
  const row = (
    await getDb()
      .select({ scoped: apiTokens.scoped })
      .from(apiTokens)
      .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
      .limit(1)
  )[0];
  if (!row) throw new Error("Token not found");
  const reach = row.scoped
    ? ((await teamsReachedByTokens([id])).get(id) ?? []).map((t) => t.id)
    : (await tokenReach(userId)).map((t) => t.id);

  const gone = await getDb()
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
    .returning({
      id: apiTokens.id,
      name: apiTokens.name,
      userId: apiTokens.userId,
      oauthClientId: apiTokens.oauthClientId,
    });
  if (gone.length === 0) throw new Error("Token not found");
  await forgetOauthGrant(gone[0].userId, gone[0].oauthClientId);

  const mcp = gone[0].oauthClientId != null;
  // The type follows the message: `mcp-clients.ts` files the connect under
  // `mcp`, and filing the revoke elsewhere would split one story in two.
  await trail(
    reach,
    mcp
      ? `Revoked ${gone[0].name}'s MCP access`
      : `Revoked the ${gone[0].name} API token`,
    "token_revoked",
    mcp ? "mcp" : "security",
  );
}

// Tear down the OAuth half of a connection when its token is revoked.
// Best-effort: the credential is already gone, and a failed cleanup must not turn
// a successful revoke into an error.
async function forgetOauthGrant(
  userId: string,
  clientId: string | null,
): Promise<void> {
  if (!clientId) return;
  try {
    const db = getDb();
    const owned = and(
      eq(oauthAccessToken.clientId, clientId),
      eq(oauthAccessToken.userId, userId),
    );
    await db.delete(oauthAccessToken).where(owned);
    await db
      .delete(oauthRefreshToken)
      .where(
        and(
          eq(oauthRefreshToken.clientId, clientId),
          eq(oauthRefreshToken.userId, userId),
        ),
      );
    await db
      .delete(oauthConsent)
      .where(
        and(
          eq(oauthConsent.clientId, clientId),
          eq(oauthConsent.userId, userId),
        ),
      );
  } catch (e) {
    // Not fatal: a leftover consent or refresh row grants nothing - the join that
    // resolves an access token has no `api_tokens` row to land on.
    console.warn(
      `[deplo] could not clear the OAuth rows for a revoked connection (client ${clientId}):`,
      e,
    );
  }
}
