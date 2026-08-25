import "server-only";

// https://deplo.build/docs/guides/roles-and-permissions

import { cache } from "react";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appGrants as appGrantsTable,
  apps as appsTable,
  environmentGrants as environmentGrantsTable,
  environments as environmentsTable,
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  membershipCapabilities as membershipCapabilitiesTable,
  memberships as membershipsTable,
  projectGrants as projectGrantsTable,
  projects as projectsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import {
  clampCapabilitiesToToken,
  getActiveTeamId,
  isInstanceAdmin,
  membershipFor,
  requireMembership,
  type ActiveMembership,
} from "../membership";
import { inAppScope } from "../auth/request-context";
import {
  appInScope,
  environmentInScope,
  folderInScope,
  projectInScope,
  memberScopeFor,
  type NodeScope,
} from "./node-scope";
import { CAPABILITY_META } from "../membership-shared";
import { assertNotMigrating } from "./migration-guard";
import { ALL_CAPABILITIES, type Capability } from "../types";

/**
 * Per-NODE authorization — what one person may do to one App, Folder or Project
 * container, as opposed to what their team role lets them do everywhere
 * (`lib/membership.ts`). **A node capability set REPLACES the team role's inside
 * that node, and may exceed it** (ADR-0016).
 */

/** The three things a capability set can be attached to. */
export type NodeRef =
  | { kind: "app"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "environment"; id: string }
  | { kind: "project"; id: string };

/**
 * An app as the resolver needs it — the columns that place it. `environmentId` is
 * optional so a caller that never asks about environments keeps compiling; it only
 * ever widens the answer.
 */
export interface AppPlacement {
  id: string;
  folderId: string | null;
  projectId: string | null;
  environmentId?: string | null;
}

/**
 * Every row the precedence ladder can consult for one (user, team) pair. Built
 * once, read many times — the batch and single-node paths share it, so there is
 * exactly one implementation of the precedence rules.
 */
interface GrantIndex {
  teamId: string;
  userId: string;
  /** The member's base capabilities (already token-clamped by `membershipFor`). */
  base: Capability[];
  /**
   * Instance admin or `manage_team`: their base set applies to every node.
   */
  superUser: boolean;
  /**
   * Instance admin specifically, as opposed to {@link superUser}, which also
   * counts `manage_team`. The two part company at exactly one place: the role
   * scope below limits a member of the team, and an instance admin is not one.
   */
  instanceAdmin: boolean;
  /**
   * What the member's ROLE reaches in this team, or null when it is
   * unrestricted. REACH, not power: a node outside it resolves to `[]`, which is
   * the same answer a folder they were never shown gives.
   */
  roleScope: NodeScope | null;
  folders: Map<
    string,
    {
      parentId: string | null;
      projectId: string | null;
      ownerUserId: string | null;
    }
  >;
  projectOwners: Map<string, string | null>;
  /** environmentId → its project, so an environment rung can find its container. */
  environmentProjects: Map<string, string>;
  folderGrants: Map<string, Capability[]>;
  environmentGrants: Map<string, Capability[]>;
  projectGrants: Map<string, Capability[]>;
  appGrants: Map<string, Capability[]>;
}

/**
 * Add the always-implied `view` capability, returning the set in canonical
 * order. Anyone who can reach a node at all can at least read it. Pure.
 */
