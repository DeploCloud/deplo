import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  folders as foldersTable,
  folderGrants as folderGrantsTable,
  memberships as membershipsTable,
  services as servicesTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { assertUser, getCurrentUser } from "../auth";
import { membershipFor } from "../membership";
import { CAPABILITY_META } from "../membership-shared";
import { ALL_CAPABILITIES, type Capability } from "../types";

/**
 * Per-folder authorization — the folder analog of {@link module:lib/membership}.
 *
 * A folder is owned by whoever created it ({@link foldersTable.ownerUserId}) and
 * carries its own capability set. The owner may hand capabilities to OTHER team
 * members via the `folder_grants` junction, but NEVER more than the owner holds
 * on the folder, and NEVER more than the grantee holds at the team level. A
 * member with `manage_team` (or an instance admin) is a folder super-user: they
 * see and manage every folder regardless of ownership.
 *
 * The single source of truth is {@link folderCapabilities}: the CALLER's
 * effective capabilities on ONE folder, always bounded by their live team caps
 * (so revoking a team capability silently revokes it everywhere per-folder, and
 * nothing has to be re-materialized). Every gate and every visibility decision
 * derives from it. An empty array means "no access" and doubles as the
 * folder-not-visible signal.
 */

/** A folder access grant as surfaced to the Share UI. */
export interface FolderGrant {
  folderId: string;
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  /** Effective (team-bounded) capabilities this user holds on the folder. */
  capabilities: Capability[];
  /** True for the owner row (implicit, never stored in `folder_grants`). */
  isOwner: boolean;
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for unit tests)                              */
/* ------------------------------------------------------------------ */

/**
 * Intersect `caps` with `bound`, returned in canonical {@link ALL_CAPABILITIES}
 * order and de-duplicated. This is how a per-folder capability set is clamped to
 * a user's live team caps (and how a grant is clamped to what the granter holds).
 * Pure.
 */
export function boundedBy(caps: Capability[], bound: Capability[]): Capability[] {
  const allowed = new Set(bound);
  const wanted = new Set(caps);
  return ALL_CAPABILITIES.filter((c) => wanted.has(c) && allowed.has(c));
}

/**
 * Add the always-implied `view` capability, returning the set in canonical
 * order. Anyone who can reach a folder at all can at least read it. Pure.
 */
export function withView(caps: Capability[]): Capability[] {
  const set = new Set<Capability>(caps);
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

/* ------------------------------------------------------------------ */
/* Internal lookups                                                    */
/* ------------------------------------------------------------------ */

/** A folder's team + owner in one query, or null when it doesn't exist. */
async function folderRow(
  folderId: string,
): Promise<{ teamId: string; ownerUserId: string | null } | null> {
  const rows = await getDb()
    .select({
      teamId: foldersTable.teamId,
      ownerUserId: foldersTable.ownerUserId,
    })
    .from(foldersTable)
    .where(eq(foldersTable.id, folderId))
    .limit(1);
  const f = rows[0];
  return f ? { teamId: f.teamId, ownerUserId: f.ownerUserId ?? null } : null;
}

/** The raw (unbounded) folder-grant capabilities a user has on a folder. */
async function rawGrantsFor(
  folderId: string,
  userId: string,
): Promise<Capability[]> {
  const rows = await getDb()
    .select({ capability: folderGrantsTable.capability })
    .from(folderGrantsTable)
    .where(
      and(
        eq(folderGrantsTable.folderId, folderId),
        eq(folderGrantsTable.userId, userId),
      ),
    );
  return rows.map((r) => r.capability as Capability);
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
  return (await teamCapsFor(userId, teamId)).includes("manage_team");
}

/* ------------------------------------------------------------------ */
/* Effective capabilities (the single source of truth)                 */
/* ------------------------------------------------------------------ */

/**
 * The CURRENT caller's effective capabilities on `folderId`, always bounded by
 * their live team caps. Returns `[]` when the folder doesn't exist, belongs to
 * another team, or the caller has no access — which also means "not visible".
 *
 * Precedence (all include implied `view`):
 *  - instance admin / `manage_team` super-user ⇒ their full team caps (admins
 *    with no team membership get every capability);
 *  - owner ⇒ their full team caps;
 *  - grantee ⇒ their folder grants ∩ their team caps.
 */
export async function folderCapabilities(
  folderId: string,
): Promise<Capability[]> {
  const user = await getCurrentUser();
  if (!user) return [];
  const f = await folderRow(folderId);
  if (!f) return [];

  const admin = Boolean(user.isInstanceAdmin);
  const teamCaps = await teamCapsFor(user.id, f.teamId);
  // A non-admin who is not a member of the folder's team can never reach it.
  if (!admin && teamCaps.length === 0) return [];

  // Super-user (admin or manage_team): full team caps on ANY folder. An instance
  // admin with no membership of this team still manages it, with every capability.
  if (await isFolderSuperUser(user.id, f.teamId, admin)) {
    return withView(admin && teamCaps.length === 0 ? ALL_CAPABILITIES : teamCaps);
  }

  // Owner: everything they hold at the team level.
  if (f.ownerUserId && f.ownerUserId === user.id) {
    return withView(teamCaps);
  }

  // Grantee: their granted caps, clamped to their live team caps.
  const grants = await rawGrantsFor(folderId, user.id);
  if (grants.length === 0) return [];
  return withView(boundedBy(grants, teamCaps));
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
 * you can do to the services inside it, not just the folder itself.
 *
 * Call this AFTER the team-level `requireCapability(cap)` (it does not re-check
 * team membership). Throws the same user-facing errors as `requireFolderCapability`
 * — "Folder not found" if the folder is invisible, a permission error otherwise.
 * A no-op for a missing/foreign project id (the surrounding team-scope check is
 * the authority on existence); pass a project you've already team-scoped.
 */
export async function requireFolderCapabilityForService(
  serviceId: string,
  cap: Capability,
): Promise<void> {
  const folderId = await serviceFolderId(serviceId);
  if (!folderId) return; // top-level project → team caps already suffice
  const caps = await folderCapabilities(folderId);
  // Invisible folder ⇒ the project inside it is off-limits; don't leak that the
  // project exists via a capability-specific message.
  if (caps.length === 0) throw new Error("Service not found");
  if (!caps.includes(cap)) {
    throw new Error(
      `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()} in this folder`,
    );
  }
}

/** A project's containing folder id, or null when it's at the top level / absent. */
async function serviceFolderId(serviceId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ folderId: servicesTable.folderId })
    .from(servicesTable)
    .where(eq(servicesTable.id, serviceId))
    .limit(1);
  return rows[0]?.folderId ?? null;
}

