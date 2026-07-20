import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apiTokens } from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { membershipFor, requireActiveTeamId, requireCapability } from "../membership";
import { sha256Hex, randomToken } from "../crypto";

export interface ApiTokenDTO {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

/** The non-secret projection — never selects `token_hash` (relational-store PLAN §1 "Secrets"). */
const DTO_COLUMNS = {
  id: apiTokens.id,
  name: apiTokens.name,
  prefix: apiTokens.prefix,
  lastUsedAt: apiTokens.lastUsedAt,
  createdAt: apiTokens.createdAt,
} as const;

export async function listTokens(): Promise<ApiTokenDTO[]> {
  const teamId = await requireActiveTeamId();
  return getDb()
    .select(DTO_COLUMNS)
    .from(apiTokens)
    .where(eq(apiTokens.teamId, teamId))
    .orderBy(desc(apiTokens.createdAt));
}

/** Returns the raw token ONCE; only the hash is persisted. */
export async function createToken(name: string): Promise<{ raw: string; token: ApiTokenDTO }> {
  const { teamId, userId } = await requireCapability("manage_infra");
  if (!name.trim()) throw new Error("Name is required");
  const raw = `deplo_${randomToken(24)}`;
  const token: ApiTokenDTO = {
    id: newId("tok"),
    name: name.trim(),
    prefix: raw.slice(0, 12),
    lastUsedAt: null,
    createdAt: nowIso(),
  };
  await getDb()
    .insert(apiTokens)
    .values({
      ...token,
      teamId,
      // The token acts as its creator for user-scoped fields on bearer requests.
      userId,
      tokenHash: sha256Hex(raw),
    });
  return { raw, token };
}

/**
 * Resolve an incoming `deplo_…` bearer token to its principal, or null if it
 * does not match a live token. Bumps `lastUsedAt`. The GraphQL request context
 * uses this to authenticate external API clients. Never throws.
 */
export async function authenticateToken(
  raw: string,
): Promise<{ userId: string; teamId: string } | null> {
  if (!raw.startsWith("deplo_")) return null;
  const hash = sha256Hex(raw);
  const rows = await getDb()
    .select({
      id: apiTokens.id,
      userId: apiTokens.userId,
      teamId: apiTokens.teamId,
    })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hash))
    .limit(1);
  const match = rows[0];
  if (!match) return null;
  // Fail CLOSED on a stale token: if its creator has since left (or been
  // removed from) the token's team, the token stops resolving — it must never
  // re-scope the request to another of the user's teams.
  if (!(await membershipFor(match.userId, match.teamId))) return null;
  // Fire-and-forget usage stamp; a failed write must not block the request.
  void getDb()
    .update(apiTokens)
    .set({ lastUsedAt: nowIso() })
    .where(eq(apiTokens.id, match.id))
    .catch(() => {
      /* usage tracking is best-effort */
    });
  return { userId: match.userId, teamId: match.teamId };
}

export async function revokeToken(id: string): Promise<void> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  await getDb()
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.teamId, teamId)));
}
