import "server-only";

import { eq } from "drizzle-orm";
import { getDb, type DbTx } from "../db/client";
import {
  instanceSettings,
  users as usersTable,
} from "../db/schema/control-plane";
import { nowIso } from "../ids";
import { assertUser, getCurrentUser } from "../auth";
import { verifyPassword } from "../crypto";
import { requireInstanceAdmin } from "../membership";
import { recordActivity } from "./activity";

/**
 * The instance owner — the instance-level twin of a team's founder "crown"
 * (`teams.founder_user_id`), stored on the `instance_settings` singleton.
 *
 * WHY THIS EXISTS. `is_instance_admin` is a flat boolean and `updateUserAdmin`
 * lets any admin write it on any OTHER admin; the only guard is "at least one
 * ACTIVE admin must remain", which the actor satisfies by being that admin. So
 * one admin you promoted could demote every peer, suspend them out of login and
 * reset their password hash — the first account included, which had no special
 * protection at all. With no user-deletion path and no self-service password
 * reset anywhere in the product, the victim's only way back was hand-written SQL.
 *
 * The rule, matching the team founder exactly: the owner is immutable to every
 * hand but their own. No other admin may demote, suspend or password-reset them,
 * and they cannot clear their own admin flag either. Not a dead end — the crown
 * TRANSFERS, but only by the person wearing it ({@link transferInstanceOwner}).
 *
 * The guards themselves live in `members.ts` next to the writes they constrain;
 * this module owns the row, the reads, and the transfer.
 */

/** The singleton row's fixed PK, like `monitoring_settings` / the cleanup policy. */
const SETTINGS_ID = "default";

/**
 * The owning user's id, or null when the instance is unowned (no row yet — a
 * pre-0038 instance that never replayed the backfill, or one with no admin to
 * backfill from). Internal: NO auth gate, because every guard that consumes it
 * runs before the caller's own gate has decided anything.
 *
 * Takes an optional `tx` so the guards in `updateUserAdmin` can read the owner
 * inside the same transaction (and under the same row locks) as the write they
 * are vetting, rather than racing a concurrent transfer.
 */
export async function instanceOwnerUserId(tx?: DbTx): Promise<string | null> {
  const db = tx ?? getDb();
  const rows = await db
    .select({ ownerUserId: instanceSettings.ownerUserId })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID))
    .limit(1);
  return rows[0]?.ownerUserId ?? null;
}

/** True if `userId` owns this instance. Internal; no auth gate (see above). */
export async function isInstanceOwner(
  userId: string,
  tx?: DbTx,
): Promise<boolean> {
  const owner = await instanceOwnerUserId(tx);
  return owner !== null && owner === userId;
}

/** True if the CURRENT viewer owns this instance. Safe for UI/GraphQL reads. */
export async function viewerIsInstanceOwner(): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  return isInstanceOwner(user.id);
}

/**
 * Claim the instance for `userId` at first-run setup. Called INSIDE the setup
 * transaction, so an instance is never briefly unowned. Idempotent by PK: if a
 * row somehow exists, setup is not the thing allowed to overwrite it —
 * {@link transferInstanceOwner} is.
 */
export async function claimInstanceOwner(
  tx: DbTx,
  userId: string,
): Promise<void> {
  await tx
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, ownerUserId: userId, updatedAt: nowIso() })
    .onConflictDoNothing({ target: instanceSettings.id });
}

/**
 * Hand the crown to another user. The ONLY way `owner_user_id` ever changes
 * after setup, and the one thing here the owner alone may do — an instance admin
 * calling this is rejected even though they pass {@link requireInstanceAdmin}.
 *
 * Requires the caller's own password. This is the single most destructive action
 * in the product (it is irreversible from the loser's side: the new owner may
 * immediately demote the old one), and the session cookie alone is a weaker
 * assertion than we want standing behind it — a borrowed laptop should not be
 * able to give the instance away.
 *
 * The target must be an ACTIVE instance admin: handing the crown to a suspended
 * account, or to a non-admin who would then lack the flag the owner is defined to
 * imply, both land the instance somewhere the invariants don't describe.
 */
export async function transferInstanceOwner(input: {
  userId: string;
  password: string;
}): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  const actor = await assertUser();

  const targetUsername = await getDb().transaction(async (tx) => {
    // Lock the singleton first: two concurrent transfers must serialize, or both
    // could read "I am the owner" and the second would overwrite the first.
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
        "This instance has no owner to transfer. Recover ownership from the host with `bun run recover`.",
      );
    if (owner !== actingUserId)
      throw new Error("Only the instance owner can transfer ownership");
    if (input.userId === actingUserId)
      throw new Error("You already own this instance");

    // The password check reads the actor's CURRENT hash inside the transaction —
    // a hash rotated between the session being issued and this call must win.
    const me = (
      await tx
        .select({ passwordHash: usersTable.passwordHash })
        .from(usersTable)
        .where(eq(usersTable.id, actingUserId))
        .limit(1)
    )[0];
    if (!me || !verifyPassword(input.password, me.passwordHash))
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

  // Outside the transaction, per the recordActivity rule (own connection).
  await recordActivity(
    "member",
    `Transferred instance ownership to @${targetUsername}`,
    actor.username,
    null,
  );
}
