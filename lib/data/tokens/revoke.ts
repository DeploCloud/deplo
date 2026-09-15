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

export async function revokeToken(id: string): Promise<void> {
  const { id: userId } = await assertUser();
  requireOwnOrSession(id);

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
  await trail(
    reach,
    mcp
      ? `Revoked ${gone[0].name}'s MCP access`
      : `Revoked the ${gone[0].name} API token`,
    "token_revoked",
    mcp ? "mcp" : "security",
  );
}

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
    console.warn(
      `[deplo] could not clear the OAuth rows for a revoked connection (client ${clientId}):`,
      e,
    );
  }
}
