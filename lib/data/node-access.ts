import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appGrants as appGrantsTable,
  apps as appsTable,
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  projectGrants as projectGrantsTable,
  projects as projectsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import {
  clampCapabilitiesToToken,
  isInstanceAdmin,
  membershipFor,
  requireMembership,
  type ActiveMembership,
} from "../membership";
import { inAppScope } from "../auth/request-context";
import { CAPABILITY_META } from "../membership-shared";
import { ALL_CAPABILITIES, type Capability } from "../types";

/**
 * Per-NODE authorization — what one person may do to one App, Folder or Project
 * container, as opposed to what their team role lets them do everywhere
 * (`lib/membership.ts`).
 *
 * **A node capability set REPLACES the team role's inside that node, and may
 * exceed it** (ADR-0016). Precedence is most-specific-wins:
 *
 *     app grant → nearest ancestor folder → further ancestors → project → membership
 *
 * The first rung that says anything wins outright; nothing said anywhere falls
 * through to the membership. `view` is implied at every rung, so an empty result
 * means "no access" and never "read-only".
 *
 * Two things this deliberately does NOT do:
 *
 *  - **It does not clamp a grant to the grantee's team capabilities.** That was
 *    the old rule, and it made "this person owns Prod and nothing else"
 *    unexpressible: to hand someone `manage_env` in one folder you had to hand it
 *    to them team-wide. The live clamp is now membership EXISTENCE, not its
 *    contents — removing them from the team, suspending them or an unmet 2FA
 *    policy still revokes everything, everywhere, live, because every path here
 *    goes through `membershipFor` first.
 *  - **It does not invent visibility.** A Folder stays private to its owner and
 *    its grantees (that is what an empty result means for `listFolders`); a
 *    Project or an App is as visible as it always was, so a grant on one is a
 *    capability override and nothing more.
 *
 * The set a grant may name is bounded to {@link NODE_GRANTABLE_CAPABILITIES} at
 * every write site, which is what stops a node from becoming a route back to
 * team administration.
 */

/** The three things a capability set can be attached to. */
export type NodeRef =
  | { kind: "app"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "project"; id: string };

/**
 * One rung of the precedence ladder, most specific first. `owner` means the user
 * owns this node, which resolves to their whole base set (an owner is not a
 * grantee and holds no grant rows).
 */
interface Rung {
  kind: NodeRef["kind"];
  id: string;
  owner: boolean;
  grants: Capability[];
}

/** The resolved shape of a node: which team owns it, and its ancestor ladder. */
interface Chain {
  teamId: string;
  rungs: Rung[];
  /** True when at least one folder is involved (folders carry the privacy rule). */
  hasFolder: boolean;
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
/* Chain building                                                      */
/* ------------------------------------------------------------------ */

/** Every folder in a team, keyed by id — one query, walked in memory. */
async function teamFolders(teamId: string): Promise<
  Map<string, { parentId: string | null; projectId: string | null; ownerUserId: string | null }>
> {
  const rows = await getDb()
    .select({
      id: foldersTable.id,
      parentId: foldersTable.parentId,
      projectId: foldersTable.projectId,
      ownerUserId: foldersTable.ownerUserId,
    })
    .from(foldersTable)
    .where(eq(foldersTable.teamId, teamId));
  return new Map(
    rows.map((r) => [
      r.id,
      {
        parentId: r.parentId ?? null,
        projectId: r.projectId ?? null,
        ownerUserId: r.ownerUserId ?? null,
      },
    ]),
  );
}

/**
 * The node's team plus its ancestor ladder, most specific first, with each rung's
 * ownership and grant rows filled in. Returns null when the node doesn't exist.
 *
 * The parent walk is cycle-safe (a `seen` set): `folders.parent_id` is a
 * self-reference with no database-level acyclicity guarantee, and a resolver that
 * hangs is a worse outage than one that stops early.
 */
async function buildChain(
  userId: string,
  node: NodeRef,
): Promise<Chain | null> {
  const db = getDb();

  let teamId: string;
  let appId: string | null = null;
  let folderId: string | null = null;
  let projectId: string | null = null;

  if (node.kind === "app") {
    const rows = await db
      .select({
        teamId: appsTable.teamId,
        folderId: appsTable.folderId,
        projectId: appsTable.projectId,
      })
      .from(appsTable)
      .where(eq(appsTable.id, node.id))
      .limit(1);
    if (!rows[0]) return null;
    teamId = rows[0].teamId;
    appId = node.id;
    folderId = rows[0].folderId ?? null;
    projectId = rows[0].projectId ?? null;
  } else if (node.kind === "folder") {
    const rows = await db
      .select({ teamId: foldersTable.teamId })
      .from(foldersTable)
      .where(eq(foldersTable.id, node.id))
      .limit(1);
    if (!rows[0]) return null;
    teamId = rows[0].teamId;
    folderId = node.id;
  } else {
    const rows = await db
      .select({ teamId: projectsTable.teamId })
      .from(projectsTable)
      .where(eq(projectsTable.id, node.id))
      .limit(1);
    if (!rows[0]) return null;
    teamId = rows[0].teamId;
    projectId = node.id;
  }

  // Walk the folder chain, nearest first. A folder's own `project_id` wins over
  // the app's: filing an app into a folder CLEARS its `project_id`, so the folder
  // is the only thing that still knows which container it belongs to.
  const folderIds: string[] = [];
  const folderOwners = new Map<string, string | null>();
  if (folderId) {
    const all = await teamFolders(teamId);
    const seen = new Set<string>();
    let cursor: string | null = folderId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const f = all.get(cursor);
      if (!f) break;
      folderIds.push(cursor);
      folderOwners.set(cursor, f.ownerUserId);
      if (!projectId && f.projectId) projectId = f.projectId;
      cursor = f.parentId;
    }
  }

