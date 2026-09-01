import "server-only";

// https://deplo.build/docs/advanced/api-tokens-and-oauth

import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";

import { getDb, type DbTx } from "../db/client";
import {
  apiTokens,
  apiTokenCapabilities,
  apiTokenTeams,
  apiTokenProjects,
  apiTokenFolders,
  apiTokenApps,
  apps as appsTable,
  environments as environmentsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  projects as projectsTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import {
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from "../db/schema/auth";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "../auth/oauth-metadata";
import { newId, nowIso } from "../ids";
import {
  membershipFor,
  requireActiveTeamId,
  requireCapability,
  requireInstanceAdmin,
  requireTeamWide,
  teamsForUser,
} from "../membership";
import { withinActor } from "./roles";
import { visibleFolderIds } from "./folder-access";
import { appCapabilitiesForTeam } from "./node-access";
// The folder-subtree walk a scope needs, shared with the ROLE scope that reuses
// this same shape. It lives in the leaf module so neither side has to import the
// other (`node-scope.ts` explains why).
import { expandFolders } from "./node-scope";
import { recordActivity } from "./activity";
import { avatarResolver } from "../avatar";
import { assertUser, getCurrentUser } from "../auth";
import { sha256Hex, randomToken } from "../crypto";
import { ALL_CAPABILITIES, type Capability, type Membership } from "../types";
import {
  currentIdentity,
  type RequestIdentity,
  type TokenScope,
} from "../auth/request-context";

/**
 * API tokens - bearer credentials that drive Deplo's API from outside the
 * dashboard.
 */

const MAX_NAME = 40;

export interface ApiTokenDTO {
  id: string;
  name: string;
  prefix: string;
  /** What the token itself may do - its own set, before the creator clamp. */
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
  /**
   * Every team this token can act in, named - the four scope lists above flattened
   * to the teams they land in. Here because revoking is per-team: a screen
   * offering Revoke has to say what survives it.
   */
  teamsReached: TokenTeam[];
  instanceAdmin: boolean;
  /** The team this token is MANAGED from, where it was created. */
  homeTeamId: string;
  /**
   * That team, named. The list is a personal one and spans teams, so every row
   * has to say where its credential lives: otherwise two tokens called "CI"
   * are indistinguishable.
   */
  homeTeamName: string;
  /** The member it acts as. Its power is clamped to theirs, so name them. */
  createdByUsername: string | null;
  /** That member's monogram colour + resolved picture, so the name is shown the
   *  way a person is shown everywhere else. Null when the account is gone. */
  createdByAvatarColor: string | null;
  createdByAvatarUrl: string | null;
  /**
   * That member's id. A token is minted on a PERSON's account and can reach
   * several teams, so its creator manages it from any of them - this is what a
   * screen asks to know whether it is looking at its own credential.
   */
  createdByUserId: string;
  /**
   * The AI client this token was minted for, when it came from approving an OAuth
   * consent rather than from the tokens page.
   */
  oauthClientName: string | null;
  /**
   * When this credential stops working, or null for "never", which is what every
   * token minted before expiry existed still is.
   */
  expiresAt: string | null;
  /**
   * Whether that moment has passed.
   */
  expired: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

/** The non-secret projection, never selects `token_hash` (relational-store PLAN §1 "Secrets"). */
const DTO_COLUMNS = {
  id: apiTokens.id,
  name: apiTokens.name,
  prefix: apiTokens.prefix,
  scoped: apiTokens.scoped,
  instanceAdmin: apiTokens.instanceAdmin,
  homeTeamId: apiTokens.teamId,
  createdByUserId: apiTokens.userId,
  expiresAt: apiTokens.expiresAt,
  lastUsedAt: apiTokens.lastUsedAt,
  createdAt: apiTokens.createdAt,
} as const;

/**
 * Every token that can act in `teamId`, not merely the ones created there.
 */
export async function tokenIdsReaching(teamId: string): Promise<Set<string>> {
  const db = getDb();
  const [byTeam, byProject, byFolder, byApp, unscoped] = await Promise.all([
    db
      .select({ id: apiTokenTeams.tokenId })
      .from(apiTokenTeams)
      .where(eq(apiTokenTeams.teamId, teamId)),
    db
      .select({ id: apiTokenProjects.tokenId })
      .from(apiTokenProjects)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, apiTokenProjects.projectId),
      )
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
    [...byTeam, ...byProject, ...byFolder, ...byApp, ...unscoped].map(
      (r) => r.id,
    ),
  );
}

/** A team a token can act in, named for the screen that has to say so. */
export interface TokenTeam {
  id: string;
  name: string;
}

/**
 * The teams each token reaches, named - {@link tokenIdsReaching} read the other
 * way round, for a whole list at once.
 */
export async function teamsReachedByTokens(
  ids: string[],
): Promise<Map<string, TokenTeam[]>> {
  const out = new Map<string, TokenTeam[]>();
  if (ids.length === 0) return out;
  const db = getDb();
  const [byTeam, byProject, byFolder, byApp] = await Promise.all([
    db
      .select({
        tokenId: apiTokenTeams.tokenId,
        id: teamsTable.id,
        name: teamsTable.name,
      })
      .from(apiTokenTeams)
      .innerJoin(teamsTable, eq(teamsTable.id, apiTokenTeams.teamId))
      .where(inArray(apiTokenTeams.tokenId, ids)),
    db
      .select({
        tokenId: apiTokenProjects.tokenId,
        id: teamsTable.id,
        name: teamsTable.name,
      })
      .from(apiTokenProjects)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, apiTokenProjects.projectId),
      )
      .innerJoin(teamsTable, eq(teamsTable.id, projectsTable.teamId))
      .where(inArray(apiTokenProjects.tokenId, ids)),
    db
      .select({
        tokenId: apiTokenFolders.tokenId,
        id: teamsTable.id,
        name: teamsTable.name,
      })
      .from(apiTokenFolders)
      .innerJoin(foldersTable, eq(foldersTable.id, apiTokenFolders.folderId))
      .innerJoin(teamsTable, eq(teamsTable.id, foldersTable.teamId))
      .where(inArray(apiTokenFolders.tokenId, ids)),
    db
      .select({
        tokenId: apiTokenApps.tokenId,
        id: teamsTable.id,
        name: teamsTable.name,
      })
      .from(apiTokenApps)
      .innerJoin(appsTable, eq(appsTable.id, apiTokenApps.appId))
      .innerJoin(teamsTable, eq(teamsTable.id, appsTable.teamId))
      .where(inArray(apiTokenApps.tokenId, ids)),
  ]);

  for (const r of [...byTeam, ...byProject, ...byFolder, ...byApp]) {
    const list = out.get(r.tokenId) ?? [];
    if (list.some((t) => t.id === r.id)) continue;
    out.set(r.tokenId, [...list, { id: r.id, name: r.name }]);
  }
  for (const list of out.values())
    list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * The tokens Settings → API tokens shows: every one YOU minted, whatever team it
 * acts in, plus every token that can act in the ACTIVE team.
 */
export async function listTokens(): Promise<ApiTokenDTO[]> {
  const teamId = await requireActiveTeamId();
  // A narrowed token must not enumerate the team's OTHER credentials: its
  // capability clamp already stops it minting one, this stops it reading them.
  await requireTeamWide("API tokens");
  const reaching = await tokenIdsReaching(teamId);
  const me = currentIdentity()?.token ? null : await getCurrentUser();
  const wanted = [
    ...(reaching.size > 0 ? [inArray(apiTokens.id, [...reaching])] : []),
    ...(me ? [eq(apiTokens.userId, me.id)] : []),
  ];
  if (wanted.length === 0) return [];
  const rows = await getDb()
    .select({
      ...DTO_COLUMNS,
      homeTeamName: teamsTable.name,
      createdByUsername: usersTable.username,
      createdByAvatarColor: usersTable.avatarColor,
      // Consumed by `createdByAvatarUrl` and dropped, no email in this DTO.
      createdByImage: usersTable.image,
      createdByEmail: usersTable.email,
      oauthClientName: oauthClient.name,
    })
    .from(apiTokens)
    .leftJoin(teamsTable, eq(teamsTable.id, apiTokens.teamId))
    .leftJoin(usersTable, eq(usersTable.id, apiTokens.userId))
    .leftJoin(oauthClient, eq(oauthClient.clientId, apiTokens.oauthClientId))
    .where(or(...wanted))
    .orderBy(desc(apiTokens.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  // Every junction in one query each, never per-token (PLAN §6 "batch-load").
  const [reachedByToken, caps, teamRows, projRows, folderRows, appRows] =
    await Promise.all([
      teamsReachedByTokens(ids),
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
    for (const r of rows)
      m.set(r.tokenId, [...(m.get(r.tokenId) ?? []), r.value]);
    return m;
  };
  const capsById = group(caps);
  const teamsById = group(teamRows);
  const projectsById = group(projRows);
  const foldersById = group(folderRows);
  const appsById = group(appRows);

  const now = Date.now();
  const avatarUrl = await avatarResolver();
  // `createdByImage` / `createdByEmail` are DESTRUCTURED OUT before the spread: the
  // row carries them so the avatar can be resolved, and `...rest` would otherwise
  // walk both straight into the DTO - an email this list has never exposed.
  return rows.map(({ createdByImage, createdByEmail, ...r }) => ({
    ...r,
    createdByAvatarUrl: avatarUrl({
      image: createdByImage,
      email: createdByEmail,
    }),
    expired: r.expiresAt != null && Date.parse(r.expiresAt) <= now,
    homeTeamName: r.homeTeamName ?? "",
    // Chosen by the app at registration: free text, any length, shown in a badge.
    oauthClientName: r.oauthClientName?.slice(0, 80) ?? null,
    capabilities: inCatalogOrder((capsById.get(r.id) ?? []) as Capability[]),
    teamIds: teamsById.get(r.id) ?? [],
    projectIds: projectsById.get(r.id) ?? [],
    folderIds: foldersById.get(r.id) ?? [],
    appIds: appsById.get(r.id) ?? [],
    teamsReached: reachedByToken.get(r.id) ?? [],
  }));
}

/**
 * One token by id. Deliberately `listTokens().find(…)` - the same trick
 * `getRole` uses, so there is exactly ONE place that assembles the DTO and its
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
/**
 * An environment of a project, where an app lives inside it (ADR-0009). A
 * sibling of the project's folders, not a parent of them: a folder never lives
 * in an environment, and filing an app into one clears its environment.
 */
export interface ScopeTreeEnvironment {
  id: string;
  name: string;
  isDefault: boolean;
  apps: ScopeTreeApp[];
}

export interface ScopeTreeProject {
  id: string;
  name: string;
  color: string | null;
  environments: ScopeTreeEnvironment[];
  folders: ScopeTreeFolder[];
  apps: ScopeTreeApp[];
}
export interface ScopeTreeTeam {
  id: string;
  name: string;
  /** The team's picture, so the tree names it the way the switcher does. */
  avatarUrl: string | null;
  projects: ScopeTreeProject[];
  /** Folders at the team top level, in no project. */
  folders: ScopeTreeFolder[];
  /** Apps of this team in no folder and no project. */
  looseApps: ScopeTreeApp[];
}

/**
 * Every team the CURRENT USER belongs to, with its projects, its folders and their
 * apps - the tree the scope picker draws.
 */
export async function listScopeTree(): Promise<ScopeTreeTeam[]> {
  // Deliberately NOT gated on `manage_tokens`: a member without it still opens a
  // token page (read-only, like the roles page), and the tree holds nothing they
  // can't already see.
  const user = await assertUser();
  await requireTeamWide("the token scope picker");
  // Their memberships bound WHICH teams; per-node access bounds what shows up inside
  // one.
  return buildScopeTree(await teamsForUser(user.id), { asCaller: true });
}

/**
 * The same tree, narrowed to the ACTIVE team - what a ROLE editor draws, since a
 * role belongs to exactly one team and cannot reach past it.
 */
export async function listTeamScopeTree(): Promise<ScopeTreeTeam[]> {
  const teamId = await requireActiveTeamId();
  return (await listScopeTree()).filter((t) => t.id === teamId);
}

/**
 * The tree for an explicit set of teams.
 */
export async function buildScopeTree(
  mine: { id: string; name: string; avatarUrl?: string | null }[],
  opts: { asCaller?: boolean } = {},
): Promise<ScopeTreeTeam[]> {
  if (mine.length === 0) return [];
  const teamIds = mine.map((t) => t.id);

  const db = getDb();
  const [projectRows, folderRows, appRows, envRows] = await Promise.all([
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
        environmentId: appsTable.environmentId,
        name: appsTable.name,
        slug: appsTable.slug,
        logo: appsTable.logo,
      })
      .from(appsTable)
      .where(inArray(appsTable.teamId, teamIds)),
    db
      .select({
        id: environmentsTable.id,
        projectId: environmentsTable.projectId,
        name: environmentsTable.name,
        isDefault: environmentsTable.isDefault,
        position: environmentsTable.position,
      })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, environmentsTable.projectId),
      )
      .where(inArray(projectsTable.teamId, teamIds)),
  ]);

  // Per-node visibility, when the tree is the CALLER's own picker: a folder they
  // can't see, and an app they hold nothing on, must not be listed - the same answer
  // `listFolders` and `listApps` give.
  const { folders: visibleFolders, apps: visibleApps } = opts.asCaller
    ? await visibleNodes(teamIds, folderRows, appRows)
    : { folders: null, apps: null };
  const folderVisible = (id: string) =>
    !visibleFolders || visibleFolders.has(id);
  const appVisible = (id: string) => !visibleApps || visibleApps.has(id);

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);

  /**
   * Apps keyed by the ONE container they live in: a folder, else the ENVIRONMENT
   * of their project, else the project itself (legacy rows written before the
   * environment column), else the team top level.
   */
  const appsIn = new Map<string, ScopeTreeApp[]>();
  for (const a of appRows) {
    if (!appVisible(a.id)) continue;
    const key = a.folderId ?? a.environmentId ?? a.projectId ?? a.teamId;
    appsIn.set(key, [
      ...(appsIn.get(key) ?? []),
      { id: a.id, name: a.name, slug: a.slug, logo: a.logo ?? null },
    ]);
  }
  /** Child folders keyed by their parent folder id. */
  const subfoldersOf = new Map<string, typeof folderRows>();
  for (const f of folderRows)
    if (f.parentId && folderVisible(f.id))
      subfoldersOf.set(f.parentId, [
        ...(subfoldersOf.get(f.parentId) ?? []),
        f,
      ]);

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
  const rootFolders = (
    predicate: (f: (typeof folderRows)[number]) => boolean,
  ) =>
    folderRows
      .filter((f) => !f.parentId && folderVisible(f.id) && predicate(f))
      .sort(byName)
      .map((f) => build(f, new Set()));

  return mine.map((t) => ({
    id: t.id,
    name: t.name,
    avatarUrl: t.avatarUrl ?? null,
    projects: projectRows
      .filter((p) => p.teamId === t.id)
      .sort(byName)
      .map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color ?? null,
        // Environments first, in the order the project shows them: ADR-0009
        // makes the environment the primary axis of a project, and folders are
        // their siblings rather than their children.
        environments: envRows
          .filter((e) => e.projectId === p.id)
          .sort((a, b) => a.position - b.position)
          .map((e) => ({
            id: e.id,
            name: e.name,
            isDefault: e.isDefault,
            apps: (appsIn.get(e.id) ?? []).sort(byName),
          })),
        folders: rootFolders((f) => f.projectId === p.id),
        // Legacy rows only: an app filed in a project before the environment
        // column existed. Everything newer sits under an environment above.
        apps: (appsIn.get(p.id) ?? []).sort(byName),
      })),
    folders: rootFolders((f) => f.teamId === t.id && !f.projectId),
    looseApps: (appsIn.get(t.id) ?? []).sort(byName),
  }));
}

