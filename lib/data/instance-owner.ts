import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { getDb, type DbTx } from "../db/client";
import { users as usersTable } from "../db/schema/control-plane/identity";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { account as accountTable } from "../db/schema/auth";
import { nowIso } from "../ids";
import { assertUser, getCurrentUser } from "../auth/current-user";
import { verifyPassword } from "../crypto";
import { requireInstanceAdmin } from "../membership";
import { rateLimit } from "../security";
import { recordActivity } from "./activity";
import { stepUpCode } from "./two-factor";

const SETTINGS_ID = "default";

export async function instanceOwnerUserId(tx?: DbTx): Promise<string | null> {
  const db = tx ?? getDb();
  const rows = await db
    .select({ ownerUserId: instanceSettings.ownerUserId })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID))
    .limit(1);
  return rows[0]?.ownerUserId ?? null;
}

export async function isInstanceOwner(
  userId: string,
  tx?: DbTx,
): Promise<boolean> {
  const owner = await instanceOwnerUserId(tx);
  return owner !== null && owner === userId;
}

export async function viewerIsInstanceOwner(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  return isInstanceOwner(user.id);
}

export async function welcomePending(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const row = (
    await getDb()
      .select({
        ownerUserId: instanceSettings.ownerUserId,
        welcomeSeenAt: instanceSettings.welcomeSeenAt,
      })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, SETTINGS_ID))
      .limit(1)
  )[0];
  return row?.ownerUserId === user.id && !row.welcomeSeenAt;
}

export async function markWelcomeSeen(): Promise<boolean> {
  const user = await assertUser();
  const done = await getDb()
    .update(instanceSettings)
    .set({ welcomeSeenAt: nowIso(), updatedAt: nowIso() })
    .where(
      and(
        eq(instanceSettings.id, SETTINGS_ID),
        eq(instanceSettings.ownerUserId, user.id),
        isNull(instanceSettings.welcomeSeenAt),
      ),
    )
    .returning({ id: instanceSettings.id });
  return done.length > 0;
}

export async function transferInstanceOwner(input: {
  userId: string;
  password: string;
  code?: string;
}): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  const actor = await assertUser();
  if (actor.twoFactorEnabled) await stepUpCode(input.code ?? "");
  const limit = await rateLimit(`account-reauth:${actingUserId}`, {
    limit: 6,
    windowMs: 5 * 60_000,
  });
  if (!limit.ok)
    throw new Error(`Too many attempts. Try again in ${limit.retryAfterSec}s.`);

  const targetUsername = await getDb().transaction(async (tx) => {
    const settings = (
      await tx
        .select({ ownerUserId: instanceSettings.ownerUserId })
        .from(instanceSettings)
        .where(eq(instanceSettings.id, SETTINGS_ID))
        .for("update")
        .limit(1)
    )[0];
    const owner = settings?.ownerUserId ?? null;
    if (owner === null)
      throw new Error(
        "This instance has no owner to transfer. Recover ownership from the host with `deplo recover owner`.",
      );
    if (owner !== actingUserId)
      throw new Error("Only the instance owner can transfer ownership");
    if (input.userId === actingUserId)
      throw new Error("You already own this instance");

    const me = (
      await tx
        .select({ password: accountTable.password })
        .from(accountTable)
        .where(
          and(
            eq(accountTable.userId, actingUserId),
            eq(accountTable.providerId, "credential"),
          ),
        )
        .limit(1)
    )[0];
    if (!me?.password || !(await verifyPassword(input.password, me.password)))
      throw new Error("That password is not correct");

    const target = (
      await tx
        .select({
          id: usersTable.id,
          username: usersTable.username,
          isInstanceAdmin: usersTable.isInstanceAdmin,
          suspended: usersTable.suspended,
        })
        .from(usersTable)
        .where(eq(usersTable.id, input.userId))
        .for("update")
        .limit(1)
    )[0];
    if (!target) throw new Error("User not found");
    if (target.suspended)
      throw new Error("You can't transfer ownership to a suspended account");
    if (!target.isInstanceAdmin)
      throw new Error(
        "You can only transfer ownership to an instance admin. Make them an admin first.",
      );

    await tx
      .update(instanceSettings)
      .set({ ownerUserId: target.id, updatedAt: nowIso() })
      .where(eq(instanceSettings.id, SETTINGS_ID));
    return target.username;
  });

  await recordActivity(
    "member",
    `Transferred instance ownership to @${targetUsername}`,
    actor.username,
    null,
  );
}
