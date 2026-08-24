import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  folders as foldersTable,
  folderGrants as folderGrantsTable,
  memberships as membershipsTable,
  apps as appsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { assertUser, getCurrentUser } from "../auth";
import { getActiveTeamId, isInstanceAdmin, membershipFor } from "../membership";
import {
  CAPABILITY_META,
  NODE_GRANTABLE_CAPABILITIES,
  boundedBy,
} from "../membership-shared";
import { holdsManageTeam, nodeCapabilities, withView } from "./node-access";
import { memberScopeFor } from "./node-scope";
import { avatarResolver, avatarUrlFor } from "../avatar";
import { type Capability } from "../types";

/**
 * Per-folder authorization — the folder half of the node model in
 * {@link module:lib/data/node-access}, which owns the maths for all three node
 * kinds (App, Folder, Project) and is where the precedence rules are documented.
 *
 * A folder is owned by whoever created it ({@link foldersTable.ownerUserId}) and
 * carries its own capability set. The owner may hand capabilities to OTHER team
 * members via the `folder_grants` junction, but never more than the granter
 * themselves holds on that folder. A member with `manage_team` (or an instance
 * admin) is a folder super-user: they see and manage every folder regardless of
 * ownership.
 *
 * **What a grant means changed in ADR-0016.** It used to be clamped live by the
 * grantee's team capabilities, so it could only ever narrow and revoking a team
 * capability revoked it everywhere. It now REPLACES the team role's set inside
 * the folder and may exceed it — which is the only way to say "this person owns
 * Prod and nothing else" without handing them the capability team-wide. What
 * still revokes everything, live, is losing the membership itself: removal,
 * suspension, or an unmet 2FA policy.
 *
 * The single source of truth is {@link folderCapabilities} — a thin delegate to
 * `nodeCapabilities`. Every gate and every visibility decision derives from it,
 * and an empty array means "no access", doubling as the folder-not-visible
 * signal that keeps folders private.
 */

/** A folder access grant as surfaced to the Share UI. */
export interface FolderGrant {
  folderId: string;
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  /** Resolved picture: uploaded image, else Gravatar, else null for the monogram. */
  avatarUrl: string | null;
  /** The capabilities this user holds on the folder, exactly as granted. */
  capabilities: Capability[];
  /** True for the owner row (implicit, never stored in `folder_grants`). */
  isOwner: boolean;
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for unit tests)                              */
/* ------------------------------------------------------------------ */

/**
 * Intersect `caps` with `bound` — how a per-folder capability set is clamped to a
 * user's live team caps (and how a grant is clamped to what the granter holds).
 * Lives in `membership-shared` because `lib/membership.ts` needs it too for the
 * API-token clamp and cannot import this module. Re-exported here so the folder
 * story reads in one place.
 */
export { boundedBy };

/** {@link module:lib/data/node-access}'s `view` floor, re-exported for callers here. */
export { withView };

/* ------------------------------------------------------------------ */
/* Internal lookups                                                    */
/* ------------------------------------------------------------------ */

/** A folder's team + owner in one query, or null when it doesn't exist. */
async function folderRow(
  folderId: string,
): Promise<{ teamId: string; ownerUserId: string | null } | null> {
  // Scoped to the ACTIVE team, not merely looked up by id. This is the second
  // place a folder id used to name its own team: the sharing gates
  // (requireFolderOwnerOrAdmin, folderIsOwnerOrAdmin) read `teamId` from the row
  // and then asked the caller's membership THERE, so an id from another team
  // answered with the caller's permissions in that other team. `null` here means
  // "no such folder", which is the answer every caller already handles and the
  // one that never leaks whether the id exists somewhere else.
  const activeTeamId = await getActiveTeamId();
  if (!activeTeamId) return null;
  const rows = await getDb()
    .select({
      teamId: foldersTable.teamId,
      ownerUserId: foldersTable.ownerUserId,
    })
    .from(foldersTable)
    .where(and(eq(foldersTable.id, folderId), eq(foldersTable.teamId, activeTeamId)))
    .limit(1);
  const f = rows[0];
  return f ? { teamId: f.teamId, ownerUserId: f.ownerUserId ?? null } : null;
}

/** A user's live team capabilities in a team (empty if not a member). */
async function teamCapsFor(
  userId: string,
  teamId: string,
): Promise<Capability[]> {
  const m = await membershipFor(userId, teamId);
  return m?.capabilities ?? [];
}