/**
 * The folder and app ids the CURRENT caller may see, across several teams - the
 * per-node half of the picker's bound.
 */
async function visibleNodes(
  teamIds: string[],
  folderRows: { id: string; teamId: string }[],
  appRows: {
    id: string;
    teamId: string;
    projectId: string | null;
    folderId: string | null;
    // The environment is where an app inside a project actually lives, so a
    // placement without it is refused by an environment-shaped scope.
    environmentId?: string | null;
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
            environmentId: a.environmentId ?? null,
          })),
      );
      for (const [id, caps] of reach) if (caps.length > 0) apps.add(id);
    } catch {
      // A team the caller can't currently resolve at all - an unmet two-factor
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

/**
 * A SCOPED API token must not mint (or widen a token to reach) a team OUTSIDE its
 * own scope.
 */
function assertScopeWithinActingToken(
  scope: ResolvedScope,
  scoped: boolean,
): void {
  const actingScope = currentIdentity()?.token?.scope;
  if (!actingScope) return;
  if (!scoped)
    throw new Error(
      "This API token is scoped, so it can't mint an unscoped token.",
    );
  const outside = scope.teamsReached.filter(
    (t) => !actingScope.teamIds.includes(t),
  );
  if (outside.length > 0)
    throw new Error(
      "This API token can't create a token that reaches a team outside its own scope.",
    );
}

/** Returns the raw token ONCE; only the hash is persisted. */
export async function createToken(
  input: {
    name: string;
    capabilities?: Capability[];
    instanceAdmin?: boolean;
    /** ISO instant this token stops working. Absent/null ⇒ never. */
    expiresAt?: string | null;
  } & TokenScopeInput,
): Promise<{ raw: string; token: ApiTokenDTO }> {
  const { teamId, userId, membership } =
    await requireCapability("manage_tokens");
  const name = cleanTokenName(input.name);
  const capabilities = withinActor(input.capabilities, membership, "token");
  const { scoped, instanceAdmin } = await validateScope(input);
  const expiresAt = cleanExpiry(input.expiresAt);
  const scope = await resolveScopeInput(input, userId);
  assertScopeWithinActingToken(scope, scoped);

  const raw = `deplo_${randomToken(24)}`;
  const id = newId("tok");
  const createdAt = nowIso();
  await getDb().transaction(async (tx) => {
    await tx.insert(apiTokens).values({
      id,
      // The team it is MANAGED from. Its reach is the scope below, which may be
      // wider, but exactly one team owns the row that can edit it.
      teamId,
      // The token acts as its creator for user-scoped fields, and its power is
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

  await recordActivity(
    "security",
    `Created the ${name} API token`,
    await actorUsername(),
    null,
    teamId,
    "token_created",
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
      teamsReached: (await teamsReachedByTokens([id])).get(id) ?? [],
      instanceAdmin,
      homeTeamId: teamId,
      homeTeamName:
        (await teamsForUser(userId)).find((t) => t.id === teamId)?.name ?? "",
      createdByUsername: (await getCurrentUser())?.username ?? null,
      // The minter is the current user, whose picture is already resolved on the
      // session DTO, no second lookup.
      createdByAvatarColor: (await getCurrentUser())?.avatarColor ?? null,
      createdByAvatarUrl: (await getCurrentUser())?.avatarUrl ?? null,
      createdByUserId: userId,
      // Set by `mintMcpConnection` right after this, in the same flow, when the
      // mint came from an OAuth consent rather than from the tokens page.
      oauthClientName: null,
      expiresAt,
      // Refused if it were not (see cleanExpiry).
      expired: false,
      lastUsedAt: null,
      createdAt,
    },
  };
}

/**
 * Validate a requested expiry: an ISO instant in the future, or null for never.
 * There is no upper bound: a five-year token is a decision, and refusing it would
 * only push people back to "never".
 */
function cleanExpiry(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) throw new Error("That expiry date is not a date");
  if (at <= Date.now())
    throw new Error("Pick an expiry date in the future, or no expiry at all");
  return new Date(at).toISOString();
}

/**
 * Re-scope a live token without re-minting it.
 */
export async function updateToken(
  input: {
    id: string;
    name: string;
    capabilities?: Capability[];
    instanceAdmin?: boolean;
    /**
     * ABSENT leaves the expiry alone; `null` clears it (back to never). Same
     * rule `scope` follows, and for the same reason: an older client that sends
     * `{ id, name }` to rename a token must not silently un-expire it.
     */
    expiresAt?: string | null;
  } & TokenScopeInput,
): Promise<void> {
  const { teamId, userId, membership } =
    await requireCapability("manage_tokens");
  const name = cleanTokenName(input.name);
  const { scoped, instanceAdmin } = await validateScope(input);
  const expiresAt =
    input.expiresAt === undefined ? undefined : cleanExpiry(input.expiresAt);
  const scope = await resolveScopeInput(input, userId);
  assertScopeWithinActingToken(scope, scoped);

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

  const isCreator = existing.createdByUserId === userId;
  if (!isCreator && existing.homeTeamId !== teamId) {
    // Don't leak that it exists to a team it can't reach at all.
    if (!(await tokenIdsReaching(teamId)).has(input.id))
      throw new Error("Token not found");
    throw new Error(
      "This token is managed in the team it was created in. You can revoke it here, but not change it.",
    );
  }

  // The teams the edited token will act in.
  const reach = scoped
    ? scope.teamsReached
    : (await teamsForUser(existing.createdByUserId)).map((t) => t.id);
  // What may be TICKED. The creator is measured across the teams the token reaches
  // rather than the one they happen to be standing in, or a credential spanning teams
  // would be unsaveable from any team that holds less than another.
  const bound =
    isCreator && !currentIdentity()?.token
      ? await actorAcross(membership, reach)
      : membership;
  const capabilities = withinActor(input.capabilities, bound, "token");

  // Editing an instance-admin token is itself an instance-admin action: a plain
  // manage_tokens holder must not be able to rename it, re-scope it, or keep the
  // bit alive under a permission set of their own choosing.
  if (existing.instanceAdmin) await requireInstanceAdmin();
  // Re-authoring SOMEONE ELSE's token: the live clamp only measures it against
  // its creator, so bound the edit by the actor's own capabilities in every team
  // this token will reach.
  if (!isCreator)
    await assertWithinActorEverywhere(capabilities, userId, teamId, reach);

  await db.transaction(async (tx) => {
    await tx
      .update(apiTokens)
      .set({
        name,
        instanceAdmin,
        scoped,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      })
      .where(
        and(
          eq(apiTokens.id, input.id),
          eq(apiTokens.teamId, existing.homeTeamId),
        ),
      );
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
    "security",
    `Updated the ${name} API token`,
    await actorUsername(),
    null,
    // The trail belongs to the team that hosts the credential, which is not
    // necessarily the one its creator happened to be looking at.
    existing.homeTeamId,
  );
}

/** The columns every bearer lookup resolves to before the identity is built. */
interface TokenRow {
  id: string;
  userId: string;
  /** The team the token is MANAGED from, where it was created. */
  teamId: string;
  instanceAdmin: boolean;
  scoped: boolean;
  /** When it stops working. Null ⇒ never. */
  expiresAt: string | null;
}

const TOKEN_ROW_COLUMNS = {
  id: apiTokens.id,
  userId: apiTokens.userId,
  teamId: apiTokens.teamId,
  instanceAdmin: apiTokens.instanceAdmin,
  scoped: apiTokens.scoped,
  expiresAt: apiTokens.expiresAt,
} as const;

/**
 * Resolve an incoming bearer credential to the identity the whole data layer runs
 * under, or null if it does not match a live token.
 */
export async function authenticateToken(
  raw: string,
  teamHint?: string | null,
): Promise<RequestIdentity | null> {
  if (raw.startsWith("deplo_")) {
    const rows = await getDb()
      .select(TOKEN_ROW_COLUMNS)
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, sha256Hex(raw)))
      .limit(1);
    return rows[0] ? identityForTokenRow(rows[0], teamHint) : null;
  }
  if (raw.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const row = await oauthTokenRow(raw);
    // No hint means the connection's OWN team, never `reachable[0]`, the OLDEST team
    // its approver belongs to, which is how an agent once worked somewhere nobody
    // chose.
    return row ? identityForTokenRow(row, teamHint ?? row.teamId) : null;
  }
  return null;
}

/**
 * Resolve an opaque OAuth access token to the `api_tokens` row its grant minted.
 */
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
        // A disabled client stops resolving immediately; the plugin's own token
        // lookup does not check this, and a credential whose client was turned
        // off is exactly the one an operator thinks they have stopped.
        or(isNull(oauthClient.disabled), eq(oauthClient.disabled, false)),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * THE identity builder.
 */
async function identityForTokenRow(
  match: TokenRow,
  teamHint?: string | null,
): Promise<RequestIdentity | null> {
  // Expiry first, and it is a plain "this token is not valid": before any team is
  // resolved, before the membership read, before `lastUsedAt` is stamped.
  if (match.expiresAt && Date.parse(match.expiresAt) <= Date.now()) return null;
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

/**
 * Record that this token just drove an AI agent, rather than merely that it was
 * used. It cannot answer "which clients are connected to this team", because a CI
 * job and Claude Code look identical through it.
 */
export function stampMcpUse(tokenId: string): void {
  void getDb()
    .update(apiTokens)
    .set({ mcpLastUsedAt: nowIso() })
    .where(eq(apiTokens.id, tokenId))
    .catch(() => {
      /* usage tracking is best-effort */
    });
}

/**
 * Revoke = the credential is gone, everywhere.
 */
export async function revokeToken(id: string): Promise<void> {
  const { teamId, userId } = await requireCapability("manage_tokens");

  const row = (
    await getDb()
      .select({
        name: apiTokens.name,
        userId: apiTokens.userId,
        instanceAdmin: apiTokens.instanceAdmin,
        homeTeamId: apiTokens.teamId,
        oauthClientId: apiTokens.oauthClientId,
      })
      .from(apiTokens)
      .where(eq(apiTokens.id, id))
      .limit(1)
  )[0];
  if (!row) throw new Error("Token not found");

  // An INSTANCE-ADMIN token is unscoped and reaches every team its creator belongs
  // to, so "any reaching team may revoke" (below) would let a plain manage_tokens
  // holder in any of those teams kill the admin's global credential.
  if (row.instanceAdmin) await requireInstanceAdmin();

  // Any team the token can act in may cut it off: that is the lever a team has over a
  // credential someone else minted into it.
  const reachesHere = (await tokenIdsReaching(teamId)).has(id);
  if (!reachesHere && row.userId !== userId) throw new Error("Token not found");

  // Read the reach BEFORE the row goes: afterwards there is nothing left to ask.
  // (Also before any transaction - this helper queries on its own connection and
  // pglite deadlocks if that happens inside one.)
  const reached = (await teamsReachedByTokens([id])).get(id) ?? [];

  const gone = await getDb()
    .delete(apiTokens)
    .where(eq(apiTokens.id, id))
    .returning({
      id: apiTokens.id,
      name: apiTokens.name,
      userId: apiTokens.userId,
      oauthClientId: apiTokens.oauthClientId,
    });
  if (gone.length === 0) throw new Error("Token not found");
  await forgetOauthGrant(gone[0].userId, gone[0].oauthClientId);

  // The team that pressed the button, plus every other team the credential was
  // working in. An unscoped token reaches no stored teams, so this is just the
  // one entry it always had.
  const trailTeamIds = new Set([
    reachesHere ? teamId : row.homeTeamId,
    ...reached.map((t) => t.id),
  ]);
  const actor = await actorUsername();
  const mcp = gone[0].oauthClientId != null;
  const what = mcp
    ? `Revoked ${gone[0].name}'s MCP access`
    : `Revoked the ${gone[0].name} API token`;
  for (const trailTeamId of trailTeamIds)
    // The type follows the message: `mcp-clients.ts` files the connect under
    // `mcp`, and filing the revoke elsewhere would split one story in two.
    await recordActivity(
      mcp ? "mcp" : "security",
      what,
      actor,
      null,
      trailTeamId,
      "token_revoked",
    );
}

/**
 * Tear down the OAuth half of a connection when its token is revoked. Best-effort,
 * like `lastUsedAt`: the credential is already gone by this point, and a failed
 * cleanup must not turn a successful revoke into an error.
 */
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
    // Not fatal: the credential is already gone, so a leftover consent or refresh row
    // grants nothing - the join that resolves an access token has no `api_tokens` row
    // to land on.
    console.warn(
      `[deplo] could not clear the OAuth rows for a revoked connection (client ${clientId}):`,
      e,
    );
  }
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
   * Every team the ticked nodes put in reach - the whole teams plus the owning
   * team of each project, folder and app.
   */
  teamsReached: string[];
}

/**
 * Decide the two orthogonal switches, refusing the combination that cannot mean
 * what it says. Instance-admin gates read the user's admin flag and nothing else,
 * so a scope could not narrow one - offering both would be a switch that lies.
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
 * Validate every ticked node against what the ACTOR can reach.
 */
async function resolveScopeInput(
  input: TokenScopeInput,
  userId: string,
): Promise<ResolvedScope> {
  const teamIds = [...new Set(input.teamIds ?? [])];
  const projectIds = [...new Set(input.projectIds ?? [])];
  const folderIds = [...new Set(input.folderIds ?? [])];
  const appIds = [...new Set(input.appIds ?? [])];
  if (
    teamIds.length + projectIds.length + folderIds.length + appIds.length ===
    0
  )
    return {
      teamIds: [],
      projectIds: [],
      folderIds: [],
      appIds: [],
      teamsReached: [],
    };

  const mine = new Set((await teamsForUser(userId)).map((t) => t.id));
  for (const id of teamIds)
    if (!mine.has(id))
      throw new Error("You're not a member of one of those teams");
  const reached = new Set<string>(teamIds);
  // Refused rather than reinterpreted: `loadScope` lets the narrower tick win, so
  // accepting both would hand back a token that reads as whole-team and behaves
  // as one app. Say which one they meant.
  const whole = new Set(teamIds);
  const narrower = (teamId: string) => {
    if (whole.has(teamId))
      throw new Error(
        "Tick either the whole team or the parts of it, not both - the parts would win.",
      );
  };

  const db = getDb();
  if (projectIds.length > 0) {
    const rows = await db
      .select({ id: projectsTable.id, teamId: projectsTable.teamId })
      .from(projectsTable)
      .where(inArray(projectsTable.id, projectIds));
    if (
      rows.length !== projectIds.length ||
      rows.some((r) => !mine.has(r.teamId))
    )
      throw new Error("One of those projects isn't in a team you belong to");
    for (const r of rows) {
      narrower(r.teamId);
      reached.add(r.teamId);
    }
  }
  if (folderIds.length > 0) {
    const rows = await db
      .select({ id: foldersTable.id, teamId: foldersTable.teamId })
      .from(foldersTable)
      .where(inArray(foldersTable.id, folderIds));
    if (
      rows.length !== folderIds.length ||
      rows.some((r) => !mine.has(r.teamId))
    )
      throw new Error("One of those folders isn't in a team you belong to");
    for (const r of rows) {
      narrower(r.teamId);
      reached.add(r.teamId);
    }
  }
  if (appIds.length > 0) {
    const rows = await db
      .select({ id: appsTable.id, teamId: appsTable.teamId })
      .from(appsTable)
      .where(inArray(appsTable.id, appIds));
    if (rows.length !== appIds.length || rows.some((r) => !mine.has(r.teamId)))
      throw new Error("One of those apps isn't in a team you belong to");
    for (const r of rows) {
      narrower(r.teamId);
      reached.add(r.teamId);
    }
  }
  return { teamIds, projectIds, folderIds, appIds, teamsReached: [...reached] };
}

/**
 * The actor, measured across the teams a token reaches instead of the one team
 * they are standing in - the ceiling on what the CREATOR may tick when they edit
 * their own token from somewhere else.
 */
async function actorAcross(
  actor: Membership,
  teams: string[],
): Promise<Membership> {
  const caps = new Set<Capability>(
    teams.length === 0 ? actor.capabilities : [],
  );
  for (const teamId of teams) {
    // A team whose two-factor policy this member has not met resolves NOTHING
    // for them there, and `membershipFor` says so by throwing. Either way it
    // contributes no capabilities.
    const m = await membershipFor(actor.userId, teamId).catch(() => null);
    if (m) for (const c of m.capabilities) caps.add(c);
  }
  return { ...actor, capabilities: [...caps] };
}

/**
 * Bound a token edit by what the ACTOR may do in every team the token will act in,
 * not merely in the team it is managed from.
 */
async function assertWithinActorEverywhere(
  capabilities: Capability[],
  actorUserId: string,
  boundedTeamId: string,
  reach: string[],
): Promise<void> {
  for (const teamId of reach) {
    // The team the actor is acting in is already bounded by the `withinActor`
    // call at the top.
    if (teamId === boundedTeamId) continue;
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
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, apiTokenProjects.projectId),
      )
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

  const projectIds = projRows.map((r) => r.id);
  // A team is WHOLE only when nothing narrower inside it is named.
  const narrowedTeamIds = new Set(
    [...projRows, ...folderRows, ...appRows].map((r) => r.teamId),
  );
  const wholeTeamIds = teamRows
    .map((r) => r.teamId)
    .filter((id) => !narrowedTeamIds.has(id));
  const teamIds = [
    ...new Set([
      ...teamRows.map((r) => r.teamId),
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

async function actorUsername(): Promise<string> {
  return (await getCurrentUser())?.username ?? "an admin";
}
