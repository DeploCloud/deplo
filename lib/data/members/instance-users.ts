import "server-only";

import { count, eq, or } from "drizzle-orm";
import { getDb } from "../../db/client";
import { memberships as membershipsTable } from "../../db/schema/control-plane/access-control";
import {
  teams as teamsTable,
  users as usersTable,
} from "../../db/schema/control-plane/identity";
import {
  passkey as passkeyTable,
  twoFactor as twoFactorTable,
} from "../../db/schema/auth";
import { setUserPassword } from "../../auth/password-credential";
import { revokeAllSessions } from "../../auth/session-records";
import { assertPasswordPolicy } from "../../password-policy";
import { assertPasswordNotPwned } from "../../pwned-password";
import { avatarResolver, avatarUrlFor, teamAvatarUrl } from "../../avatar";
import { instanceOwnerUserId } from "../instance-owner";
import { requireInstanceAdmin } from "../../membership";
import { recordForEveryTeamOf } from "./activity-actor";
import type { Role } from "../../types/identity";

/** A registered user as shown in the global Users list (no email). */
export interface GlobalUserDTO {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  /** Resolved picture: uploaded image, else Gravatar, else null for the monogram. */
  avatarUrl: string | null;
  teamCount: number;
  isInstanceAdmin: boolean;
  /** Owns the instance - their row is closed to every other admin. */
  isInstanceOwner: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  createdAt: string;
}

/** Full per-user detail for the admin user editor (email IS included here). */
export interface UserDetailDTO {
  userId: string;
  username: string;
  name: string;
  /** Shown ONLY in the admin detail view, never in lists or search. */
  email: string;
  avatarColor: string;
  avatarUrl: string | null;
  isInstanceAdmin: boolean;
  /** Owns the instance - their row is closed to every other admin. */
  isInstanceOwner: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  twoFactorEnabled: boolean;
  passkeyCount: number;
  createdAt: string;
  teams: {
    teamId: string;
    teamName: string;
    teamAvatarUrl: string | null;
    role: Role;
  }[];
}

/** Every registered user on the instance (no email exposed), for Settings → Users. */
export async function listAllUsers(): Promise<GlobalUserDTO[]> {
  await requireInstanceAdmin();
  const db = getDb();
  const users = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
      // Consumed by `avatarUrl` below and dropped - this list carries no email.
      image: usersTable.image,
      email: usersTable.email,
      isInstanceAdmin: usersTable.isInstanceAdmin,
      suspended: usersTable.suspended,
      canExposePorts: usersTable.canExposePorts,
      canMountHostVolumes: usersTable.canMountHostVolumes,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .orderBy(usersTable.createdAt);
  const counts = await db
    .select({
      userId: membershipsTable.userId,
      n: count(),
    })
    .from(membershipsTable)
    .groupBy(membershipsTable.userId);
  const countByUser = new Map(counts.map((c) => [c.userId, Number(c.n)]));
  const ownerUserId = await instanceOwnerUserId();
  const avatarUrl = await avatarResolver();
  return users.map((u) => ({
    userId: u.id,
    username: u.username,
    name: u.name,
    avatarColor: u.avatarColor,
    avatarUrl: avatarUrl(u),
    teamCount: countByUser.get(u.id) ?? 0,
    isInstanceAdmin: u.isInstanceAdmin ?? false,
    isInstanceOwner: u.id === ownerUserId,
    suspended: u.suspended ?? false,
    canExposePorts: u.canExposePorts ?? false,
    canMountHostVolumes: u.canMountHostVolumes ?? false,
    createdAt: u.createdAt,
  }));
}