/**
 * True if the given user is a folder super-user for `teamId` — an instance admin
 * OR a member holding `manage_team`. Such a user sees and manages every folder in
 * the team regardless of ownership.
 */
async function isFolderSuperUser(
  userId: string,
  teamId: string,
  admin: boolean,
): Promise<boolean> {
  if (admin) return true;
  // The token-CLAMPED capability on purpose. This answers the sharing question
  // ({@link requireFolderOwnerOrAdmin}), which consults no capability of its own
  // — so a token that was never given `manage_team` must not inherit the power
  // to re-share someone else's folder from the person who minted it. Visibility
  // asks a different question and reads the person: see {@link visibleFolderIds}.
  return (await teamCapsFor(userId, teamId)).includes("manage_team");
}

/* ------------------------------------------------------------------ */
/* Effective capabilities (the single source of truth)                 */
/* ------------------------------------------------------------------ */

/**
 * The CURRENT caller's effective capabilities on `folderId`. Returns `[]` when
 * the folder doesn't exist, belongs to another team, or the caller has no access
 * — which also means "not visible".
 *
 * Precedence lives in {@link nodeCapabilities} (ADR-0016), summarised here:
 * super-user ⇒ their full team caps; owner ⇒ their full team caps; grantee ⇒
 * exactly what the nearest grant in the folder's ancestor chain says, which may
 * be more than their team role gives them.
 */
export async function folderCapabilities(
  folderId: string,
): Promise<Capability[]> {
  return nodeCapabilities({ kind: "folder", id: folderId });
}

/**
 * Gate a folder mutation on a specific capability. Throws "Folder not found" when
 * the caller can't see the folder at all (never leak existence), else a
 * user-facing permission error when the capability is absent. Returns the shape
 * the old `requireFolderManage` did so call sites keep their `{ teamId, userName }`.
 */
export async function requireFolderCapability(
  folderId: string,
  cap: Capability,
): Promise<{ teamId: string; userName: string }> {
  const caps = await folderCapabilities(folderId);
  if (caps.length === 0) throw new Error("Folder not found");
  if (!caps.includes(cap)) {
    throw new Error("You don't have permission to manage this folder");
  }
  const f = await folderRow(folderId);
  const userName = (await getCurrentUser())?.name ?? "Someone";
  return { teamId: f!.teamId, userName };
}

/** True if the caller can SEE the folder at all (owner, grantee, or super-user). */
export async function canSeeFolder(folderId: string): Promise<boolean> {
  return (await folderCapabilities(folderId)).length > 0;
}

/**
 * FOLDER-SCOPE a project action. Every project-action gate in the data layer
 * already asserts the TEAM capability (`requireCapability(cap)`); this adds the
 * folder dimension: when the project lives INSIDE a folder, the caller must ALSO
 * hold `cap` on that folder (owner, a grant that includes it, or super-user). A
 * top-level project (no folder) is unaffected — team caps alone govern it.
 *
 * So a member with team `manage_domains` but no access to the folder a project
 * sits in can no longer manage that project's domains: folder access scopes what
 * you can do to the apps inside it, not just the folder itself.
 *
 * Call this AFTER the team-level `requireCapability(cap)` (it does not re-check
 * team membership). Throws the same user-facing errors as `requireFolderCapability`
 * — "Folder not found" if the folder is invisible, a permission error otherwise.
 * A no-op for a missing/foreign project id (the surrounding team-scope check is
 * the authority on existence); pass a project you've already team-scoped.
 *
 * SUPERSEDED by `requireAppCapability` in `lib/data/node-access.ts`, which folds
 * the team check, the ownership check and this one into a single gate — the split
 * cannot survive a node grant that exceeds the team role, because the team check
 * would refuse first. Kept while the call sites migrate.
 */
export async function requireFolderCapabilityForApp(
  appId: string,
  cap: Capability,
): Promise<void> {
  if (!(await appExists(appId))) return; // the surrounding team scope owns existence
  const caps = await nodeCapabilities({ kind: "app", id: appId });
  // Invisible folder ⇒ the app inside it is off-limits; don't leak that the app
  // exists via a capability-specific message.
  if (caps.length === 0) throw new Error("App not found");
  if (!caps.includes(cap)) {
    throw new Error(
      `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()} in this folder`,
    );
  }
}

