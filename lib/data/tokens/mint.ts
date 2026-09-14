import "server-only";

// https://deplo.build/docs/advanced/api-tokens-and-oauth

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  apiTokens,
  apiTokenCapabilities,
  apiTokenTeams,
  apiTokenProjects,
  apiTokenFolders,
  apiTokenApps,
} from "../../db/schema/control-plane/api-tokens";
import { newId, nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import { assertUser } from "../../auth/current-user";
import { sha256Hex, randomToken } from "../../crypto";
import type { Capability } from "../../types/identity";
import { type ApiTokenDTO } from "./listing";
import { namedTeams, tokenReach } from "./reach";
import {
  resolveScopeInput,
  validateScope,
  writeScope,
  type ResolvedScope,
  type TokenScopeInput,
} from "./scope";
import {
  actingTokenExpiry,
  assertExpiryWithinActingToken,
  assertScopeWithinActingToken,
  ownerCeiling,
  requireOwnOrSession,
} from "./acting-token";
import { trail } from "./activity-trail";

const MAX_NAME = 40;

function cleanTokenName(raw: string): string {
  const name = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Give the token a name");
  if (name.length > MAX_NAME)
    throw new Error(`Keep the token name under ${MAX_NAME} characters`);
  return name;
}

// The teams a token will act in, from its resolved scope: the ones it names, or
// everywhere its owner may use tokens.
async function reachOf(
  scope: ResolvedScope,
  userId: string,
): Promise<string[]> {
  return scope.teamsReached.length > 0
    ? scope.teamsReached
    : (await tokenReach(userId)).map((t) => t.id);
}

// DEFAULT_TOKEN_DAYS - what a token gets when the caller says nothing; omitting
// the field used to mint the credential nobody remembers to revoke.
export const DEFAULT_TOKEN_DAYS = 90;

async function defaultExpiry(): Promise<string> {
  const ninety = Date.now() + DEFAULT_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  // A token minted BY a token can never outlive it, so the default is the
  // sooner of the two - otherwise leaving the field out would be refused.
  const parent = await actingTokenExpiry();
  const at = parent ? Math.min(ninety, Date.parse(parent)) : ninety;
  return new Date(at).toISOString();
}

// An ISO instant in the future, or null for never. No upper bound: refusing a
// five-year token would only push people back to "never".
function cleanExpiry(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error("That expiry date is not a date");
  if (at <= Date.now())
    throw new Error("Pick an expiry date in the future, or no expiry at all");
  return new Date(at).toISOString();
}

// createToken - returns the raw token ONCE; only the hash is persisted.
export async function createToken(
  input: {
    name: string;
    capabilities?: Capability[];
    instanceAdmin?: boolean;
    // ISO instant this token stops working. ABSENT ⇒ the default expiry the
    // editor offers; explicit `null` ⇒ never.
    expiresAt?: string | null;
  } & TokenScopeInput,
): Promise<{ raw: string; token: ApiTokenDTO }> {
  // Any member may mint: a token adds no power, it is clamped to what its
  // owner holds in each team it reaches.
  const { id: userId } = await assertUser();
  const name = cleanTokenName(input.name);
  const { scoped, instanceAdmin } = await validateScope(input);
  const expiresAt =
    input.expiresAt === undefined
      ? await defaultExpiry()
      : cleanExpiry(input.expiresAt);
  await assertExpiryWithinActingToken(expiresAt);
  const scope = await resolveScopeInput(input, userId);
  assertScopeWithinActingToken(scope, scoped);
  const reach = await reachOf(scope, userId);
  const capabilities = await ownerCeiling(userId, input.capabilities, reach);

  const raw = `deplo_${randomToken(24)}`;
  const id = newId("tok");
  const createdAt = nowIso();
  await getDb().transaction(async (tx) => {
    await tx.insert(apiTokens).values({
      id,
      // The token acts as its owner for user-scoped fields, and its power is
      // clamped to theirs on every request, but it is NOT them: what it may do
      // is the set below, chosen here and editable later.
      userId,
      name,
      prefix: raw.slice(0, 12),
      tokenHash: sha256Hex(raw),
      instanceAdmin,
      scoped,
      expiresAt,
      lastUsedAt: null,
      createdAt,
    });
    await tx
      .insert(apiTokenCapabilities)
      .values(capabilities.map((c) => ({ tokenId: id, capability: c })));
    await writeScope(tx, id, scope);
  });

  // Every team the credential can act in learns that it exists: the trail is
  // how a team knows who holds API access here, since it never sees the token.
  await trail(reach, `Created the ${name} API token`, "token_created");
  return {
    raw,
    token: {
      id,
      name,
      prefix: raw.slice(0, 12),
      capabilities,
      scoped,
      teamIds: scope.teamIds,
      projectIds: scope.projectIds,
      folderIds: scope.folderIds,
      appIds: scope.appIds,
      teamsReached: await namedTeams(reach),
      instanceAdmin,
      // Set by `mintMcpConnection` right after this, in the same flow, when the
      // mint came from an OAuth consent rather than from the tokens page.
      oauthClientName: null,
      mcp: false,
      expiresAt,
      // Refused if it were not (see cleanExpiry).
      expired: false,
      lastUsedAt: null,
      createdAt,
    },
  };
}

// updateToken - re-scope a live token without re-minting it.
export async function updateToken(
  input: {
    id: string;
    name: string;
    capabilities?: Capability[];
    instanceAdmin?: boolean;
    // ABSENT leaves the expiry alone; `null` clears it (back to never), so an
    // older client renaming a token cannot silently un-expire it.
    expiresAt?: string | null;
  } & TokenScopeInput,
): Promise<void> {
  const { id: userId } = await assertUser();
  requireOwnOrSession(input.id);
  const name = cleanTokenName(input.name);
  const { scoped, instanceAdmin } = await validateScope(input);
  const expiresAt =
    input.expiresAt === undefined ? undefined : cleanExpiry(input.expiresAt);
  await assertExpiryWithinActingToken(expiresAt);
  const scope = await resolveScopeInput(input, userId);
  assertScopeWithinActingToken(scope, scoped);

  const db = getDb();
  // Read and gate BEFORE opening the transaction: these helpers query on their
  // own connection, and pglite deadlocks if that happens inside one.
  // Somebody else's token resolves to nothing, the same "not found" a made-up id
  // gets: its existence is its owner's business.
  const existing = (
    await db
      .select({ instanceAdmin: apiTokens.instanceAdmin })
      .from(apiTokens)
      .where(and(eq(apiTokens.id, input.id), eq(apiTokens.userId, userId)))
      .limit(1)
  )[0];
  if (!existing) throw new Error("Token not found");

  const reach = await reachOf(scope, userId);
  const capabilities = await ownerCeiling(userId, input.capabilities, reach);

  // Keeping the instance-admin bit alive is itself an instance-admin action.
  if (existing.instanceAdmin) await requireInstanceAdmin();

  await db.transaction(async (tx) => {
    await tx
      .update(apiTokens)
      .set({
        name,
        instanceAdmin,
        scoped,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      })
      .where(and(eq(apiTokens.id, input.id), eq(apiTokens.userId, userId)));
    // Whole-set replace on every junction: an edit says what the token grants
    // now, it does not add to what it granted before.
    await tx
      .delete(apiTokenCapabilities)
      .where(eq(apiTokenCapabilities.tokenId, input.id));
    await tx
      .insert(apiTokenCapabilities)
      .values(capabilities.map((c) => ({ tokenId: input.id, capability: c })));
    await tx.delete(apiTokenTeams).where(eq(apiTokenTeams.tokenId, input.id));
    await tx
      .delete(apiTokenProjects)
      .where(eq(apiTokenProjects.tokenId, input.id));
    await tx
      .delete(apiTokenFolders)
      .where(eq(apiTokenFolders.tokenId, input.id));
    await tx.delete(apiTokenApps).where(eq(apiTokenApps.tokenId, input.id));
    await writeScope(tx, input.id, scope);
  });

  await trail(reach, `Updated the ${name} API token`);
}
