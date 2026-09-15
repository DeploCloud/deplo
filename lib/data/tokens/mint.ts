import "server-only";

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

async function reachOf(
  scope: ResolvedScope,
  userId: string,
): Promise<string[]> {
  return scope.teamsReached.length > 0
    ? scope.teamsReached
    : (await tokenReach(userId)).map((t) => t.id);
}

export const DEFAULT_TOKEN_DAYS = 90;

async function defaultExpiry(): Promise<string> {
  const ninety = Date.now() + DEFAULT_TOKEN_DAYS * 24 * 60 * 60 * 1000;
  const parent = await actingTokenExpiry();
  const at = parent ? Math.min(ninety, Date.parse(parent)) : ninety;
  return new Date(at).toISOString();
}

function cleanExpiry(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error("That expiry date is not a date");
  if (at <= Date.now())
    throw new Error("Pick an expiry date in the future, or no expiry at all");
  return new Date(at).toISOString();
}

export async function createToken(
  input: {
    name: string;
    capabilities?: Capability[];
    instanceAdmin?: boolean;
    expiresAt?: string | null;
  } & TokenScopeInput,
): Promise<{ raw: string; token: ApiTokenDTO }> {
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
      oauthClientName: null,
      mcp: false,
      expiresAt,
      expired: false,
      lastUsedAt: null,
      createdAt,
    },
  };
}

export async function updateToken(
  input: {
    id: string;
    name: string;
    capabilities?: Capability[];
    instanceAdmin?: boolean;
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
