import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb, type DbTx } from "../db/client";
import {
  apiTokens,
  apiTokenCapabilities,
  apiTokenProjects,
  projects as projectsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import {
  membershipFor,
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  requireUnscoped,
} from "../membership";
import { withinActor } from "./roles";
import { recordActivity } from "./activity";
import { getCurrentUser } from "../auth";
import { sha256Hex, randomToken } from "../crypto";
import { ALL_CAPABILITIES, type Capability } from "../types";
import type { RequestIdentity } from "../auth/request-context";

/**
 * API tokens — bearer credentials that drive this team over the public API.
 *
 * A token is a PRINCIPAL WITH ITS OWN CAPABILITIES, not an impersonation of the
 * member who minted it. It carries the same forty fine-grained capabilities a
 * Role is built from, plus an optional Project scope and an opt-in
 * instance-admin bit. Its EFFECTIVE power is the intersection of what it was
 * granted and what its creator can still do in the team, resolved live on every
 * request by the clamp in `lib/membership.ts` — so nothing is materialized here,
 * and revoking a person's access blunts every token they ever minted.
 */

const MAX_NAME = 40;

export interface ApiTokenDTO {
  id: string;
  name: string;
  prefix: string;
  /** What the token itself may do — its own set, before the creator clamp. */
  capabilities: Capability[];
  /** True when the token is limited to Projects at all. */
  projectScoped: boolean;
  /** The Projects it is limited to. Meaningful only when `projectScoped`. */
  projectIds: string[];
  instanceAdmin: boolean;
  /** The member it acts as. Its power is clamped to theirs, so name them. */
  createdByUsername: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** The non-secret projection — never selects `token_hash` (relational-store PLAN §1 "Secrets"). */
const DTO_COLUMNS = {
  id: apiTokens.id,
  name: apiTokens.name,
  prefix: apiTokens.prefix,
  projectScoped: apiTokens.projectScoped,
  instanceAdmin: apiTokens.instanceAdmin,
  lastUsedAt: apiTokens.lastUsedAt,
  createdAt: apiTokens.createdAt,
} as const;

export async function listTokens(): Promise<ApiTokenDTO[]> {
  const teamId = await requireActiveTeamId();
  // A project-scoped token must not enumerate the team's OTHER credentials: its
  // capability clamp already stops it minting one, this stops it reading them.
  requireUnscoped("API tokens");
  const rows = await getDb()
    .select({ ...DTO_COLUMNS, createdByUsername: usersTable.username })
    .from(apiTokens)
    .leftJoin(usersTable, eq(usersTable.id, apiTokens.userId))
    .where(eq(apiTokens.teamId, teamId))
    .orderBy(desc(apiTokens.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  // Both junctions in one query each — never per-token (PLAN §6 "batch-load").
  const [caps, scopes] = await Promise.all([
    getDb()
      .select({
        tokenId: apiTokenCapabilities.tokenId,
        capability: apiTokenCapabilities.capability,
      })
      .from(apiTokenCapabilities)
      .where(inArray(apiTokenCapabilities.tokenId, ids)),
    getDb()
      .select({
        tokenId: apiTokenProjects.tokenId,
        projectId: apiTokenProjects.projectId,
      })
      .from(apiTokenProjects)
      .where(inArray(apiTokenProjects.tokenId, ids)),
  ]);
  const capsById = new Map<string, Capability[]>();
  for (const c of caps)
    capsById.set(c.tokenId, [
      ...(capsById.get(c.tokenId) ?? []),
      c.capability as Capability,
    ]);
  const scopeById = new Map<string, string[]>();
  for (const s of scopes)
    scopeById.set(s.tokenId, [...(scopeById.get(s.tokenId) ?? []), s.projectId]);

  return rows.map((r) => ({
    ...r,
    capabilities: inCatalogOrder(capsById.get(r.id) ?? []),
    projectIds: scopeById.get(r.id) ?? [],
  }));
}

/**
 * One token by id. Deliberately `listTokens().find(…)` — the same trick
 * `getRole` uses — so there is exactly ONE place that assembles the DTO and its
 * two junctions, and no way for the detail page to disagree with the list.
 */
export async function getToken(id: string): Promise<ApiTokenDTO | null> {
  return (await listTokens()).find((t) => t.id === id) ?? null;
}

/** Returns the raw token ONCE; only the hash is persisted. */
export async function createToken(input: {
  name: string;
  capabilities?: Capability[];
  projectIds?: string[];
  instanceAdmin?: boolean;
}): Promise<{ raw: string; token: ApiTokenDTO }> {
  const { teamId, userId, membership } = await requireCapability("manage_tokens");
  const name = cleanTokenName(input.name);
  const capabilities = withinActor(input.capabilities, membership, "token");
  const { projectScoped, instanceAdmin } = await validateScope(input);

  const raw = `deplo_${randomToken(24)}`;
  const id = newId("tok");
  const createdAt = nowIso();
  const db = getDb();
  const projectIds = await db.transaction(async (tx) => {
    const scope = projectScoped
      ? await projectsInTeam(tx, teamId, input.projectIds ?? [])
      : [];
    await tx.insert(apiTokens).values({
      id,
      teamId,
      // The token acts as its creator for user-scoped fields, and its power is
      // clamped to theirs on every request — but it is NOT them: what it may do
      // is the set below, chosen here and editable later.
      userId,
      name,
      prefix: raw.slice(0, 12),
      tokenHash: sha256Hex(raw),
      instanceAdmin,
      projectScoped,
      lastUsedAt: null,
      createdAt,
    });
    await tx
      .insert(apiTokenCapabilities)
      .values(capabilities.map((c) => ({ tokenId: id, capability: c })));
    if (scope.length > 0)
      await tx
        .insert(apiTokenProjects)
        .values(scope.map((projectId) => ({ tokenId: id, projectId })));
    return scope;
  });

  await recordActivity(
    "member",
    `Created the ${name} API token`,
    await actorUsername(),
    null,
    teamId,
  );
  return {
    raw,
    token: {
      id,
      name,
      prefix: raw.slice(0, 12),
      capabilities,
      projectScoped,
      projectIds,
      instanceAdmin,
      createdByUsername: (await getCurrentUser())?.username ?? null,
      lastUsedAt: null,
      createdAt,
    },
  };
}

/**
 * Re-scope a live token without re-minting it. The secret is untouched, so
 * tightening a token costs one save instead of a rotation across every CI
 * secret, webhook and client config that carries it — and a tightening that
 * costs a rotation is a tightening nobody performs.
 */
export async function updateToken(input: {
  id: string;
  name: string;
  capabilities?: Capability[];
  projectIds?: string[];
  instanceAdmin?: boolean;
}): Promise<void> {
  const { teamId, membership } = await requireCapability("manage_tokens");
  const name = cleanTokenName(input.name);
  const capabilities = withinActor(input.capabilities, membership, "token");
  const { projectScoped, instanceAdmin } = await validateScope(input);

  const db = getDb();
  // Read and gate BEFORE opening the transaction: these helpers query on their
  // own connection, and pglite deadlocks if that happens inside one.
  const existing = (
    await db
      .select({ instanceAdmin: apiTokens.instanceAdmin })
      .from(apiTokens)
      .where(and(eq(apiTokens.id, input.id), eq(apiTokens.teamId, teamId)))
      .limit(1)
  )[0];
  if (!existing) throw new Error("Token not found");
  // Editing an instance-admin token is itself an instance-admin action: a plain
  // manage_tokens holder must not be able to rename it, re-scope it, or keep the
  // bit alive under a permission set of their own choosing.
  if (existing.instanceAdmin) await requireInstanceAdmin();

  await db.transaction(async (tx) => {
    const scope = projectScoped
      ? await projectsInTeam(tx, teamId, input.projectIds ?? [])
      : [];
    await tx
      .update(apiTokens)
      .set({ name, instanceAdmin, projectScoped })
      .where(and(eq(apiTokens.id, input.id), eq(apiTokens.teamId, teamId)));
    // Whole-set replace on both junctions: an edit says what the token grants
    // now, it does not add to what it granted before.
    await tx
      .delete(apiTokenCapabilities)
      .where(eq(apiTokenCapabilities.tokenId, input.id));
    await tx
      .insert(apiTokenCapabilities)
      .values(capabilities.map((c) => ({ tokenId: input.id, capability: c })));
    await tx
      .delete(apiTokenProjects)
      .where(eq(apiTokenProjects.tokenId, input.id));
    if (scope.length > 0)
      await tx
        .insert(apiTokenProjects)
        .values(scope.map((projectId) => ({ tokenId: input.id, projectId })));
  });

  await recordActivity(
    "member",
    `Updated the ${name} API token`,
    await actorUsername(),
    null,
    teamId,
  );
}

/**
 * Resolve an incoming `deplo_…` bearer token to the identity the whole data
 * layer runs under, or null if it does not match a live token. Bumps
 * `lastUsedAt`. Never throws for an unknown token (an unmet 2FA policy on the
 * creator does throw, deliberately — see `membershipFor`).
 */
export async function authenticateToken(
  raw: string,
): Promise<RequestIdentity | null> {
  if (!raw.startsWith("deplo_")) return null;
  const hash = sha256Hex(raw);
  const rows = await getDb()
    .select({
      id: apiTokens.id,
      userId: apiTokens.userId,
      teamId: apiTokens.teamId,
      instanceAdmin: apiTokens.instanceAdmin,
      projectScoped: apiTokens.projectScoped,
    })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hash))
    .limit(1);
  const match = rows[0];
  if (!match) return null;
  // Fail CLOSED on a stale token: if its creator has since left (or been
  // removed from) the token's team, the token stops resolving — it must never
  // re-scope the request to another of the user's teams.
  //
  // Note this runs OUTSIDE runWithIdentity, so `membershipFor` sees the member's
  // UNCLAMPED set. That is correct — this is a liveness check, and clamping it
  // with the very token being authenticated would be circular.
  if (!(await membershipFor(match.userId, match.teamId))) return null;

  const [caps, scope] = await Promise.all([
    getDb()
      .select({ capability: apiTokenCapabilities.capability })
      .from(apiTokenCapabilities)
      .where(eq(apiTokenCapabilities.tokenId, match.id)),
    match.projectScoped
      ? getDb()
          .select({ projectId: apiTokenProjects.projectId })
          .from(apiTokenProjects)
          .where(eq(apiTokenProjects.tokenId, match.id))
      : Promise.resolve([]),
  ]);

  // Fire-and-forget usage stamp; a failed write must not block the request.
  void getDb()
    .update(apiTokens)
    .set({ lastUsedAt: nowIso() })
    .where(eq(apiTokens.id, match.id))
    .catch(() => {
      /* usage tracking is best-effort */
    });

  return {
    userId: match.userId,
    teamId: match.teamId,
    token: {
      id: match.id,
      capabilities: inCatalogOrder(caps.map((c) => c.capability as Capability)),
      // A scoped token whose projects were all deleted keeps an EMPTY scope, not
      // a missing one: `[]` reaches nothing, `null` would silently promote it
      // back to the whole team.
      projectIds: match.projectScoped ? scope.map((s) => s.projectId) : null,
      // Belt and braces for a hand-edited row: the two are mutually exclusive,
      // because an instance-admin gate never consults team capabilities and so
      // could not be narrowed by a project scope anyway.
      instanceAdmin: match.instanceAdmin && !match.projectScoped,
    },
  };
}

export async function revokeToken(id: string): Promise<void> {
  const { teamId } = await requireCapability("manage_tokens");
  const gone = await getDb()
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.teamId, teamId)))
    .returning({ id: apiTokens.id, name: apiTokens.name });
  if (gone.length === 0) throw new Error("Token not found");
  await recordActivity(
    "member",
    `Revoked the ${gone[0].name} API token`,
    await actorUsername(),
    null,
    teamId,
  );
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function cleanTokenName(raw: string): string {
  const name = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Give the token a name");
  if (name.length > MAX_NAME)
    throw new Error(`Keep the token name under ${MAX_NAME} characters`);
  return name;
}