/** Full detail for one user, for the admin editor: teams & roles, account metadata and the email. */
export async function getUserDetail(userId: string): Promise<UserDetailDTO> {
  await requireInstanceAdmin();
  const db = getDb();
  const urows = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      email: usersTable.email,
      avatarColor: usersTable.avatarColor,
      image: usersTable.image,
      isInstanceAdmin: usersTable.isInstanceAdmin,
      suspended: usersTable.suspended,
      canExposePorts: usersTable.canExposePorts,
      canMountHostVolumes: usersTable.canMountHostVolumes,
      twoFactorEnabled: usersTable.twoFactorEnabled,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const u = urows[0];
  if (!u) throw new Error("User not found");
  // Count only, never the rows: an admin needs to know there is something to
  // clear, not what the credentials are.
  const passkeyRows = await db
    .select({ id: passkeyTable.id })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId));
  const teamRows = await db
    .select({
      teamId: membershipsTable.teamId,
      teamName: teamsTable.name,
      teamImage: teamsTable.image,
      role: membershipsTable.role,
    })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .where(eq(membershipsTable.userId, userId));
  return {
    userId: u.id,
    username: u.username,
    name: u.name,
    email: u.email,
    avatarColor: u.avatarColor,
    avatarUrl: await avatarUrlFor(u),
    isInstanceAdmin: u.isInstanceAdmin ?? false,
    isInstanceOwner: u.id === (await instanceOwnerUserId()),
    suspended: u.suspended ?? false,
    canExposePorts: u.canExposePorts ?? false,
    canMountHostVolumes: u.canMountHostVolumes ?? false,
    twoFactorEnabled: u.twoFactorEnabled ?? false,
    passkeyCount: passkeyRows.length,
    createdAt: u.createdAt,
    teams: teamRows.map((t) => ({
      teamId: t.teamId,
      teamName: t.teamName ?? "(unknown)",
      teamAvatarUrl: teamAvatarUrl(t.teamImage),
      role: t.role as Role,
    })),
  };
}

// NOBODY edits the instance owner's row but the owner.
async function assertOwnerRowEditable(
  userId: string,
  actingUserId: string,
): Promise<void> {
  const ownerUserId = await instanceOwnerUserId();
  if (
    ownerUserId !== null &&
    userId === ownerUserId &&
    actingUserId !== ownerUserId
  )
    throw new Error(
      "Only the instance owner can edit the instance owner's account",
    );
}

/** Edit a user's global attributes: instance-admin flag, suspension, and an optional password reset. */
export async function updateUserAdmin(input: {
  userId: string;
  isInstanceAdmin: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  newPassword?: string;
}): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  const newPassword = input.newPassword?.trim() ? input.newPassword : null;
  // One's own password is changed with the current one in hand (`changePassword`):
  // this door asks for nothing, so a stolen session must not reach it.
  if (newPassword && input.userId === actingUserId)
    throw new Error(
      "Change your own password from Settings → Security, where the current one is asked for.",
    );
  if (newPassword) {
    assertPasswordPolicy(newPassword);
    await assertPasswordNotPwned(newPassword);
  }

  await getDb().transaction(async (tx) => {
    const target = (
      await tx
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.id, input.userId))
        .for("update")
        .limit(1)
    )[0];
    if (!target) throw new Error("User not found");

    // The instance owner's crown, read under the same transaction as the write it
    // vetoes so a concurrent transferInstanceOwner can't slip between the two.
    const ownerUserId = await instanceOwnerUserId(tx);

    // NOBODY edits the owner's row but the owner.
    if (
      ownerUserId !== null &&
      input.userId === ownerUserId &&
      actingUserId !== ownerUserId
    )
      throw new Error(
        "Only the instance owner can edit the instance owner's account",
      );

    // The owner can't uncrown themselves by dropping their own admin flag - the same
    // rule the team founder has.
    if (input.userId === ownerUserId && !input.isInstanceAdmin)
      throw new Error(
        "The instance owner is always an instance admin. Transfer ownership first.",
      );

    // An admin can't suspend or demote themselves into a lockout corner.
    if (input.userId === actingUserId && input.suspended)
      throw new Error("You can't suspend your own account");

    // Lockout guard: the instance must always retain at least one ACTIVE
    // (non-suspended) instance admin.
    const candidates = await tx
      .select({
        id: usersTable.id,
        isInstanceAdmin: usersTable.isInstanceAdmin,
        suspended: usersTable.suspended,
      })
      .from(usersTable)
      .where(
        or(
          eq(usersTable.isInstanceAdmin, true),
          eq(usersTable.id, input.userId),
        ),
      )
      .for("update");
    const activeAdminsAfter = candidates.filter((x) => {
      const isAdmin =
        x.id === target.id
          ? input.isInstanceAdmin
          : (x.isInstanceAdmin ?? false);
      const isSuspended =
        x.id === target.id ? input.suspended : (x.suspended ?? false);
      return isAdmin && !isSuspended;
    });
    if (activeAdminsAfter.length === 0)
      throw new Error("The instance must keep at least one active admin");

    await tx
      .update(usersTable)
      .set({
        isInstanceAdmin: input.isInstanceAdmin,
        suspended: input.suspended,
        canExposePorts: input.canExposePorts,
        canMountHostVolumes: input.canMountHostVolumes,
      })
      .where(eq(usersTable.id, input.userId));
    // The credential lives on the Better Auth `account` row since 0055, so a
    // reset writes there - in the same transaction, so a failed lockout check
    // rolls the new password back with everything else.
    if (newPassword) await setUserPassword(input.userId, newPassword, tx);
  });

  // An admin password reset also revokes the target's outstanding sessions: they no
  // longer control the credential, so any live cookie of theirs must die.
  if (newPassword) await revokeAllSessions(input.userId);
  // A suspended account's live sessions would otherwise keep refreshing until
  // the day the suspension is lifted, and be live again that minute.
  if (input.suspended) await revokeAllSessions(input.userId);

  const target = (
    await getDb()
      .select({ username: usersTable.username })
      .from(usersTable)
      .where(eq(usersTable.id, input.userId))
      .limit(1)
  )[0]!;
  await recordForEveryTeamOf(
    "member",
    input.userId,
    `Updated user @${target.username}` +
      (newPassword ? " (password reset)" : ""),
  );
}