export function withView(caps: Capability[]): Capability[] {
  const set = new Set<Capability>(caps);
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

/* ------------------------------------------------------------------ */
/* The index                                                           */
/* ------------------------------------------------------------------ */

/** Group `(key, capability)` rows into a map. */
function groupCaps<T extends { key: string; capability: string }>(
  rows: T[],
): Map<string, Capability[]> {
  const out = new Map<string, Capability[]>();
  for (const r of rows) {
    const list = out.get(r.key) ?? [];
    list.push(r.capability as Capability);
    out.set(r.key, list);
  }
  return out;
}

/**
 * Build the index. `null` when the user can't act in this team at all — not a
 * member and not an instance admin, which is the first and last word on access.
 */
async function buildIndex(
  userId: string,
  teamId: string,
  admin: boolean,
): Promise<GrantIndex | null> {
  // THE gate, first and always: membership existence carries the 2FA policy and
  // the "are they still in this team" question, and nothing below survives it.
  const membership = await membershipFor(userId, teamId);
  const base = membership?.capabilities ?? [];
  if (!admin && base.length === 0) return null;

  const db = getDb();
  const [
    folderRows,
    projectRows,
    fGrants,
    pGrants,
    aGrants,
    superUser,
    roleScope,
    envRows,
    eGrants,
  ] = await Promise.all([
    db
      .select({
        id: foldersTable.id,
        parentId: foldersTable.parentId,
        projectId: foldersTable.projectId,
        ownerUserId: foldersTable.ownerUserId,
      })
      .from(foldersTable)
      .where(eq(foldersTable.teamId, teamId)),
    db
      .select({ id: projectsTable.id, ownerUserId: projectsTable.ownerUserId })
      .from(projectsTable)
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({
        key: folderGrantsTable.folderId,
        capability: folderGrantsTable.capability,
      })
      .from(folderGrantsTable)
      .innerJoin(foldersTable, eq(foldersTable.id, folderGrantsTable.folderId))
      .where(
        and(
          eq(folderGrantsTable.userId, userId),
          eq(foldersTable.teamId, teamId),
        ),
      ),
    db
      .select({
        key: projectGrantsTable.projectId,
        capability: projectGrantsTable.capability,
      })
      .from(projectGrantsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, projectGrantsTable.projectId),
      )
      .where(
        and(
          eq(projectGrantsTable.userId, userId),
          eq(projectsTable.teamId, teamId),
        ),
      ),
    db
      .select({
        key: appGrantsTable.appId,
        capability: appGrantsTable.capability,
      })
      .from(appGrantsTable)
      .innerJoin(appsTable, eq(appsTable.id, appGrantsTable.appId))
      .where(
        and(eq(appGrantsTable.userId, userId), eq(appsTable.teamId, teamId)),
      ),
    holdsManageTeam(userId, teamId),
    memberScopeFor(userId, teamId),
    db
      .select({
        id: environmentsTable.id,
        projectId: environmentsTable.projectId,
      })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, environmentsTable.projectId),
      )
      .where(eq(projectsTable.teamId, teamId)),
    db
      .select({
        key: environmentGrantsTable.environmentId,
        capability: environmentGrantsTable.capability,
      })
      .from(environmentGrantsTable)
      .innerJoin(
        environmentsTable,
        eq(environmentsTable.id, environmentGrantsTable.environmentId),
      )
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, environmentsTable.projectId),
      )
      .where(
        and(
          eq(environmentGrantsTable.userId, userId),
          eq(projectsTable.teamId, teamId),
        ),
      ),
  ]);

  return {
    teamId,
    userId,
    base,
    superUser: admin || superUser,
    instanceAdmin: admin,
    roleScope,
    folders: new Map(
      folderRows.map((f) => [
        f.id,
        {
          parentId: f.parentId ?? null,
          projectId: f.projectId ?? null,
          ownerUserId: f.ownerUserId ?? null,
        },
      ]),
    ),
    projectOwners: new Map(
      projectRows.map((p) => [p.id, p.ownerUserId ?? null]),
    ),
    environmentProjects: new Map(envRows.map((e) => [e.id, e.projectId])),
    folderGrants: groupCaps(fGrants),
    environmentGrants: groupCaps(eGrants),
    projectGrants: groupCaps(pGrants),
    appGrants: groupCaps(aGrants),
  };
}

/**
 * Whether the PERSON holds `manage_team` in this team, straight off the junction —
 * deliberately NOT through `membershipFor`, whose set is clamped to the API token
 * making the request.
 */
