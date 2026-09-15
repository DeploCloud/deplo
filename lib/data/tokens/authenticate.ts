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

interface TokenRow {
  id: string;
  userId: string;
  instanceAdmin: boolean;
  scoped: boolean;
  expiresAt: string | null;
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
        isNull(oauthAccessToken.revoked),
        or(isNull(oauthClient.disabled), eq(oauthClient.disabled, false)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

const STAMP_EVERY_MS = 60_000;
/** ponytail: process-local; a second control plane stamps on its own clock, which is fine. */
const stampedAt = new Map<string, number>();

async function identityForTokenRow(
  match: TokenRow,
  teamHint?: string | null,
): Promise<RequestIdentity | null> {
  if (match.expiresAt && Date.parse(match.expiresAt) <= Date.now()) return null;
  const scope = match.scoped ? await loadScope(match.id) : null;

  const mine = await tokenReach(match.userId);
  let reachable = scope
    ? mine.filter((t) => scope.teamIds.includes(t.id))
    : mine;
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

  if (!(await membershipFor(match.userId, picked.id))) return null;

  const caps = await prepared("token-capabilities", (db) =>
    db
      .select({ capability: apiTokenCapabilities.capability })
      .from(apiTokenCapabilities)
      .where(eq(apiTokenCapabilities.tokenId, sql.placeholder("id"))),
  ).execute({ id: match.id });

  const now = Date.now();
  if ((stampedAt.get(match.id) ?? 0) < now - STAMP_EVERY_MS) {
    stampedAt.set(match.id, now);
    void getDb()
      .update(apiTokens)
      .set({ lastUsedAt: nowIso() })
      .where(eq(apiTokens.id, match.id))
      .catch(() => {});
  }

  return {
    userId: match.userId,
    teamId: picked.id,
    token: {
      id: match.id,
      capabilities: inCatalogOrder(caps.map((c) => c.capability as Capability)),
      scope,
      instanceAdmin: match.instanceAdmin && !match.scoped,
    },
  };
}

export function stampMcpUse(tokenId: string): void {
  void getDb()
    .update(apiTokens)
    .set({ mcpLastUsedAt: nowIso() })
    .where(eq(apiTokens.id, tokenId))
    .catch(() => {});
}
