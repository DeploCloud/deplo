import "server-only";

import { cache } from "react";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appGrants as appGrantsTable,
  apps as appsTable,
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
  folderInScope,
  projectInScope,
  roleScopeFor,
  type NodeScope,
} from "./node-scope";
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
 * The set a grant may name is bounded to `NODE_GRANTABLE_CAPABILITIES` at every
 * write site, which is what stops a node from becoming a route back to team
 * administration.
 *
 * Everything below resolves through ONE {@link GrantIndex} — every folder, grant
 * and ownership row for a (user, team) pair, loaded in a fixed five queries. A
 * single node builds a small index; a whole page's worth of apps builds one and
 * answers them all in memory, so the global Variables tab is five queries and not
 * five per app.
 */

/** The three things a capability set can be attached to. */
export type NodeRef =
  | { kind: "app"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "project"; id: string };

/** An app as the resolver needs it — the two columns that place it. */
export interface AppPlacement {
  id: string;
  folderId: string | null;
  projectId: string | null;
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
   *
   * Read from the PERSON's stored capabilities, not the token-clamped ones —
   * REACH is a property of the human, POWER is what the token narrows. A
   * super-user acting through a token scoped to one folder must still see that
   * folder (they see it in the dashboard), while what they may DO there stays
   * clamped to the token, because `resolveFrom` returns the clamped `base`.
   * Reading the clamped set here instead made every narrowed token blind to
   * every folder, which is why the list paths used to skip this check entirely
   * for a narrowed token — and skipping it is what let a token scoped to a
   * folder its creator cannot see read the apps inside.
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
    { parentId: string | null; projectId: string | null; ownerUserId: string | null }
  >;
  projectOwners: Map<string, string | null>;
  folderGrants: Map<string, Capability[]>;
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
  const [folderRows, projectRows, fGrants, pGrants, aGrants, superUser, roleScope] =
    await Promise.all([
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
      roleScopeFor(userId, teamId),
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
    projectOwners: new Map(projectRows.map((p) => [p.id, p.ownerUserId ?? null])),
    folderGrants: groupCaps(fGrants),
    projectGrants: groupCaps(pGrants),
    appGrants: groupCaps(aGrants),
  };
}

/**
 * Whether the PERSON holds `manage_team` in this team, straight off the
 * junction — deliberately NOT through `membershipFor`, whose set is clamped to
 * the API token making the request.
 *
 * Reach is a property of the human and power is what the token narrows: a
 * super-user acting through a scoped token must still SEE every folder (they see
 * them in the dashboard), while what they may do there stays clamped. Shared
 * with `lib/data/folder-access.ts`, which asks the same question.
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
 * folder chain, then the Project container. Cycle-safe — `folders.parent_id` is a
 * self-reference with no acyclicity guarantee, and a resolver that hangs is a
 * worse outage than one that stops early.
 */
function ladder(
  index: GrantIndex,
  node: { kind: NodeRef["kind"]; id: string; folderId?: string | null; projectId?: string | null },
): { kind: NodeRef["kind"]; id: string; owner: boolean; grants: Capability[] }[] {
  const rungs: { kind: NodeRef["kind"]; id: string; owner: boolean; grants: Capability[] }[] = [];
  let projectId = node.projectId ?? null;

  if (node.kind === "app") {
    rungs.push({
      kind: "app",
      id: node.id,
      owner: false, // an App has no owner column
      grants: index.appGrants.get(node.id) ?? [],
    });
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
 *
 * A node grant EXTENDS reach rather than intersecting with it, which is the one
 * contentious rule of the model and the right one for two reasons. Intersecting
 * would silently revoke every live folder share the moment its holder was put on
 * a scoped role, which is a data-destroying default; and a grant is a deliberate
 * act by someone who holds the node, so refusing it because of an unrelated role
 * scope would make the Share dialog lie about what it just saved. Safety is kept
 * elsewhere: `NODE_GRANTABLE_CAPABILITIES` keeps every team-administration
 * capability off a node, so extending reach can never extend the team-wide
 * surface.
 */
function hasOwnGrant(
  index: GrantIndex,
  node: { kind: NodeRef["kind"]; id: string; folderId?: string | null; projectId?: string | null },
): boolean {
  return ladder(index, node).some((r) => r.owner || r.grants.length > 0);
}

/**
 * Whether the member's ROLE reaches this node at all. Answered before anything
 * else in {@link resolveFrom}, including the super-user branch, and the order is
 * load-bearing: `holdsManageTeam` deliberately reads the person's raw, unclamped
 * junction row, so a member whose role is limited to one project but who still
 * held `manage_team` would otherwise resolve the whole team here. Writing a
 * scoped role clamps that capability away at the source, and this is the second
 * lock on the same door.
 *
 * An instance admin is exempt because they are not a member acting under a team
 * role — they administer the instance, and every other cross-team guard in this
 * file (`resolveOne`, `appGate`) still applies to them.
 */
function reachesNode(
  index: GrantIndex,
  node: { kind: NodeRef["kind"]; id: string; folderId?: string | null; projectId?: string | null },
): boolean {
  if (index.instanceAdmin || !index.roleScope) return true;
  if (node.kind === "app")
    return appInScope(index.roleScope, {
      id: node.id,
      folderId: node.folderId ?? null,
      projectId: node.projectId ?? null,
    });
  if (node.kind === "folder") return folderInScope(index.roleScope, node.id);
  return projectInScope(index.roleScope, node.id);
}

/** Walk the ladder. See the module docblock for the rules it implements. */
function resolveFrom(
  index: GrantIndex,
  node: { kind: NodeRef["kind"]; id: string; folderId?: string | null; projectId?: string | null },
): Capability[] {
  const clamp = (caps: Capability[]) =>
    withView(clampCapabilitiesToToken(caps, index.userId, index.teamId));

  // REACH first: outside the role's scope nothing exists, which is the same
  // empty answer a folder they were never shown gives, so neither can be told
  // from the other. A node grant is what puts a node BACK in reach (ADR-0016
  // says a grant may exceed the role), so it is checked below, not here.
  if (!reachesNode(index, node) && !hasOwnGrant(index, node)) return [];

  // Super-user: their full team set on every node, grants and folder privacy
  // alike. An instance admin who isn't a member still administers it, with
  // everything.
  if (index.superUser) {
    return clamp(index.base.length === 0 ? [...ALL_CAPABILITIES] : index.base);
  }

  const rungs = ladder(index, node);

  // Folder privacy: a folder is invisible unless you own one in the chain or
  // hold a grant on one. A grant on an ancestor reaches its subtree, which is
  // the tree the admin ticks in.
  //
  // A role SCOPE naming the folder satisfies it too, and has to: an admin who
  // limits a role to "Prod" is saying its holders work there, so hiding Prod
  // from them would make the scope useless at the one place it is most wanted.
  // It grants no power — what they may DO there is still their role's set, or a
  // grant's when there is one.
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
  // A node belonging to ANOTHER team does not exist for this request. Taking the
  // team from the node and answering from the caller's membership THERE is how a
  // read-only token minted in one team deleted a folder in another: the token
  // clamp keys on the (user, team) pair, so it goes silent the moment the team
  // under test is not the one the token authenticated into, and the caller is
  // resolved with their full human permissions in the other team. `appGate`
  // below has always had this check (`app.teamId !== ctx.teamId`); the node
  // resolver never did, and the folder gates are its only unguarded users.
  //
  // Instance admins are NOT exempt, exactly as they are not in `appGate`: reach
  // across teams is switching team, not passing an id from one.
  if (!teamId || teamId !== activeTeamId) return [];
  const index = await buildIndex(userId, teamId, admin);
  if (!index) return [];

  if (node.kind !== "app") return resolveFrom(index, node);
  const rows = await getDb()
    .select({ folderId: appsTable.folderId, projectId: appsTable.projectId })
    .from(appsTable)
    .where(eq(appsTable.id, node.id))
    .limit(1);
  return resolveFrom(index, {
    kind: "app",
    id: node.id,
    folderId: rows[0]?.folderId ?? null,
    projectId: rows[0]?.projectId ?? null,
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
 * access in an admin view. Uses the stored instance-admin flag rather than
 * {@link isInstanceAdmin}, which additionally asks whether the API token making
 * THIS request may act as an admin; that question is about the caller, not about
 * the person being displayed.
 *
 * The team is an ARGUMENT here, not read from the request: this is the seam the
 * subscriptions use, and it must not touch cookies (see `reachableByUser` in
 * ./apps.ts). Naming it also keeps the boundary explicit rather than optional —
 * a `null` that meant "skip the check" is how the hole would come back.
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
 * the active team, the API token's scope reaches it, and the caller holds `cap`
 * ON THAT APP. Returns what `requireCapability` returns, so it is a drop-in
 * replacement for the `requireCapability` + `appInTeam` + folder-gate triple.
 *
 * It cannot be split back into "team check, then node check": a node grant may
 * exceed the team role, so a team-level check would refuse before the node was
 * ever consulted. That is why the app-shaped call sites route through here and
 * the team-wide ones keep `requireCapability`.
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
 * Everything the caller may do to ONE app - the read-side twin of
 * {@link requireAppCapability}, answering `[]` instead of throwing when the app
 * isn't reachable (gone, another team, out of the token's scope, in a folder
 * they can't see, or they aren't a member at all).
 *
 * **`[]` means "no access", never "read-only"** - `view` is implied for anyone
 * who can reach the app - so this doubles as the visibility test that keeps an
 * app inside a private folder out of the UI entirely.
 *
 * Request-cached: the page, its layout and every gate below it ask the same
 * question, and one render should cost one resolution, not one per asker.
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
} | null> {
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
  if (
    !app ||
    app.teamId !== ctx.teamId ||
    !inAppScope({ id: appId, folderId: app.folderId, projectId: app.projectId })
  ) {
    return null;
  }
  const caps = await appCapabilitiesForTeam(ctx.teamId, [
    { id: appId, folderId: app.folderId ?? null, projectId: app.projectId ?? null },
  ]);
  return {
    ctx,
    folderId: app.folderId ?? null,
    caps: caps.get(appId) ?? [],
  };
}