  // Three grant lookups, each already narrowed to this user.
  const [appRows, folderRows, projectRows] = await Promise.all([
    appId
      ? db
          .select({ capability: appGrantsTable.capability })
          .from(appGrantsTable)
          .where(
            and(
              eq(appGrantsTable.appId, appId),
              eq(appGrantsTable.userId, userId),
            ),
          )
      : Promise.resolve([]),
    folderIds.length
      ? db
          .select({
            folderId: folderGrantsTable.folderId,
            capability: folderGrantsTable.capability,
          })
          .from(folderGrantsTable)
          .where(
            and(
              inArray(folderGrantsTable.folderId, folderIds),
              eq(folderGrantsTable.userId, userId),
            ),
          )
      : Promise.resolve([]),
    projectId
      ? db
          .select({ capability: projectGrantsTable.capability })
          .from(projectGrantsTable)
          .where(
            and(
              eq(projectGrantsTable.projectId, projectId),
              eq(projectGrantsTable.userId, userId),
            ),
          )
      : Promise.resolve([]),
  ]);

  const byFolder = new Map<string, Capability[]>();
  for (const r of folderRows) {
    const list = byFolder.get(r.folderId) ?? [];
    list.push(r.capability as Capability);
    byFolder.set(r.folderId, list);
  }

  const rungs: Rung[] = [];
  if (appId) {
    rungs.push({
      kind: "app",
      id: appId,
      owner: false, // an App has no owner column
      grants: appRows.map((r) => r.capability as Capability),
    });
  }
  for (const id of folderIds) {
    rungs.push({
      kind: "folder",
      id,
      owner: folderOwners.get(id) === userId,
      grants: byFolder.get(id) ?? [],
    });
  }
  if (projectId) {
    const owner = await projectOwnedBy(projectId, userId);
    rungs.push({
      kind: "project",
      id: projectId,
      owner,
      grants: projectRows.map((r) => r.capability as Capability),
    });
  }

  return { teamId, rungs, hasFolder: folderIds.length > 0 };
}

/** True when `userId` owns the Project container. */
async function projectOwnedBy(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ ownerUserId: projectsTable.ownerUserId })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId))
    .limit(1);
  return rows[0]?.ownerUserId === userId;
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
/* Effective capabilities (the single source of truth)                 */
/* ------------------------------------------------------------------ */

