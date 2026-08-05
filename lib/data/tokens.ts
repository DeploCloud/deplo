import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { getDb, type DbTx } from "../db/client";
import {
  apiTokens,
  apiTokenCapabilities,
  apiTokenTeams,
  apiTokenProjects,
  apiTokenFolders,
  apiTokenApps,
  apps as appsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  projects as projectsTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import {
  membershipFor,
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  requireUnscoped,
  teamsForUser,
} from "../membership";
import { withinActor } from "./roles";
import { visibleFolderIds } from "./folder-access";
import { appCapabilitiesForTeam } from "./node-access";
import { recordActivity } from "./activity";
import { assertUser, getCurrentUser } from "../auth";
import { sha256Hex, randomToken } from "../crypto";
import { ALL_CAPABILITIES, type Capability } from "../types";
import type { RequestIdentity, TokenScope } from "../auth/request-context";

/**
 * API tokens — bearer credentials that drive deplo's API from outside the
 * dashboard.
 *
 * A token is a PRINCIPAL WITH ITS OWN CAPABILITIES, not an impersonation of the
 * member who minted it, and its reach is a TREE: whole teams, whole projects,
 * or individual apps, ticked at whatever depth makes sense. Its effective power
 * is the intersection of what it was granted and what its creator can still do
 * in the team the request resolves to, computed live on every request by the
 * clamp in `lib/membership.ts` — so nothing is materialized here, and revoking a
 * person's access blunts every token they ever minted.
 *
 * Breadth and depth are separate questions. Naming several teams restricts
 * nothing inside them. Naming a project or an app inside a team is what strips
 * that team's team-wide capabilities, because there is no per-project version of
 * "manage members".
 */

const MAX_NAME = 40;

export interface ApiTokenDTO {
  id: string;
  name: string;
  prefix: string;
  /** What the token itself may do — its own set, before the creator clamp. */
  capabilities: Capability[];
  /** False ⇒ every team its creator belongs to, and everything in it. */
  scoped: boolean;
  /** Whole teams in the scope. */
  teamIds: string[];
  /** Whole projects in the scope. */
  projectIds: string[];
  /** Whole folders in the scope (their subtrees come with them). */
  folderIds: string[];
  /** Individually-named apps in the scope. */
  appIds: string[];
  instanceAdmin: boolean;
  /** The team this token is MANAGED from — where it was created. */
  homeTeamId: string;
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
  scoped: apiTokens.scoped,
  instanceAdmin: apiTokens.instanceAdmin,
  homeTeamId: apiTokens.teamId,
  lastUsedAt: apiTokens.lastUsedAt,
  createdAt: apiTokens.createdAt,
} as const;

/**
 * Every token that can act in `teamId` — not merely the ones created there.
 *
 * A token's scope tree can span teams, so the team it was minted in is not the
 * only team it touches. A team that cannot SEE a credential operating inside it
 * cannot revoke it either, and "remove the person from the team" is too blunt an
 * instrument to be the only lever. Five indexed lookups, unioned in memory.
 */
async function tokenIdsReaching(teamId: string): Promise<Set<string>> {
  const db = getDb();
  const [byTeam, byProject, byFolder, byApp, unscoped] = await Promise.all([
    db
      .select({ id: apiTokenTeams.tokenId })
      .from(apiTokenTeams)
      .where(eq(apiTokenTeams.teamId, teamId)),
    db
      .select({ id: apiTokenProjects.tokenId })
      .from(apiTokenProjects)
      .innerJoin(projectsTable, eq(projectsTable.id, apiTokenProjects.projectId))
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({ id: apiTokenFolders.tokenId })
      .from(apiTokenFolders)
      .innerJoin(foldersTable, eq(foldersTable.id, apiTokenFolders.folderId))
      .where(eq(foldersTable.teamId, teamId)),
    db
      .select({ id: apiTokenApps.tokenId })
      .from(apiTokenApps)
      .innerJoin(appsTable, eq(appsTable.id, apiTokenApps.appId))
      .where(eq(appsTable.teamId, teamId)),
    // An unrestricted token reaches every team its CREATOR belongs to, so it
    // shows up wherever they are a member.
    db
      .select({ id: apiTokens.id })
      .from(apiTokens)
      .innerJoin(
        membershipsTable,
        eq(membershipsTable.userId, apiTokens.userId),
      )
      .where(
        and(eq(apiTokens.scoped, false), eq(membershipsTable.teamId, teamId)),
      ),
  ]);
  return new Set(
    [...byTeam, ...byProject, ...byFolder, ...byApp, ...unscoped].map((r) => r.id),
  );
}

export async function listTokens(): Promise<ApiTokenDTO[]> {
  const teamId = await requireActiveTeamId();
  // A narrowed token must not enumerate the team's OTHER credentials: its
  // capability clamp already stops it minting one, this stops it reading them.
  requireUnscoped("API tokens");
  const reaching = await tokenIdsReaching(teamId);
  if (reaching.size === 0) return [];
  const rows = await getDb()
    .select({ ...DTO_COLUMNS, createdByUsername: usersTable.username })
    .from(apiTokens)
    .leftJoin(usersTable, eq(usersTable.id, apiTokens.userId))
    .where(inArray(apiTokens.id, [...reaching]))
    .orderBy(desc(apiTokens.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  // Every junction in one query each — never per-token (PLAN §6 "batch-load").
  const [caps, teamRows, projRows, folderRows, appRows] = await Promise.all([
    getDb()
      .select({
        tokenId: apiTokenCapabilities.tokenId,
        value: apiTokenCapabilities.capability,
      })
      .from(apiTokenCapabilities)
      .where(inArray(apiTokenCapabilities.tokenId, ids)),
    getDb()
      .select({ tokenId: apiTokenTeams.tokenId, value: apiTokenTeams.teamId })
      .from(apiTokenTeams)
      .where(inArray(apiTokenTeams.tokenId, ids)),
    getDb()
      .select({
        tokenId: apiTokenProjects.tokenId,
        value: apiTokenProjects.projectId,
      })
      .from(apiTokenProjects)
      .where(inArray(apiTokenProjects.tokenId, ids)),
    getDb()
      .select({
        tokenId: apiTokenFolders.tokenId,
        value: apiTokenFolders.folderId,
      })
      .from(apiTokenFolders)
      .where(inArray(apiTokenFolders.tokenId, ids)),
    getDb()
      .select({ tokenId: apiTokenApps.tokenId, value: apiTokenApps.appId })
      .from(apiTokenApps)
      .where(inArray(apiTokenApps.tokenId, ids)),
  ]);
  const group = (rows: { tokenId: string; value: string }[]) => {
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.tokenId, [...(m.get(r.tokenId) ?? []), r.value]);
    return m;
  };
  const capsById = group(caps);
  const teamsById = group(teamRows);
  const projectsById = group(projRows);
  const foldersById = group(folderRows);
  const appsById = group(appRows);

  return rows.map((r) => ({
    ...r,
    capabilities: inCatalogOrder(
      (capsById.get(r.id) ?? []) as Capability[],
    ),
    teamIds: teamsById.get(r.id) ?? [],
    projectIds: projectsById.get(r.id) ?? [],
    folderIds: foldersById.get(r.id) ?? [],
    appIds: appsById.get(r.id) ?? [],
  }));
}

/**
 * One token by id. Deliberately `listTokens().find(…)` — the same trick
 * `getRole` uses — so there is exactly ONE place that assembles the DTO and its
 * five junctions, and no way for the detail page to disagree with the list.
 */
export async function getToken(id: string): Promise<ApiTokenDTO | null> {
  return (await listTokens()).find((t) => t.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* The scope tree (what the editor picks from)                         */
/* ------------------------------------------------------------------ */

export interface ScopeTreeApp {
  id: string;
  name: string;
  slug: string;
  /** The app's own logo, when it has one. Null falls back to a generic glyph. */
  logo: string | null;
}
export interface ScopeTreeFolder {
  id: string;
  name: string;
  color: string | null;
  folders: ScopeTreeFolder[];
  apps: ScopeTreeApp[];
}
export interface ScopeTreeProject {
  id: string;
  name: string;
  color: string | null;
  folders: ScopeTreeFolder[];
  apps: ScopeTreeApp[];
}
export interface ScopeTreeTeam {
  id: string;
  name: string;
  projects: ScopeTreeProject[];
  /** Folders at the team top level, in no project. */
  folders: ScopeTreeFolder[];
  /** Apps of this team in no folder and no project. */
  looseApps: ScopeTreeApp[];
}

/**
 * Every team the CURRENT USER belongs to, with its projects, its folders and
 * their apps — the tree the scope picker draws.
 *
 * Folders are first-class here because they are where apps actually live: filing
 * an app into a folder CLEARS its `project_id`, so a tree without them showed
 * nearly everything as "outside a project", which was both useless and untrue.
 * A folder is placed under its parent when it has one, else under its project,
 * else at the team top level — the same arrangement the Overview shows.
 *
 * Deliberately not filtered to the active team: a token may span teams, and you
 * can only give it what you can reach yourself. That is also the bound — the
 * tree is built from the user's own memberships, so a picker can never offer a
 * team the actor isn't in.
 */
export async function listScopeTree(): Promise<ScopeTreeTeam[]> {
  // Deliberately NOT gated on `manage_tokens`: a member without it still opens a
  // token page (read-only, like the roles page), and the tree holds nothing they
  // can't already see. A narrowed token is refused: it must not enumerate the
  // teams its creator belongs to.
  const user = await assertUser();
  requireUnscoped("the token scope picker");
  // Their memberships bound WHICH teams; per-node access bounds what shows up
  // inside one. Team membership alone is not enough — a folder is private to its
  // owner and grantees, and a picker that listed every private folder (and the
  // apps in it) by name would disclose exactly what the folder exists to hide.
  return buildScopeTree(await teamsForUser(user.id), { asCaller: true });
}

/**
 * The tree for an explicit set of teams. Split out of {@link listScopeTree} so
 * the instance-admin user editor can build the same picker rooted at SOMEONE
 * ELSE's memberships — it carries no gate of its own, so every caller supplies
 * the teams it has already decided the actor may see.
 */
export async function buildScopeTree(
  mine: { id: string; name: string }[],
  opts: { asCaller?: boolean } = {},
): Promise<ScopeTreeTeam[]> {
  if (mine.length === 0) return [];
  const teamIds = mine.map((t) => t.id);

  const db = getDb();
  const [projectRows, folderRows, appRows] = await Promise.all([
    db
      .select({
        id: projectsTable.id,
        teamId: projectsTable.teamId,
        name: projectsTable.name,
        color: projectsTable.color,
      })
      .from(projectsTable)
      .where(inArray(projectsTable.teamId, teamIds)),
    db
      .select({
        id: foldersTable.id,
        teamId: foldersTable.teamId,
        parentId: foldersTable.parentId,
        projectId: foldersTable.projectId,
        name: foldersTable.name,
        color: foldersTable.color,
      })
      .from(foldersTable)
      .where(inArray(foldersTable.teamId, teamIds)),
    db
      .select({
        id: appsTable.id,
        teamId: appsTable.teamId,
        projectId: appsTable.projectId,
        folderId: appsTable.folderId,
        name: appsTable.name,
        slug: appsTable.slug,
        logo: appsTable.logo,
      })
      .from(appsTable)
      .where(inArray(appsTable.teamId, teamIds)),
  ]);

  // Per-node visibility, when the tree is the CALLER's own picker: a folder they
  // can't see, and an app they hold nothing on, must not be listed — the same
  // answer `listFolders` and `listApps` give. The instance-admin user editor
  // passes nothing and keeps the full tree, which is what an admin already sees.
  const { folders: visibleFolders, apps: visibleApps } = opts.asCaller
    ? await visibleNodes(teamIds, folderRows, appRows)
    : { folders: null, apps: null };
  const folderVisible = (id: string) => !visibleFolders || visibleFolders.has(id);
  const appVisible = (id: string) => !visibleApps || visibleApps.has(id);

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);

  /** Apps keyed by the ONE container they live in (folder, else project, else team). */
  const appsIn = new Map<string, ScopeTreeApp[]>();
  for (const a of appRows) {
    if (!appVisible(a.id)) continue;
    const key = a.folderId ?? a.projectId ?? a.teamId;
    appsIn.set(key, [
      ...(appsIn.get(key) ?? []),
      { id: a.id, name: a.name, slug: a.slug, logo: a.logo ?? null },
    ]);
  }
  /** Child folders keyed by their parent folder id. */
  const subfoldersOf = new Map<string, typeof folderRows>();
  for (const f of folderRows)
    if (f.parentId && folderVisible(f.id))
      subfoldersOf.set(f.parentId, [...(subfoldersOf.get(f.parentId) ?? []), f]);

  // Cycle-safe, like every other walk over this tree: a stale parent chain must
  // not hang the page.
  const build = (
    f: (typeof folderRows)[number],
    seen: Set<string>,
  ): ScopeTreeFolder => {
    seen.add(f.id);
    return {
      id: f.id,
      name: f.name,
      color: f.color ?? null,
      folders: (subfoldersOf.get(f.id) ?? [])
        .filter((c) => !seen.has(c.id))
        .sort(byName)
        .map((c) => build(c, seen)),
      apps: (appsIn.get(f.id) ?? []).sort(byName),
    };
  };
  const rootFolders = (predicate: (f: (typeof folderRows)[number]) => boolean) =>
    folderRows
      .filter((f) => !f.parentId && folderVisible(f.id) && predicate(f))
      .sort(byName)
      .map((f) => build(f, new Set()));

  return mine.map((t) => ({
    id: t.id,
    name: t.name,
    projects: projectRows
      .filter((p) => p.teamId === t.id)
      .sort(byName)
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color ?? null,
        folders: rootFolders((f) => f.projectId === p.id),
        apps: (appsIn.get(p.id) ?? []).sort(byName),
      })),
    folders: rootFolders((f) => f.teamId === t.id && !f.projectId),
    looseApps: (appsIn.get(t.id) ?? []).sort(byName),
  }));
}