/** Clear a user's two-factor enrolment - the backstop for a lost phone. */
export async function resetUserTwoFactor(userId: string): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  // Never your own: this path asks for no code, so a self-reset would be the
  // password-only disable that lib/data/two-factor.ts exists to forbid.
  // ponytail: an instance whose ONLY admin loses both their phone and all ten
  // recovery codes has no way back short of the database. Recovery codes are
  // downloadable at enrolment, so a break-glass waits until someone gets stuck.
  if (userId === actingUserId)
    throw new Error(
      "You can't reset your own two-factor here. Turn it off from Settings → Security, which asks for a code.",
    );
  await assertOwnerRowEditable(userId, actingUserId);
  const target = (
    await getDb()
      .select({
        username: usersTable.username,
        enabled: usersTable.twoFactorEnabled,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)
  )[0];
  if (!target) throw new Error("User not found");
  if (!target.enabled)
    throw new Error("That account does not have two-factor authentication on");

  await getDb().transaction(async (tx) => {
    await tx
      .update(usersTable)
      .set({ twoFactorEnabled: false })
      .where(eq(usersTable.id, userId));
    await tx.delete(twoFactorTable).where(eq(twoFactorTable.userId, userId));
  });

  await recordForEveryTeamOf(
    "security",
    userId,
    `Reset two-factor authentication for @${target.username}`,
  );
}

/** Remove every passkey from a user's account. */
export async function resetUserPasskeys(userId: string): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  // Your own are removable from Settings → Security, which asks for the
  // password. Allowing it here would be that same removal with no password.
  if (userId === actingUserId)
    throw new Error(
      "You can't remove your own passkeys here. Do it from Settings → Security, which asks for your password.",
    );
  await assertOwnerRowEditable(userId, actingUserId);
  const target = (
    await getDb()
      .select({ username: usersTable.username })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)
  )[0];
  if (!target) throw new Error("User not found");

  const removed = await getDb()
    .delete(passkeyTable)
    .where(eq(passkeyTable.userId, userId))
    .returning({ id: passkeyTable.id });
  if (removed.length === 0) throw new Error("That account has no passkeys");

  await recordForEveryTeamOf(
    "security",
    userId,
    removed.length === 1
      ? `Removed @${target.username}'s passkey`
      : `Removed @${target.username}'s ${removed.length} passkeys`,
  );
}