async function resolve(
  userId: string,
  node: NodeRef,
  admin: boolean,
): Promise<Capability[]> {
  const chain = await buildChain(userId, node);
  if (!chain) return [];

  // THE gate, first and always: membership existence carries the 2FA policy and
  // the "are they still in this team" question, and nothing below can survive it.
  const membership = await membershipFor(userId, chain.teamId);
  const base = membership?.capabilities ?? [];
  if (!admin && base.length === 0) return [];

  // Super-user (instance admin, or a member holding `manage_team`): their full
  // team set on every node, grants and folder privacy alike. An instance admin
  // who isn't a member of this team still administers it, with everything.
  if (admin || base.includes("manage_team")) {
    return withView(admin && base.length === 0 ? ALL_CAPABILITIES : base);
  }

  // Folder privacy, unchanged: a folder is invisible unless you own one in the
  // chain or hold a grant on one. A grant on an ancestor reaches its subtree,
  // which is what the scope tree the admin ticks in draws.
  if (chain.hasFolder) {
    const reachable = chain.rungs.some(
      (r) => r.kind === "folder" && (r.owner || r.grants.length > 0),
    );
    if (!reachable) return [];
  }

  // Most-specific-wins. An owned rung resolves to the base set (an owner holds no
  // grant rows); the first rung with grants replaces the base outright.
  for (const rung of chain.rungs) {
    if (rung.owner) return withView(clamp(base, userId, chain.teamId));
    if (rung.grants.length > 0) {
      return withView(clamp(rung.grants, userId, chain.teamId));
    }
  }
  return withView(clamp(base, userId, chain.teamId));
}

/**
 * The API-token intersection, applied here because a node grant REPLACES the
 * membership set and so never passes through `membershipFor`'s own clamp. Without
 * it a CI token holding only `deploy_apps` would inherit its creator's
 * `manage_env` grant on a folder. `base` is already clamped, so re-applying it
 * there is a no-op.
 */
function clamp(caps: Capability[], userId: string, teamId: string): Capability[] {
  return clampCapabilitiesToToken(caps, userId, teamId);
}

/** The CURRENT caller's effective capabilities on a node. `[]` ⇒ no access. */
export async function nodeCapabilities(node: NodeRef): Promise<Capability[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  return resolve(user.id, node, await isInstanceAdmin());
}

/**
 * ANY user's effective capabilities on a node — for hydrating someone else's
 * access in an admin view. Uses the stored instance-admin flag rather than
 * {@link isInstanceAdmin}, which additionally asks whether the API token making
 * THIS request may act as an admin; that question is about the caller, not about
 * the person being displayed.
 */
export async function nodeCapabilitiesFor(
  userId: string,
  node: NodeRef,
): Promise<Capability[]> {
  return resolve(userId, node, await storedInstanceAdmin(userId));
}

/* ------------------------------------------------------------------ */
/* Gates                                                               */
/* ------------------------------------------------------------------ */

/**
 * Gate a mutation on a node. Throws "not found" when the caller can't reach it at
 * all (never leak existence), else a user-facing permission error.
 */
export async function requireNodeCapability(
  node: NodeRef,
  cap: Capability,
): Promise<void> {
  const caps = await nodeCapabilities(node);
  const label = node.kind === "app" ? "App" : node.kind === "folder" ? "Folder" : "Project";
  if (caps.length === 0) throw new Error(`${label} not found`);
  if (!caps.includes(cap)) {
    throw new Error(
      `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()} here`,
    );
  }
}

/**
 * THE gate for anything that lives under an App: membership + 2FA, the app is in
 * the active team, the API token's scope reaches it, and the caller holds `cap`
 * ON THAT APP. Returns what `requireCapability` returns, so it is a drop-in
 * replacement for the `requireCapability` + `appInTeam` + folder-gate triple.
 *
 * It cannot be split back into "team check, then node check": a node grant may
 * exceed the team role, so a team-level check would refuse before the node was
 * ever consulted. That is why the 71 app-shaped call sites route through here and
 * the team-wide ones keep `requireCapability`.
 */
export async function requireAppCapability(
  appId: string,
  cap: Capability,
): Promise<ActiveMembership> {
  const ctx = await requireMembership();

  const rows = await getDb()
    .select({
      teamId: appsTable.teamId,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  const app = rows[0];
  // A foreign id, or one the request's token scope doesn't reach, answers exactly
  // what a nonexistent id answers — the scope is never an oracle for what exists.
  if (
    !app ||
    app.teamId !== ctx.teamId ||
    !inAppScope({ id: appId, folderId: app.folderId, projectId: app.projectId })
  ) {
    throw new Error("App not found");
  }

  const caps = await nodeCapabilities({ kind: "app", id: appId });
  // An invisible folder makes the app inside it off-limits; don't leak that the
  // app exists through a capability-specific message.
  if (caps.length === 0) throw new Error("App not found");
  if (!caps.includes(cap)) {
    throw new Error(
      app.folderId
        ? `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()} in this folder`
        : `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()}`,
    );
  }
  return ctx;
}
