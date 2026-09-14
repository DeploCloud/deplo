import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  folderGrants as folderGrantsTable,
  memberships as membershipsTable,
} from "../db/schema/control-plane/access-control";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { users as usersTable } from "../db/schema/control-plane/identity";
import { folders as foldersTable } from "../db/schema/control-plane/projects";
import { assertUser, getCurrentUser } from "../auth/current-user";
import { getActiveTeamId, isInstanceAdmin, membershipFor } from "../membership";
import {
  CAPABILITY_META,
  NODE_GRANTABLE_CAPABILITIES,
  boundedBy,
} from "../membership-shared";
import { holdsManageTeam, nodeCapabilities, withView } from "./node-access";
import { memberScopeFor } from "./node-scope";
import { avatarResolver, avatarUrlFor } from "../avatar";
import type { Capability } from "../types/identity";
import { inAppScope } from "../auth/request-context";

// A folder access grant as surfaced to the Share UI.
export interface FolderGrant {
  folderId: string;
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
  capabilities: Capability[];
  isOwner: boolean;
}

// Intersect `caps` with `bound` - how a folder capability set is clamped.
export { boundedBy };

// node-access's `view` floor, re-exported for callers here.
export { withView };

async function folderRow(
  folderId: string,
): Promise<{ teamId: string; ownerUserId: string | null } | null> {
  // Scoped to the ACTIVE team: `null` never leaks that the id exists in another team.
  const activeTeamId = await getActiveTeamId();
  if (!activeTeamId) return null;
  const rows = await getDb()
    .select({
      teamId: foldersTable.teamId,
      ownerUserId: foldersTable.ownerUserId,
    })
    .from(foldersTable)
    .where(
      and(eq(foldersTable.id, folderId), eq(foldersTable.teamId, activeTeamId)),
    )
    .limit(1);
  const f = rows[0];
  return f ? { teamId: f.teamId, ownerUserId: f.ownerUserId ?? null } : null;
}

async function teamCapsFor(
  userId: string,
  teamId: string,
): Promise<Capability[]> {
  const m = await membershipFor(userId, teamId);
  return m?.capabilities ?? [];
}

async function isFolderSuperUser(
  userId: string,
  teamId: string,
  admin: boolean,
): Promise<boolean> {
  if (admin) return true;
  // The token-CLAMPED capability on purpose.
  return (await teamCapsFor(userId, teamId)).includes("manage_team");
}

// The CURRENT caller's effective capabilities on `folderId`.
export async function folderCapabilities(
  folderId: string,
): Promise<Capability[]> {
  return nodeCapabilities({ kind: "folder", id: folderId });
}

// Gate a folder mutation on a capability; "Folder not found" never leaks existence.
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

// True if the caller can SEE the folder at all (owner, grantee, or super-user).
export async function canSeeFolder(folderId: string): Promise<boolean> {
  return (await folderCapabilities(folderId)).length > 0;
}

// FOLDER-SCOPE a project action - the same user-facing errors as `requireFolderCapability`.
export async function requireFolderCapabilityForApp(
  appId: string,
  cap: Capability,
): Promise<void> {
  const placement = await appPlacement(appId);
  if (!placement) return; // the surrounding team scope owns existence
  // A narrowed API token reaches nothing outside its scope, whatever the node grants say.
  if (!inAppScope({ id: appId, ...placement }))
    throw new Error("App not found");
  const caps = await nodeCapabilities({ kind: "app", id: appId });
  // Invisible folder: don't leak that the app exists via a capability-specific message.
  if (caps.length === 0) throw new Error("App not found");
  if (!caps.includes(cap)) {
    throw new Error(
      `You don't have permission to ${CAPABILITY_META[cap].label.toLowerCase()} in this folder`,
    );
  }
}

async function appPlacement(
  appId: string,
): Promise<{ folderId: string | null; projectId: string | null } | null> {
  const rows = await getDb()
    .select({ folderId: appsTable.folderId, projectId: appsTable.projectId })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  return rows[0] ?? null;
}

// True if the caller is the folder's owner OR a super-user (admin/manage_team).
export async function folderIsOwnerOrAdmin(folderId: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const f = await folderRow(folderId);
  if (!f) return false;
  // `isInstanceAdmin()`, not the stored flag: administration is opt-in per API token.
  if (await isFolderSuperUser(user.id, f.teamId, await isInstanceAdmin()))
    return true;
  return f.ownerUserId === user.id;
}

// The folder ids in `teamId` the caller may SEE, or `"all"` for a super-user.
export async function visibleFolderIds(
  teamId: string,
): Promise<Set<string> | "all"> {
  const user = await getCurrentUser();
  if (!user) return new Set();
  // VISIBILITY, not power: the token narrows only what may be done, never the reach.
  const admin = await isInstanceAdmin();
  const scope = admin ? null : await memberScopeFor(user.id, teamId);
  // A scoped ROLE is not a super-user, whatever `manage_team` says.
  if (!scope && (admin || (await holdsManageTeam(user.id, teamId))))
    return "all";
  if (!admin && (await teamCapsFor(user.id, teamId)).length === 0)
    return new Set();

  const visible = new Set<string>();
  // Owned and granted folders EXTEND the role's scope rather than being filtered by it.
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

  // Fixpoint walk bounded by the folder count, so a cycle in `parent_id` can't spin it.
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

// A grantee, even one holding every folder capability, may NEVER re-share.
async function requireFolderOwnerOrAdmin(folderId: string): Promise<{
  teamId: string;
  ownerUserId: string | null;
  actingUserId: string;
}> {
  const user = await assertUser();
  const f = await folderRow(folderId);
  if (!f) throw new Error("Folder not found");
  const admin = await isInstanceAdmin();
  // Ownership requires LIVE team membership: `owner_user_id` survives the owner leaving.
  const isOwner =
    f.ownerUserId === user.id &&
    (admin || (await teamCapsFor(user.id, f.teamId)).length > 0);
  if (!isOwner && !(await isFolderSuperUser(user.id, f.teamId, admin))) {
    // Don't leak existence to a caller who can't administer sharing.
    if (!(await canSeeFolder(folderId))) throw new Error("Folder not found");
    throw new Error("Only the folder owner can share this folder");
  }
  return {
    teamId: f.teamId,
    ownerUserId: f.ownerUserId ?? null,
    actingUserId: user.id,
  };
}

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
      // Consumed by `avatarUrl` and dropped - a grant DTO carries no email.
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

// The folder's owner (as an implicit `isOwner` row) plus every grantee.
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
        capabilities: withView(await teamCapsFor(ownerUserId, teamId)),
        isOwner: true,
      });
    }
  }

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
    if (userId === ownerUserId) continue;
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

// The capabilities the caller may hand out here - never one they don't hold themselves.
export async function grantableFolderCapabilities(
  folderId: string,
): Promise<Capability[]> {
  await requireFolderOwnerOrAdmin(folderId);
  return folderCapabilities(folderId);
}

// Grant (or replace) a user's capabilities on a folder; the target must be a team member.
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
    // `view` is never stored: a grantee with only `view` is indistinguishable from no grant.
    const toStore = bounded.filter((c) => c !== "view");
    if (toStore.length > 0) {
      await tx
        .insert(folderGrantsTable)
        .values(toStore.map((c) => ({ folderId, userId, capability: c })));
    }
  });

  return listFolderGrants(folderId);
}

// Revoke a grantee's entire access to a folder; removing the owner is a no-op.
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

// Team members who could be granted access to a folder but aren't yet.
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