export async function holdsManageTeam(
  userId: string,
  teamId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ capability: membershipCapabilitiesTable.capability })
    .from(membershipCapabilitiesTable)
    .innerJoin(
      membershipsTable,
      eq(membershipsTable.id, membershipCapabilitiesTable.membershipId),
    )
    .where(
      and(
        eq(membershipsTable.userId, userId),
        eq(membershipsTable.teamId, teamId),
        eq(membershipCapabilitiesTable.capability, "manage_team"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The team that owns a node, or null when it doesn't exist. */
async function teamOf(node: NodeRef): Promise<string | null> {
  const db = getDb();
  // An Environment carries no `team_id` of its own — it belongs to a Project,
  // and the team comes through it (ADR-0009).
  if (node.kind === "environment") {
    const rows = await db
      .select({ teamId: projectsTable.teamId })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, environmentsTable.projectId),
      )
      .where(eq(environmentsTable.id, node.id))
      .limit(1);
    return rows[0]?.teamId ?? null;
  }
  const table =
    node.kind === "app"
      ? appsTable
      : node.kind === "folder"
        ? foldersTable
        : projectsTable;
  const rows = await db
    .select({ teamId: table.teamId })
    .from(table)
    .where(eq(table.id, node.id))
    .limit(1);
  return rows[0]?.teamId ?? null;
}

/* ------------------------------------------------------------------ */
/* Resolution (one implementation, shared by every caller)             */
/* ------------------------------------------------------------------ */

/**
 * The ancestor ladder for a node, most specific first: the app itself, then its
 * folder chain, then its ENVIRONMENT, then the Project container. An app filed
 * into a FOLDER has no environment, so the two never both apply.
 */
function ladder(
  index: GrantIndex,
  node: {
    kind: NodeRef["kind"];
    id: string;
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  },
): {
  kind: NodeRef["kind"];
  id: string;
  owner: boolean;
  grants: Capability[];
}[] {
  const rungs: {
    kind: NodeRef["kind"];
    id: string;
    owner: boolean;
    grants: Capability[];
  }[] = [];
  let projectId = node.projectId ?? null;

  if (node.kind === "app") {
    rungs.push({
      kind: "app",
      id: node.id,
      owner: false, // an App has no owner column
      grants: index.appGrants.get(node.id) ?? [],
    });
  }

  // The environment rung: the app's own, or the environment node itself.
  const environmentId =
    node.kind === "environment" ? node.id : (node.environmentId ?? null);
  if (environmentId && node.kind !== "folder") {
    rungs.push({
      kind: "environment",
      id: environmentId,
      owner: false, // an Environment has no owner column
      grants: index.environmentGrants.get(environmentId) ?? [],
    });
    projectId = index.environmentProjects.get(environmentId) ?? projectId;
  }

  // A folder's own `project_id` wins over the app's: filing an app into a folder
  // CLEARS its `project_id`, so the folder is the only thing that still knows
  // which container it belongs to.
  const start = node.kind === "folder" ? node.id : (node.folderId ?? null);
  const seen = new Set<string>();
  let cursor: string | null = start;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const f = index.folders.get(cursor);
    if (!f) break;
    rungs.push({
      kind: "folder",
      id: cursor,
      owner: f.ownerUserId === index.userId,
      grants: index.folderGrants.get(cursor) ?? [],
    });
    if (!projectId && f.projectId) projectId = f.projectId;
    cursor = f.parentId;
  }

  if (node.kind === "project") projectId = node.id;
  if (projectId && index.projectOwners.has(projectId)) {
    rungs.push({
      kind: "project",
      id: projectId,
      owner: index.projectOwners.get(projectId) === index.userId,
      grants: index.projectGrants.get(projectId) ?? [],
    });
  }
  return rungs;
}

/**
 * Whether this person holds something of their own on the node or an ancestor —
 * ownership, or a grant row.
 */
function hasOwnGrant(
  index: GrantIndex,
  node: {
    kind: NodeRef["kind"];
    id: string;
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  },
): boolean {
  return ladder(index, node).some((r) => r.owner || r.grants.length > 0);
}

/**
 * Whether the member's ROLE reaches this node at all.
 */
function reachesNode(
  index: GrantIndex,
  node: {
    kind: NodeRef["kind"];
    id: string;
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  },
): boolean {
  if (index.instanceAdmin || !index.roleScope) return true;
  if (node.kind === "app")
    return appInScope(index.roleScope, {
      id: node.id,
      folderId: node.folderId ?? null,
      projectId: node.projectId ?? null,
      environmentId: node.environmentId ?? null,
    });
  if (node.kind === "folder") return folderInScope(index.roleScope, node.id);
  if (node.kind === "environment")
    return (
      environmentInScope(index.roleScope, node.id) ||
      // …or its project, which covers every environment inside it.
      projectInScope(
        index.roleScope,
        index.environmentProjects.get(node.id) ?? null,
      )
    );
  return projectInScope(index.roleScope, node.id);
}