/** True when the app row exists at all (existence is the caller's business). */
async function appExists(appId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  return rows.length > 0;
}

/** True if the caller is the folder's owner OR a super-user (admin/manage_team). */
export async function folderIsOwnerOrAdmin(folderId: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const f = await folderRow(folderId);
  if (!f) return false;
  // `isInstanceAdmin()`, not the stored flag: administration is opt-in per API
  // token, and this answer has to match `requireFolderOwnerOrAdmin` — a Share
  // button that appears and then refuses is worse than one that never appeared.
  if (await isFolderSuperUser(user.id, f.teamId, await isInstanceAdmin()))
    return true;
  return f.ownerUserId === user.id;
}

/**
 * The set of folder ids in `teamId` the caller may SEE, or the sentinel `"all"`
 * for a super-user (who sees every folder). Three queries, no N+1 — used to
 * filter {@link listFolders}. A non-member (non-admin) sees nothing.
 *
 * A grant reaches the whole SUBTREE under the folder it names (ADR-0016): that is
 * the shape of the tree an admin ticks in, and of the token scope that already
 * expands folders the same way. So the owned/granted set is seeded first, then
 * every descendant is pulled in.
 */
export async function visibleFolderIds(
  teamId: string,
): Promise<Set<string> | "all"> {
  const user = await getCurrentUser();
  if (!user) return new Set();
  // VISIBILITY, not power: reach is a property of the person, and the token
  // narrows only what may be done with it. So `manage_team` is read unclamped
  // ({@link holdsManageTeam}) — otherwise a super-user's scoped token went blind
  // to every folder, which is what the list paths used to paper over by skipping
  // this check entirely for a narrowed token. The instance-admin flag stays
  // per-TOKEN (`tokenHoldsInstanceAdmin`), so a plain token minted by an admin
  // who is not a member here still sees nothing.
  const admin = await isInstanceAdmin();
  const scope = admin ? null : await memberScopeFor(user.id, teamId);
  // A scoped ROLE is not a super-user, whatever `manage_team` says. Writing a
  // scope clamps that capability away at the source, so this state should not
  // arise — and the sentinel is the one answer that would hand a limited member
  // every folder in the team, so it is checked here too rather than trusted.
  if (!scope && (admin || (await holdsManageTeam(user.id, teamId)))) return "all";
  // Not a super-user and not a member ⇒ nothing visible.
  if (!admin && (await teamCapsFor(user.id, teamId)).length === 0)
    return new Set();

  const visible = new Set<string>();
  // What the role reaches, before anything they own or were granted: those are
  // added below and EXTEND the scope rather than being filtered by it.
  for (const id of scope?.folderIds ?? []) visible.add(id);
  const owned = await getDb()
    .select({ id: foldersTable.id })
    .from(foldersTable)
    .where(
      and(
        eq(foldersTable.teamId, teamId),
        eq(foldersTable.ownerUserId, user.id),
      ),
    );
  for (const r of owned) visible.add(r.id);
  // Folders this user holds any grant on (join to scope grants to this team).
  const granted = await getDb()
    .select({ folderId: folderGrantsTable.folderId })
    .from(folderGrantsTable)
    .innerJoin(foldersTable, eq(foldersTable.id, folderGrantsTable.folderId))
    .where(
      and(
        eq(folderGrantsTable.userId, user.id),
        eq(foldersTable.teamId, teamId),
      ),
    );
  for (const r of granted) visible.add(r.folderId);
  if (visible.size === 0) return visible;

  // Pull in every descendant of what they can already reach. One query for the
  // team's parent links, then a fixpoint walk — bounded by the folder count, so
  // a cycle in `parent_id` can't spin it.
  const links = await getDb()
    .select({ id: foldersTable.id, parentId: foldersTable.parentId })
    .from(foldersTable)
    .where(eq(foldersTable.teamId, teamId));
  for (let pass = 0; pass < links.length; pass++) {
    let grew = false;
    for (const f of links) {
      if (f.parentId && visible.has(f.parentId) && !visible.has(f.id)) {
        visible.add(f.id);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return visible;
}

/* ------------------------------------------------------------------ */
/* Grant administration (owner / super-user only)                      */
/* ------------------------------------------------------------------ */

/**
 * Gate grant administration: the caller must be the folder OWNER or a super-user
 * (admin / `manage_team`). A grantee — even one holding every folder capability —
 * may NEVER re-share. Returns the folder's team + owner and the acting user id.
 */
async function requireFolderOwnerOrAdmin(folderId: string): Promise<{
  teamId: string;
  ownerUserId: string | null;
  actingUserId: string;
}> {
  const user = await assertUser();
  const f = await folderRow(folderId);
  if (!f) throw new Error("Folder not found");
  const admin = await isInstanceAdmin();
  // Ownership requires LIVE team membership: a folder's owner_user_id is NOT
  // cleared when the owner merely leaves the team (only on account deletion — see
  // the schema comment), so a bare `ownerUserId === user.id` would let an
  // ex-member keep administering sharing on a team they no longer belong to. Gate
  // on membership too, mirroring every members.ts grant path (which flows through
  // requireCapability/requireMembership). This also keeps this gate consistent
  // with folderCapabilities, which already denies a non-member everywhere else.
  const isOwner =
    f.ownerUserId === user.id &&
    (admin || (await teamCapsFor(user.id, f.teamId)).length > 0);
  if (!isOwner && !(await isFolderSuperUser(user.id, f.teamId, admin))) {
    // Don't leak existence to a caller who can't administer sharing.
    if (!(await canSeeFolder(folderId))) throw new Error("Folder not found");
    throw new Error("Only the folder owner can share this folder");
  }
  return { teamId: f.teamId, ownerUserId: f.ownerUserId ?? null, actingUserId: user.id };
}

/** Look up a user's public identity fields (for the grant DTOs). */
async function userIdentity(userId: string): Promise<{
  username: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
} | null> {
  const rows = await getDb()
    .select({
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
      // Consumed by `avatarUrl` and dropped — a grant DTO carries no email.
      image: usersTable.image,
      email: usersTable.email,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    username: r.username,
    name: r.name,
    avatarColor: r.avatarColor,
    avatarUrl: await avatarUrlFor(r),
  };
}

/**
 * The folder's owner (as an implicit `isOwner` row) plus every grantee, each with
 * the capabilities they actually hold here. Owner / super-user only.
 *
 * A grantee's row is what was GRANTED, not a copy silently narrowed by their team
 * role: since ADR-0016 the grant is what applies inside the folder, so showing the
 * intersection would have the Share dialog lie about what it just saved.
 */
export async function listFolderGrants(
  folderId: string,
): Promise<FolderGrant[]> {
  const { teamId, ownerUserId } = await requireFolderOwnerOrAdmin(folderId);
  const out: FolderGrant[] = [];

  if (ownerUserId) {
    const id = await userIdentity(ownerUserId);
    if (id) {
      out.push({
        folderId,
        userId: ownerUserId,
        username: id.username,
        name: id.name,
        avatarColor: id.avatarColor,
        avatarUrl: id.avatarUrl,
        // The owner's effective caps are their live team caps (+ view).
        capabilities: withView(await teamCapsFor(ownerUserId, teamId)),
        isOwner: true,
      });
    }
  }

  // Distinct grantees on this folder.
  const rows = await getDb()
    .select({
      userId: folderGrantsTable.userId,
      capability: folderGrantsTable.capability,
    })
    .from(folderGrantsTable)
    .where(eq(folderGrantsTable.folderId, folderId));
  const rawByUser = new Map<string, Capability[]>();
  for (const r of rows) {
    const list = rawByUser.get(r.userId) ?? [];
    list.push(r.capability as Capability);
    rawByUser.set(r.userId, list);
  }
  for (const [userId, raw] of rawByUser) {
    if (userId === ownerUserId) continue; // never double-list the owner
    const id = await userIdentity(userId);
    if (!id) continue;
    out.push({
      folderId,
      userId,
      username: id.username,
      name: id.name,
      avatarColor: id.avatarColor,
      avatarUrl: id.avatarUrl,
      capabilities: withView(raw),
      isOwner: false,
    });
  }
  return out;
}

/**
 * The capabilities the CURRENT caller may hand out on this folder — exactly their
 * own effective folder caps. Drives the Share dialog's checkbox set so a granter
 * can never offer a capability they don't hold. Owner / super-user only.
 */
export async function grantableFolderCapabilities(
  folderId: string,
): Promise<Capability[]> {
  await requireFolderOwnerOrAdmin(folderId);
  return folderCapabilities(folderId);
}

/**
 * Grant (or replace) a user's capabilities on a folder. Bounded by
 * `caps ∩ granterFolderCaps ∩ NODE_GRANTABLE_CAPABILITIES`, with `view` always
 * implied. The target must be a team member and not the owner. Owner /
 * super-user only. Returns the fresh grant list. When the bounded set is empty
 * the grant is removed entirely.
 *
 * The grantee's team capabilities are NOT a bound any more (ADR-0016): a grant
 * says what they may do inside this folder, which is the whole point of being
 * able to hand someone one corner of the fleet without widening their role. The
 * GRANTER's bound stays, and is what keeps it safe — nobody can hand out a
 * capability they don't themselves hold here, and a grantee may never re-share.
 * Membership is still required, because that is what the live revoke hangs on.
 */
export async function setFolderGrant(
  folderId: string,
  userId: string,
  caps: Capability[],
): Promise<FolderGrant[]> {
  const { teamId, ownerUserId } = await requireFolderOwnerOrAdmin(folderId);
  if (userId === ownerUserId)
    throw new Error("The folder owner already has full access");

  const targetTeamCaps = await teamCapsFor(userId, teamId);
  if (targetTeamCaps.length === 0)
    throw new Error("That user is not a member of this team");

  // What the granter may hand out = their own effective folder caps.
  const granterCaps = await folderCapabilities(folderId);
  const bounded = withView(
    boundedBy(boundedBy(caps, granterCaps), NODE_GRANTABLE_CAPABILITIES),
  );

  await getDb().transaction(async (tx) => {
    await tx
      .delete(folderGrantsTable)
      .where(
        and(
          eq(folderGrantsTable.folderId, folderId),
          eq(folderGrantsTable.userId, userId),
        ),
      );
    // `view` is implied for anyone with any access, so it's never stored as a
    // grant row — a grantee with only `view` would be indistinguishable from
    // someone with no grant at all. Persist just the real (non-`view`) caps; an
    // empty set leaves the delete above as a full revoke.
    const toStore = bounded.filter((c) => c !== "view");
    if (toStore.length > 0) {
      await tx
        .insert(folderGrantsTable)
        .values(toStore.map((c) => ({ folderId, userId, capability: c })));
    }
  });

  return listFolderGrants(folderId);
}

/**
 * Revoke a grantee's entire access to a folder. Removing the owner is a no-op
 * (ownership isn't a grant). Owner / super-user only. Returns the fresh list.
 */
export async function removeFolderGrant(
  folderId: string,
  userId: string,
): Promise<FolderGrant[]> {
  const { ownerUserId } = await requireFolderOwnerOrAdmin(folderId);
  if (userId !== ownerUserId) {
    await getDb()
      .delete(folderGrantsTable)
      .where(
        and(
          eq(folderGrantsTable.folderId, folderId),
          eq(folderGrantsTable.userId, userId),
        ),
      );
  }
  return listFolderGrants(folderId);
}

/**
 * Team members who could be granted access to a folder but aren't yet (and aren't
 * the owner), optionally filtered by a name/username query. Any folder owner may
 * call this (they need it to populate the Share dialog even without
 * `manage_members`). Owner / super-user only.
 */
export async function folderShareCandidates(
  folderId: string,
  query?: string,
): Promise<
  {
    userId: string;
    username: string;
    name: string;
    avatarColor: string;
    avatarUrl: string | null;
  }[]
> {
  const { teamId, ownerUserId } = await requireFolderOwnerOrAdmin(folderId);
  const rows = await getDb()
    .select({
      userId: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
      // Consumed by `avatarUrl` below and dropped.
      image: usersTable.image,
      email: usersTable.email,
    })
    .from(membershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, membershipsTable.userId))
    .where(eq(membershipsTable.teamId, teamId));

  const alreadyGranted = new Set(
    (
      await getDb()
        .select({ userId: folderGrantsTable.userId })
        .from(folderGrantsTable)
        .where(eq(folderGrantsTable.folderId, folderId))
    ).map((r) => r.userId),
  );

  const q = query?.trim().toLowerCase();
  const avatarUrl = await avatarResolver();
  return rows
    .filter((r) => r.userId !== ownerUserId && !alreadyGranted.has(r.userId))
    .filter(
      (r) =>
        !q ||
        r.username.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q),
    )
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((r) => ({
      userId: r.userId,
      username: r.username,
      name: r.name,
      avatarColor: r.avatarColor,
      avatarUrl: avatarUrl(r),
    }));
}
