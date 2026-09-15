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

export interface GlobalUserDTO {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  avatarUrl: string | null;
  teamCount: number;
  isInstanceAdmin: boolean;
  isInstanceOwner: boolean;
  suspended: boolean;
  canExposePorts: boolean;
  canMountHostVolumes: boolean;
  createdAt: string;
}

export interface UserDetailDTO {
  userId: string;
  username: string;
  name: string;
  email: string;
  avatarColor: string;
  avatarUrl: string | null;
  isInstanceAdmin: boolean;
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

export async function listAllUsers(): Promise<GlobalUserDTO[]> {
  await requireInstanceAdmin();
  const db = getDb();
  const users = await db
    .select({
      id: usersTable.id,
      username: usersTable.username,
      name: usersTable.name,
      avatarColor: usersTable.avatarColor,
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

    const ownerUserId = await instanceOwnerUserId(tx);

    if (
      ownerUserId !== null &&
      input.userId === ownerUserId &&
      actingUserId !== ownerUserId
    )
      throw new Error(
        "Only the instance owner can edit the instance owner's account",
      );

    if (input.userId === ownerUserId && !input.isInstanceAdmin)
      throw new Error(
        "The instance owner is always an instance admin. Transfer ownership first.",
      );

    if (input.userId === actingUserId && input.suspended)
      throw new Error("You can't suspend your own account");

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
    if (newPassword) await setUserPassword(input.userId, newPassword, tx);
  });

  if (newPassword) await revokeAllSessions(input.userId);
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

export async function resetUserTwoFactor(userId: string): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  // ponytail: an instance whose ONLY admin loses both their phone and all ten
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

export async function resetUserPasskeys(userId: string): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
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