/** Walk the ladder. See the module docblock for the rules it implements. */
function resolveFrom(
  index: GrantIndex,
  node: {
    kind: NodeRef["kind"];
    id: string;
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  },
): Capability[] {
  const clamp = (caps: Capability[]) =>
    withView(clampCapabilitiesToToken(caps, index.userId, index.teamId));

  // REACH first: outside the role's scope nothing exists, which is the same empty
  // answer a folder they were never shown gives, so neither can be told from the
  // other.
  if (!reachesNode(index, node) && !hasOwnGrant(index, node)) return [];

  // Super-user: their full team set on every node, grants and folder privacy
  // alike. An instance admin who isn't a member still administers it, with
  // everything.
  if (index.superUser) {
    return clamp(index.base.length === 0 ? [...ALL_CAPABILITIES] : index.base);
  }

  const rungs = ladder(index, node);

  // Folder privacy: a folder is invisible unless you own one in the chain or hold a
  // grant on one.
  const folders = rungs.filter((r) => r.kind === "folder");
  if (
    folders.length > 0 &&
    !folders.some(
      (r) =>
        r.owner ||
        r.grants.length > 0 ||
        // Not `folderInScope`: a null scope means unrestricted, which must NOT
        // dissolve folder privacy for everyone who has no scope at all.
        Boolean(index.roleScope?.folderIds.includes(r.id)),
    )
  ) {
    return [];
  }

  // Most-specific-wins. An owned rung resolves to the base set (an owner holds no
  // grant rows); the first rung with grants replaces the base outright.
  for (const rung of rungs) {
    if (rung.owner) return clamp(index.base);
    if (rung.grants.length > 0) return clamp(rung.grants);
  }
  return clamp(index.base);
}

/** The `is_instance_admin` flag as stored, for hydrating SOMEONE ELSE's access. */
async function storedInstanceAdmin(userId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ isInstanceAdmin: usersTable.isInstanceAdmin })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return Boolean(rows[0]?.isInstanceAdmin);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

async function resolveOne(
  userId: string,
  node: NodeRef,
  admin: boolean,
  activeTeamId: string,
): Promise<Capability[]> {
  const teamId = await teamOf(node);
  // A node belonging to ANOTHER team does not exist for this request. `appGate` below
  // has always had this check (`app.teamId !== ctx.teamId`); the node resolver never
  // did, and the folder gates are its only unguarded users.
  if (!teamId || teamId !== activeTeamId) return [];
  const index = await buildIndex(userId, teamId, admin);
  if (!index) return [];

  if (node.kind !== "app") return resolveFrom(index, node);
  const rows = await getDb()
    .select({
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, node.id))
    .limit(1);
  return resolveFrom(index, {
    kind: "app",
    id: node.id,
    folderId: rows[0]?.folderId ?? null,
    projectId: rows[0]?.projectId ?? null,
    environmentId: rows[0]?.environmentId ?? null,
  });
}

/** The CURRENT caller's effective capabilities on a node. `[]` ⇒ no access,
 *  which now includes "the node is in a team this request is not acting in". */
export async function nodeCapabilities(node: NodeRef): Promise<Capability[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  const activeTeamId = await getActiveTeamId();
  if (!activeTeamId) return [];
  return resolveOne(user.id, node, await isInstanceAdmin(), activeTeamId);
}

/**
 * ANY user's effective capabilities on a node — for hydrating someone else's
 * access in an admin view. Naming it also keeps the boundary explicit rather than
 * optional — a `null` that meant "skip the check" is how the hole would come back.
 */
export async function nodeCapabilitiesFor(
  userId: string,
  teamId: string,
  node: NodeRef,
): Promise<Capability[]> {
  return resolveOne(userId, node, await storedInstanceAdmin(userId), teamId);
}

/**
 * The caller's capabilities on MANY apps of one team at once — five queries for
 * the whole set. For list pages that must drop the apps a member can't reach:
 * ask this instead of looping, or a fifty-app team becomes a fifty-fold fan-out.
 */