function inCatalogOrder(caps: Capability[]): Capability[] {
  const set = new Set(caps);
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

/**
 * Decide the two orthogonal switches, refusing the combination that cannot mean
 * what it says. Instance-admin gates read the user's admin flag and nothing
 * else, so a project scope could not narrow one — offering both would be a
 * switch that lies. Runs its gates BEFORE any transaction is opened (a data
 * function that queries on its own connection inside one deadlocks pglite).
 */
async function validateScope(input: {
  projectIds?: string[];
  instanceAdmin?: boolean;
}): Promise<{ projectScoped: boolean; instanceAdmin: boolean }> {
  const projectScoped = (input.projectIds?.length ?? 0) > 0;
  const instanceAdmin = input.instanceAdmin ?? false;
  if (instanceAdmin && projectScoped)
    throw new Error(
      "A token limited to projects can't administer the instance. Pick one.",
    );
  // Only an instance admin can hand out instance administration.
  if (instanceAdmin) await requireInstanceAdmin();
  return { projectScoped, instanceAdmin };
}

/** Never trust a client-supplied project id: every one must be in this team. */
async function projectsInTeam(
  tx: DbTx,
  teamId: string,
  ids: string[],
): Promise<string[]> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return [];
  const rows = await tx
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(
      and(eq(projectsTable.teamId, teamId), inArray(projectsTable.id, wanted)),
    );
  if (rows.length !== wanted.length)
    throw new Error("One of those projects isn't in this team");
  return rows.map((r) => r.id);
}

async function actorUsername(): Promise<string> {
  return (await getCurrentUser())?.username ?? "an admin";
}