/**
 * The folder and app ids the CURRENT caller may see, across several teams — the
 * per-node half of the picker's bound.
 *
 * Six queries per team (one `visibleFolderIds`, one batched
 * `appCapabilitiesForTeam`), not one per node: a picker draws the whole fleet.
 */
async function visibleNodes(
  teamIds: string[],
  folderRows: { id: string; teamId: string }[],
  appRows: {
    id: string;
    teamId: string;
    projectId: string | null;
    folderId: string | null;
  }[],
): Promise<{ folders: Set<string>; apps: Set<string> }> {
  const folders = new Set<string>();
  const apps = new Set<string>();
  for (const teamId of teamIds) {
    try {
      const seen = await visibleFolderIds(teamId);
      for (const f of folderRows)
        if (f.teamId === teamId && (seen === "all" || seen.has(f.id)))
          folders.add(f.id);
      const reach = await appCapabilitiesForTeam(
        teamId,
        appRows
          .filter((a) => a.teamId === teamId)
          .map((a) => ({
            id: a.id,
            folderId: a.folderId ?? null,
            projectId: a.projectId ?? null,
          })),
      );
      for (const [id, caps] of reach) if (caps.length > 0) apps.add(id);
    } catch {
      // A team the caller can't currently resolve at all — an unmet two-factor
      // policy is the live example. It contributes nothing rather than taking
      // down the whole picker: they could not use that team's nodes anyway.
    }
  }
  return { folders, apps };
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

export interface TokenScopeInput {
  /** Whole teams. */
  teamIds?: string[];
  /** Whole projects. */
  projectIds?: string[];
  /** Whole folders (their subtrees come with them). */
  folderIds?: string[];
  /** Individual apps. */
  appIds?: string[];
}

/** Returns the raw token ONCE; only the hash is persisted. */
export async function createToken(
  input: { name: string; capabilities?: Capability[]; instanceAdmin?: boolean } &
    TokenScopeInput,
): Promise<{ raw: string; token: ApiTokenDTO }> {
  const { teamId, userId, membership } = await requireCapability("manage_tokens");
  const name = cleanTokenName(input.name);
  const capabilities = withinActor(input.capabilities, membership, "token");
  const { scoped, instanceAdmin } = await validateScope(input);
  const scope = await resolveScopeInput(input, userId);

  const raw = `deplo_${randomToken(24)}`;
  const id = newId("tok");
  const createdAt = nowIso();
  await getDb().transaction(async (tx) => {
    await tx.insert(apiTokens).values({
      id,
      // The team it is MANAGED from. Its reach is the scope below, which may be
      // wider — but exactly one team owns the row that can edit it.
      teamId,
      // The token acts as its creator for user-scoped fields, and its power is
      // clamped to theirs on every request — but it is NOT them: what it may do
      // is the set below, chosen here and editable later.
      userId,
      name,
      prefix: raw.slice(0, 12),
      tokenHash: sha256Hex(raw),
      instanceAdmin,
      scoped,
      lastUsedAt: null,
      createdAt,
    });
    await tx
      .insert(apiTokenCapabilities)
      .values(capabilities.map((c) => ({ tokenId: id, capability: c })));
    await writeScope(tx, id, scope);
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
      scoped,
      teamIds: scope.teamIds,
      projectIds: scope.projectIds,
      folderIds: scope.folderIds,
      appIds: scope.appIds,
      instanceAdmin,
      homeTeamId: teamId,
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
 *
 * Editable only from the team it was created in: a token can reach several
 * teams, and re-authoring one from a team that merely happens to be in its scope
 * would let that team's admin quietly cut another team's automation. Any team it
 * reaches can still REVOKE it, which is the lever that matters.
 */
export async function updateToken(
  input: { id: string; name: string; capabilities?: Capability[]; instanceAdmin?: boolean } &
    TokenScopeInput,
): Promise<void> {
  const { teamId, userId, membership } = await requireCapability("manage_tokens");
  const name = cleanTokenName(input.name);
  const capabilities = withinActor(input.capabilities, membership, "token");
  const { scoped, instanceAdmin } = await validateScope(input);
  const scope = await resolveScopeInput(input, userId);

  const db = getDb();
  // Read and gate BEFORE opening the transaction: these helpers query on their
  // own connection, and pglite deadlocks if that happens inside one.
  const existing = (
    await db
      .select({
        instanceAdmin: apiTokens.instanceAdmin,
        homeTeamId: apiTokens.teamId,
        createdByUserId: apiTokens.userId,
      })
      .from(apiTokens)
      .where(eq(apiTokens.id, input.id))
      .limit(1)
  )[0];
  if (!existing) throw new Error("Token not found");
  if (existing.homeTeamId !== teamId) {
    // Don't leak that it exists to a team it can't reach at all.
    if (!(await tokenIdsReaching(teamId)).has(input.id))
      throw new Error("Token not found");
    throw new Error(
      "This token is managed in the team it was created in. You can revoke it here, but not change it.",
    );
  }
  // Editing an instance-admin token is itself an instance-admin action: a plain
  // manage_tokens holder must not be able to rename it, re-scope it, or keep the
  // bit alive under a permission set of their own choosing.
  if (existing.instanceAdmin) await requireInstanceAdmin();
  // Re-authoring SOMEONE ELSE's token: the live clamp only measures it against
  // its creator, so bound the edit by the actor's own capabilities in every team
  // this token will reach.
  if (existing.createdByUserId !== userId)
    await assertWithinActorEverywhere(
      capabilities,
      userId,
      teamId,
      scoped
        ? scope.teamsReached
        : (await teamsForUser(existing.createdByUserId)).map((t) => t.id),
    );

  await db.transaction(async (tx) => {
    await tx
      .update(apiTokens)
      .set({ name, instanceAdmin, scoped })
      .where(and(eq(apiTokens.id, input.id), eq(apiTokens.teamId, teamId)));
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
 * layer runs under, or null if it does not match a live token.
 *
 * `teamHint` picks WHICH of the token's teams this request acts in (the
 * `X-Deplo-Team` header, or the owning team of a deploy hook's app); an absent
 * or unreachable hint falls back to the first team in scope, deterministically.
 * Bumps `lastUsedAt`. Never throws for an unknown token (an unmet 2FA policy on
 * the creator does throw, deliberately — see `membershipFor`).
 */
export async function authenticateToken(
  raw: string,
  teamHint?: string | null,
): Promise<RequestIdentity | null> {
  if (!raw.startsWith("deplo_")) return null;
  const hash = sha256Hex(raw);
  const rows = await getDb()
    .select({
      id: apiTokens.id,
      userId: apiTokens.userId,
      teamId: apiTokens.teamId,
      instanceAdmin: apiTokens.instanceAdmin,
      scoped: apiTokens.scoped,
    })
    .from(apiTokens)
    .where(eq(apiTokens.tokenHash, hash))
    .limit(1);
  const match = rows[0];
  if (!match) return null;

  const scope = match.scoped ? await loadScope(match.id) : null;

  // Fail CLOSED: the token acts only in teams its creator is STILL a member of,
  // so losing a membership silently narrows every token that person minted, and
  // losing the last one stops the token resolving at all.
  const mine = await teamsForUser(match.userId);
  const reachable = scope
    ? mine.filter((t) => scope.teamIds.includes(t.id))
    : mine;
  if (reachable.length === 0) return null;
  const picked =
    (teamHint &&
      reachable.find((t) => t.id === teamHint || t.slug === teamHint)) ||
    reachable[0];

  // The 2FA / membership guard, on the team the request actually resolved to.
  // Runs OUTSIDE runWithIdentity, so `membershipFor` sees the member's UNCLAMPED
  // set — correct, and it must stay that way: clamping it with the very token
  // being authenticated would be circular.
  if (!(await membershipFor(match.userId, picked.id))) return null;

  const caps = await getDb()
    .select({ capability: apiTokenCapabilities.capability })
    .from(apiTokenCapabilities)
    .where(eq(apiTokenCapabilities.tokenId, match.id));

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

export async function revokeToken(id: string): Promise<void> {
  const { teamId } = await requireCapability("manage_tokens");
  // Any team the token can act in may cut it off — that is the lever a team has
  // over a credential someone else minted into it.
  if (!(await tokenIdsReaching(teamId)).has(id))
    throw new Error("Token not found");
  const gone = await getDb()
    .delete(apiTokens)
    .where(eq(apiTokens.id, id))
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

/** The three ticked-node lists, validated and de-duplicated. */
interface ResolvedScope {
  teamIds: string[];
  projectIds: string[];
  folderIds: string[];
  appIds: string[];
  /**
   * Every team the ticked nodes put in reach — the whole teams plus the owning
   * team of each project, folder and app. All of them are teams the ACTOR
   * belongs to (that is what {@link resolveScopeInput} validates), so this is
   * what {@link assertWithinActorEverywhere} measures the edit against.
   */
  teamsReached: string[];
}

/**
 * Decide the two orthogonal switches, refusing the combination that cannot mean
 * what it says. Instance-admin gates read the user's admin flag and nothing
 * else, so a scope could not narrow one — offering both would be a switch that
 * lies. Runs its gates BEFORE any transaction is opened (a data function that
 * queries on its own connection inside one deadlocks pglite).
 */
async function validateScope(
  input: { instanceAdmin?: boolean } & TokenScopeInput,
): Promise<{ scoped: boolean; instanceAdmin: boolean }> {
  const scoped =
    (input.teamIds?.length ?? 0) +
      (input.projectIds?.length ?? 0) +
      (input.folderIds?.length ?? 0) +
      (input.appIds?.length ?? 0) >
    0;
  const instanceAdmin = input.instanceAdmin ?? false;
  if (instanceAdmin && scoped)
    throw new Error(
      "A token limited to teams, projects or apps can't administer the instance. Pick one.",
    );
  // Only an instance admin can hand out instance administration.
  if (instanceAdmin) await requireInstanceAdmin();
  return { scoped, instanceAdmin };
}

/**
 * Validate every ticked node against what the ACTOR can reach. You can only put
 * a team in a token's scope if you are in that team, and a project or app only
 * if it lives in one of those teams — otherwise the scope picker would be a way
 * to discover, and reach into, teams you don't belong to.
 */
async function resolveScopeInput(
  input: TokenScopeInput,
  userId: string,
): Promise<ResolvedScope> {
  const teamIds = [...new Set(input.teamIds ?? [])];
  const projectIds = [...new Set(input.projectIds ?? [])];
  const folderIds = [...new Set(input.folderIds ?? [])];
  const appIds = [...new Set(input.appIds ?? [])];
  if (teamIds.length + projectIds.length + folderIds.length + appIds.length === 0)
    return {
      teamIds: [],
      projectIds: [],
      folderIds: [],
      appIds: [],
      teamsReached: [],
    };

  const mine = new Set((await teamsForUser(userId)).map((t) => t.id));
  for (const id of teamIds)
    if (!mine.has(id)) throw new Error("You're not a member of one of those teams");
  const reached = new Set<string>(teamIds);

  const db = getDb();
  if (projectIds.length > 0) {
    const rows = await db
      .select({ id: projectsTable.id, teamId: projectsTable.teamId })
      .from(projectsTable)
      .where(inArray(projectsTable.id, projectIds));
    if (rows.length !== projectIds.length || rows.some((r) => !mine.has(r.teamId)))
      throw new Error("One of those projects isn't in a team you belong to");
    for (const r of rows) reached.add(r.teamId);
  }
  if (folderIds.length > 0) {
    const rows = await db
      .select({ id: foldersTable.id, teamId: foldersTable.teamId })
      .from(foldersTable)
      .where(inArray(foldersTable.id, folderIds));
    if (rows.length !== folderIds.length || rows.some((r) => !mine.has(r.teamId)))
      throw new Error("One of those folders isn't in a team you belong to");
    for (const r of rows) reached.add(r.teamId);
  }
  if (appIds.length > 0) {
    const rows = await db
      .select({ id: appsTable.id, teamId: appsTable.teamId })
      .from(appsTable)
      .where(inArray(appsTable.id, appIds));
    if (rows.length !== appIds.length || rows.some((r) => !mine.has(r.teamId)))
      throw new Error("One of those apps isn't in a team you belong to");
    for (const r of rows) reached.add(r.teamId);
  }
  return { teamIds, projectIds, folderIds, appIds, teamsReached: [...reached] };
}

/**
 * Bound a token edit by what the ACTOR may do in every team the token will act
 * in — not merely in the team it is managed from.
 *
 * The live clamp measures a token against its CREATOR, so it says nothing about
 * whoever re-authors it later. Without this, an admin of the home team could
 * hand someone else's credential capabilities they do not hold themselves in
 * another team that token reaches: a `manage_tokens` holder who is a plain
 * viewer in team B could point Alice's token at B with `delete_apps` on it, and
 * the runtime clamp — which only asks about Alice — would let it through.
 *
 * Only runs when the actor is not the creator; editing your own token is already
 * bounded, in every team, by the clamp against yourself. A token the actor
 * cannot measure at all (an unrestricted one whose creator belongs to teams the
 * actor doesn't) is refused rather than silently gutted: revoking it is the
 * lever a team has over a credential it can't author.
 */
async function assertWithinActorEverywhere(
  capabilities: Capability[],
  actorUserId: string,
  homeTeamId: string,
  reach: string[],
): Promise<void> {
  for (const teamId of reach) {
    // The home team is already bounded by the `withinActor` call at the top.
    if (teamId === homeTeamId) continue;
    const membership = await membershipFor(actorUserId, teamId);
    if (!membership)
      throw new Error(
        "This token can act in a team you're not a member of. You can revoke it here, but not change what it may do.",
      );
    withinActor(capabilities, membership, "token");
  }
}

async function writeScope(
  tx: DbTx,
  tokenId: string,
  scope: ResolvedScope,
): Promise<void> {
  if (scope.teamIds.length > 0)
    await tx
      .insert(apiTokenTeams)
      .values(scope.teamIds.map((teamId) => ({ tokenId, teamId })));
  if (scope.projectIds.length > 0)
    await tx
      .insert(apiTokenProjects)
      .values(scope.projectIds.map((projectId) => ({ tokenId, projectId })));
  if (scope.folderIds.length > 0)
    await tx
      .insert(apiTokenFolders)
      .values(scope.folderIds.map((folderId) => ({ tokenId, folderId })));
  if (scope.appIds.length > 0)
    await tx
      .insert(apiTokenApps)
      .values(scope.appIds.map((appId) => ({ tokenId, appId })));
}

/**
 * Flatten a stored scope for the request identity.
 *
 * The team set is DERIVED — a project knows its team, a folder knows its team,
 * an app knows its team — so a node deleted anywhere simply drops out of the
 * join and the token narrows instead of widening.
 *
 * Folders are EXPANDED here rather than stored expanded: a ticked folder brings
 * its whole subtree, and a ticked project brings every folder filed under it (an
 * app in a folder has no `project_id` of its own, so without this a project
 * scope would miss most of what people mean by it). Doing it per authentication
 * means moving or nesting a folder takes effect on the very next request, with
 * nothing to re-materialize.
 */
async function loadScope(tokenId: string): Promise<TokenScope> {
  const db = getDb();
  const [teamRows, projRows, folderRows, appRows] = await Promise.all([
    db
      .select({ teamId: apiTokenTeams.teamId })
      .from(apiTokenTeams)
      .innerJoin(teamsTable, eq(teamsTable.id, apiTokenTeams.teamId))
      .where(eq(apiTokenTeams.tokenId, tokenId)),
    db
      .select({ id: projectsTable.id, teamId: projectsTable.teamId })
      .from(apiTokenProjects)
      .innerJoin(projectsTable, eq(projectsTable.id, apiTokenProjects.projectId))
      .where(eq(apiTokenProjects.tokenId, tokenId)),
    db
      .select({
        id: foldersTable.id,
        teamId: foldersTable.teamId,
        projectId: foldersTable.projectId,
      })
      .from(apiTokenFolders)
      .innerJoin(foldersTable, eq(foldersTable.id, apiTokenFolders.folderId))
      .where(eq(apiTokenFolders.tokenId, tokenId)),
    db
      .select({
        id: appsTable.id,
        teamId: appsTable.teamId,
        projectId: appsTable.projectId,
        folderId: appsTable.folderId,
      })
      .from(apiTokenApps)
      .innerJoin(appsTable, eq(appsTable.id, apiTokenApps.appId))
      .where(eq(apiTokenApps.tokenId, tokenId)),
  ]);

  const wholeTeamIds = teamRows.map((r) => r.teamId);
  const projectIds = projRows.map((r) => r.id);
  const teamIds = [
    ...new Set([
      ...wholeTeamIds,
      ...projRows.map((r) => r.teamId),
      ...folderRows.map((r) => r.teamId),
      ...appRows.map((r) => r.teamId),
    ]),
  ];

  const { folderIds, folderProjectIds } = await expandFolders(
    teamIds,
    folderRows.map((r) => r.id),
    projectIds,
  );

  return {
    teamIds,
    wholeTeamIds,
    projectIds,
    folderIds,
    appIds: appRows.map((r) => r.id),
    appProjectIds: [
      ...new Set(
        [
          ...appRows.map((r) => r.projectId),
          ...folderRows.map((r) => r.projectId),
          ...folderProjectIds,
        ].filter((id): id is string => id != null),
      ),
    ],
  };
}

/**
 * Every folder a scope actually reaches: the ticked ones, everything nested
 * under them, and everything filed under a ticked project — plus the projects
 * those folders sit in, so the containers stay navigable.
 *
 * One query for the whole folder set of the token's teams, then a walk in
 * memory: folder trees are small (an Overview a person browses), and this runs
 * once per authentication, not once per query. Cycle-safe by the seen-set, the
 * same tolerance the rest of the folder-tree code applies to a stale parent.
 */
async function expandFolders(
  teamIds: string[],
  ticked: string[],
  scopedProjectIds: string[],
): Promise<{ folderIds: string[]; folderProjectIds: string[] }> {
  if (teamIds.length === 0 || (ticked.length === 0 && scopedProjectIds.length === 0))
    return { folderIds: [], folderProjectIds: [] };
  const rows = await getDb()
    .select({
      id: foldersTable.id,
      parentId: foldersTable.parentId,
      projectId: foldersTable.projectId,
    })
    .from(foldersTable)
    .where(inArray(foldersTable.teamId, teamIds));

  const childrenOf = new Map<string, string[]>();
  for (const f of rows)
    if (f.parentId)
      childrenOf.set(f.parentId, [...(childrenOf.get(f.parentId) ?? []), f.id]);

  // Roots: the ticked folders, plus every folder filed DIRECTLY under a ticked
  // project (their own subtrees follow below).
  const projects = new Set(scopedProjectIds);
  const roots = [
    ...ticked,
    ...rows.filter((f) => f.projectId && projects.has(f.projectId)).map((f) => f.id),
  ];

  const reached = new Set<string>();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const child of childrenOf.get(id) ?? []) stack.push(child);
  }

  const byId = new Map(rows.map((f) => [f.id, f] as const));
  const folderProjectIds = [
    ...new Set(
      ticked
        .map((id) => byId.get(id)?.projectId)
        .filter((id): id is string => id != null),
    ),
  ];
  return { folderIds: [...reached], folderProjectIds };
}

async function actorUsername(): Promise<string> {
  return (await getCurrentUser())?.username ?? "an admin";
}