/** True if the caller is the folder's owner OR a super-user (admin/manage_team). */
export async function folderIsOwnerOrAdmin(folderId: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const f = await folderRow(folderId);
  if (!f) return false;
  if (await isFolderSuperUser(user.id, f.teamId, Boolean(user.isInstanceAdmin)))
    return true;
  return f.ownerUserId === user.id;
}

/**
 * The set of folder ids in `teamId` the caller may SEE, or the sentinel `"all"`
 * for a super-user (who sees every folder). Two queries, no N+1 — used to filter
 * {@link listFolders}. A non-member (non-admin) sees nothing.
 */
export async function visibleFolderIds(
  teamId: string,
): Promise<Set<string> | "all"> {
  const user = await getCurrentUser();
  if (!user) return new Set();
  const admin = Boolean(user.isInstanceAdmin);
  if (await isFolderSuperUser(user.id, teamId, admin)) return "all";
  // Not a super-user and not a member ⇒ nothing visible.
  if (!admin && (await teamCapsFor(user.id, teamId)).length === 0)
    return new Set();

  const visible = new Set<string>();
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
  const admin = Boolean(user.isInstanceAdmin);
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
} | null> {
  const rows = await getDb()
    .select({
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The folder's owner (as an implicit `isOwner` row) plus every grantee, each with
 * their EFFECTIVE (team-bounded) capabilities. Owner / super-user only.
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
    const teamCaps = await teamCapsFor(userId, teamId);
    out.push({
      folderId,
      userId,
      username: id.username,
      name: id.name,
      avatarColor: id.avatarColor,
      capabilities: withView(boundedBy(raw, teamCaps)),
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
 * Grant (or replace) a user's capabilities on a folder. Double-bounded:
 * `caps ∩ granterFolderCaps ∩ granteeTeamCaps`, with `view` always implied. The
 * target must be a team member and not the owner. Owner / super-user only.
 * Returns the fresh grant list. When the bounded set is empty the grant is
 * removed entirely.
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
  // Double-bound: requested ∩ granter's ∩ target's team caps, +implied view.
  const bounded = withView(
    boundedBy(boundedBy(caps, granterCaps), targetTeamCaps),
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
): Promise<{ userId: string; username: string; name: string; avatarColor: string }[]> {
  const { teamId, ownerUserId } = await requireFolderOwnerOrAdmin(folderId);
  const rows = await getDb()
    .select({
      userId: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
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
  return rows
    .filter((r) => r.userId !== ownerUserId && !alreadyGranted.has(r.userId))
    .filter(
      (r) =>
        !q ||
        r.username.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q),
    )
    .sort((a, b) => a.username.localeCompare(b.username));
}
