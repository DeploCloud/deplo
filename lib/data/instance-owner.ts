import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { getDb, type DbTx } from "../db/client";
import {
  instanceSettings,
  users as usersTable,
} from "../db/schema/control-plane";
import { account as accountTable } from "../db/schema/auth";
import { nowIso } from "../ids";
import { assertUser, getCurrentUser } from "../auth";
import { verifyPassword } from "../crypto";
import { requireInstanceAdmin } from "../membership";
import { rateLimit } from "../security";
import { recordActivity } from "./activity";

/**
 * The instance owner - the instance-level twin of a team's founder "crown"
 * (`teams.founder_user_id`), stored on the `instance_settings` singleton.
 */

/** The singleton row's fixed PK, like `monitoring_settings` / the cleanup policy. */
const SETTINGS_ID = "default";

/**
 * The owning user's id, or null when the instance is unowned (no row yet - a
 * pre-0038 instance that never replayed the backfill, or one with no admin to
 * backfill from).
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
 * transaction, so an instance is never briefly unowned.
 */
export async function claimInstanceOwner(
  tx: DbTx,
  userId: string,
): Promise<void> {
  await tx
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, ownerUserId: userId, updatedAt: nowIso() })
    // An UPDATE guarded on `owner_user_id IS NULL`, not DO NOTHING: the row can already
    // exist for a reason that has nothing to do with ownership (the panel address, the
    // VAPID keypair), and "do nothing" would then leave the instance permanently
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { ownerUserId: userId, updatedAt: nowIso() },
      setWhere: isNull(instanceSettings.ownerUserId),
    });
}

/**
 * Hand the crown to another user. The ONLY way `owner_user_id` ever changes after
 * setup, and the one thing here the owner alone may do - an instance admin calling
 * this is rejected even though they pass {@link requireInstanceAdmin}.
 */
export async function transferInstanceOwner(input: {
  userId: string;
  password: string;
}): Promise<void> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  const actor = await assertUser();
  // The password check below is a re-auth, and this is the highest-value one in the
  // product: on success the instance changes hands.
  const limit = await rateLimit(`account-reauth:${actingUserId}`, {
    limit: 6,
    windowMs: 5 * 60_000,
  });
  if (!limit.ok)
    throw new Error(`Too many attempts. Try again in ${limit.retryAfterSec}s.`);

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

    // The password check reads the actor's CURRENT hash inside the transaction -
    // a hash rotated between the session being issued and this call must win.
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

  // Outside the transaction, per the recordActivity rule (own connection).
  await recordActivity(
    "member",
    `Transferred instance ownership to @${targetUsername}`,
    actor.username,
    null,
  );
}