export async function appCapabilitiesForTeam(
  teamId: string,
  apps: AppPlacement[],
): Promise<Map<string, Capability[]>> {
  const out = new Map<string, Capability[]>();
  const user = await getCurrentUser();
  if (!user || apps.length === 0) return out;
  const index = await buildIndex(user.id, teamId, await isInstanceAdmin());
  if (!index) return out;
  for (const app of apps) {
    out.set(app.id, resolveFrom(index, { kind: "app", ...app }));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

/**
 * Gate a mutation on a Folder or Project node. Throws "not found" when the caller
 * can't reach it at all (never leak existence), else a permission error.
 */
export async function requireNodeCapability(
  node: NodeRef,
  cap: Capability,
): Promise<void> {
  const caps = await nodeCapabilities(node);
  const label =
    node.kind === "app" ? "App" : node.kind === "folder" ? "Folder" : "Project";
  if (caps.length === 0) throw new Error(`${label} not found`);
  if (!caps.includes(cap)) {
    throw new Error(
      `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()} here`,
    );
  }
}

/**
 * THE gate for anything that lives under an App: membership + 2FA, the app is in
 * the active team, the API token's scope reaches it, and the caller holds `cap` ON
 * THAT APP.
 */
export async function requireAppCapability(
  appId: string,
  cap: Capability,
): Promise<ActiveMembership> {
  const gate = await appGate(appId);
  // An app that isn't there, isn't ours, isn't in the request's token scope, or
  // sits in a folder the caller can't see all answer the same thing — the gate is
  // never an oracle for which ids exist.
  if (!gate || gate.caps.length === 0) throw new Error("App not found");
  // Confirmed for deletion (`apps.deleting_at`): the teardown is running behind the
  // response and the row is on its way out.
  if (gate.deleting) throw new Error("This app is being deleted");
  // Still arriving: a migration is writing this row and copying data into its
  // volumes, and the whole run can still be taken back out.
  assertNotMigrating("app", gate.name, gate.migrationRunId);
  if (!gate.caps.includes(cap)) {
    throw new Error(
      gate.folderId
        ? `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()} in this folder`
        : `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()}`,
    );
  }
  return gate.ctx;
}

/**
 * Everything the caller may do to ONE app - the read-side twin of {@link
 * requireAppCapability}, answering `[]` instead of throwing when the app isn't
 * reachable (gone, another team, out of the token's scope, in a folder they can't
 * see, or they aren't a member at all). **`[]` means "no access", never
 * "read-only"** - `view` is implied for anyone who can reach the app - so this
 * doubles as the visibility test that keeps an app inside a private folder out of
 * the UI entirely.
 */
export const appCapabilities = cache(async function appCapabilities(
  appId: string,
): Promise<Capability[]> {
  try {
    return (await appGate(appId))?.caps ?? [];
  } catch {
    // Not a member / 2FA unmet - the same answer as an app that isn't there.
    return [];
  }
});

/**
 * The soft twin of {@link requireAppCapability}, for READS that answer "nothing"
 * rather than throwing when the caller can't reach an app.
 */
export async function hasAppCapability(
  appId: string,
  cap: Capability,
): Promise<boolean> {
  return (await appCapabilities(appId)).includes(cap);
}

/** Membership + app ownership + token scope + the caller's caps ON the app. */
async function appGate(appId: string): Promise<{
  ctx: ActiveMembership;
  folderId: string | null;
  caps: Capability[];
  deleting: boolean;
  name: string;
  migrationRunId: string | null;
} | null> {
  const ctx = await requireMembership();
  const rows = await getDb()
    .select({
      teamId: appsTable.teamId,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      // Confirmed for deletion: the row is still here, the app is not. See the
      // refusal in requireAppCapability.
      deletingAt: appsTable.deletingAt,
      // Still being brought over by a migration: same idea as `deleting_at` one line up,
      // and the same refusal below. The name rides along because that refusal names the
      // app - "this app" reads as a bug when three of them arrive at once.
      name: appsTable.name,
      migrationRunId: appsTable.migrationRunId,
      // An app lives in exactly one place, and for an app inside a project that place is
      // its ENVIRONMENT.
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  const app = rows[0];
  if (
    !app ||
    app.teamId !== ctx.teamId ||
    !inAppScope({ id: appId, folderId: app.folderId, projectId: app.projectId })
  ) {
    return null;
  }
  const caps = await appCapabilitiesForTeam(ctx.teamId, [
    {
      id: appId,
      folderId: app.folderId ?? null,
      projectId: app.projectId ?? null,
      environmentId: app.environmentId ?? null,
    },
  ]);
  return {
    ctx,
    folderId: app.folderId ?? null,
    caps: caps.get(appId) ?? [],
    deleting: app.deletingAt != null,
    name: app.name,
    migrationRunId: app.migrationRunId ?? null,
  };
}
