import "server-only";

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { prepared } from "../../db/prepared";
import {
  apiTokens,
  apiTokenCapabilities,
} from "../../db/schema/control-plane/api-tokens";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { oauthAccessToken, oauthClient } from "../../db/schema/auth";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "../../auth/oauth-metadata";
import { nowIso } from "../../ids";
import { membershipFor } from "../../membership";
import { sha256Hex } from "../../crypto";
import type { Capability } from "../../types/identity";
import { type RequestIdentity } from "../../auth/request-context";
import { inCatalogOrder } from "./listing";
import { loadScope } from "./scope";
import { tokenReach } from "./reach";

// The columns every bearer lookup resolves to before the identity is built.
interface TokenRow {
  id: string;
  userId: string;
  instanceAdmin: boolean;
  scoped: boolean;
  // When it stops working. Null ⇒ never.
  expiresAt: string | null;
  // Set when an OAuth consent minted it - an MCP connection's credential.
  oauthClientId: string | null;
}

const TOKEN_ROW_COLUMNS = {
  id: apiTokens.id,
  userId: apiTokens.userId,
  instanceAdmin: apiTokens.instanceAdmin,
  scoped: apiTokens.scoped,
  expiresAt: apiTokens.expiresAt,
  oauthClientId: apiTokens.oauthClientId,
} as const;

// authenticateToken - resolve an incoming bearer credential to the identity the
// whole data layer runs under, or null if it does not match a live token.
export async function authenticateToken(
  raw: string,
  teamHint?: string | null,
): Promise<RequestIdentity | null> {
  if (raw.startsWith("deplo_")) {
    const rows = await prepared("token-by-hash", (db) =>
      db
        .select(TOKEN_ROW_COLUMNS)
        .from(apiTokens)
        .where(eq(apiTokens.tokenHash, sql.placeholder("hash")))
        .limit(1),
    ).execute({ hash: sha256Hex(raw) });
    return rows[0] ? identityForTokenRow(rows[0], teamHint) : null;
  }
  if (raw.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const row = await oauthTokenRow(raw);
    return row ? identityForTokenRow(row, teamHint) : null;
  }
  return null;
}

// Resolve an opaque OAuth access token to the `api_tokens` row its grant minted.
async function oauthTokenRow(raw: string): Promise<TokenRow | null> {
  const hash = sha256Hex(raw.slice(OAUTH_ACCESS_TOKEN_PREFIX.length));
  const rows = await getDb()
    .select(TOKEN_ROW_COLUMNS)
    .from(oauthAccessToken)
    .innerJoin(
      apiTokens,
      and(
        eq(apiTokens.oauthClientId, oauthAccessToken.clientId),
        eq(apiTokens.userId, oauthAccessToken.userId),
      ),
    )
    .innerJoin(oauthClient, eq(oauthClient.clientId, oauthAccessToken.clientId))
    .where(
      and(
        eq(oauthAccessToken.token, hash),
        gt(oauthAccessToken.expiresAt, new Date()),
        // RFC 7009 revocation stamps the row rather than deleting it.
        isNull(oauthAccessToken.revoked),
        // A disabled client stops resolving immediately; the plugin's own token
        // lookup does not check this, and a credential whose client was turned
        // off is exactly the one an operator thinks they have stopped.
        or(isNull(oauthClient.disabled), eq(oauthClient.disabled, false)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

const STAMP_EVERY_MS = 60_000;
/** ponytail: process-local; a second control plane stamps on its own clock, which is fine. */
const stampedAt = new Map<string, number>();

// THE identity builder.
async function identityForTokenRow(
  match: TokenRow,
  teamHint?: string | null,
): Promise<RequestIdentity | null> {
  // Expiry first, and it is a plain "this token is not valid": before any team is
  // resolved, before the membership read, before `lastUsedAt` is stamped.
  if (match.expiresAt && Date.parse(match.expiresAt) <= Date.now()) return null;
  const scope = match.scoped ? await loadScope(match.id) : null;

  // Fail CLOSED: the token acts only in teams where its owner is STILL a member
  // holding `manage_tokens`, so losing either silently narrows every token that
  // person minted, and losing the last one stops the token resolving at all.
  const mine = await tokenReach(match.userId);
  let reachable = scope
    ? mine.filter((t) => scope.teamIds.includes(t.id))
    : mine;
  // A team's MCP switch is the kill switch for the credentials minted through
  // it, on every door - not only on /api/mcp.
  if (match.oauthClientId && reachable.length > 0) {
    const off = new Set(
      (
        await getDb()
          .select({ id: teamsTable.id })
          .from(teamsTable)
          .where(
            and(
              inArray(
                teamsTable.id,
                reachable.map((t) => t.id),
              ),
              eq(teamsTable.mcpEnabled, false),
            ),
          )
      ).map((r) => r.id),
    );
    reachable = reachable.filter((t) => !off.has(t.id));
  }
  if (reachable.length === 0) return null;
  const picked =
    (teamHint &&
      reachable.find((t) => t.id === teamHint || t.slug === teamHint)) ||
    reachable[0];

  // The 2FA / membership guard, on the team the request actually resolved to.
  if (!(await membershipFor(match.userId, picked.id))) return null;

  const caps = await prepared("token-capabilities", (db) =>
    db
      .select({ capability: apiTokenCapabilities.capability })
      .from(apiTokenCapabilities)
      .where(eq(apiTokenCapabilities.tokenId, sql.placeholder("id"))),
  ).execute({ id: match.id });

  // Fire-and-forget usage stamp, once a minute per token: a failed write must
  // not block the request, and a burst must not queue one row lock per call.
  const now = Date.now();
  if ((stampedAt.get(match.id) ?? 0) < now - STAMP_EVERY_MS) {
    stampedAt.set(match.id, now);
    void getDb()
      .update(apiTokens)
      .set({ lastUsedAt: nowIso() })
      .where(eq(apiTokens.id, match.id))
      .catch(() => {
        /* usage tracking is best-effort */
      });
  }

  return {
    userId: match.userId,
    teamId: picked.id,
    token: {
      id: match.id,
      capabilities: inCatalogOrder(caps.map((c) => c.capability as Capability)),
      scope,
      // Belt and braces for a hand-edited row: the two are mutually exclusive,
      // because an instance-admin gate never consults team capabilities and so
      // could not be narrowed by a scope anyway.
      instanceAdmin: match.instanceAdmin && !match.scoped,
    },
  };
}

// stampMcpUse - record that this token just drove an AI agent, rather than merely
// that it was used.
export function stampMcpUse(tokenId: string): void {
  void getDb()
    .update(apiTokens)
    .set({ mcpLastUsedAt: nowIso() })
    .where(eq(apiTokens.id, tokenId))
    .catch(() => {
      /* usage tracking is best-effort */
    });
}
