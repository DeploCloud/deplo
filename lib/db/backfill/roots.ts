import type { DeploData } from "../../types";
import { teams, users } from "../schema/control-plane";
import type { BackfillTx } from "./types";

/**
 * FK-root prerequisites (relational-store PLAN §2 "FK ordering for
 * creation/backfill (roots first): users, teams, …").
 *
 * Every relational table outside the identity aggregate carries a NOT-NULL
 * `team_id` FK (and `api_tokens` a `user_id` FK) to `teams`/`users`. But those
 * root tables are only the AUTHORITATIVE responsibility of cut-set (b)
 * (identity), which is ordered AFTER the leaf cut-set (a). So a cut-set that runs
 * before (b) — the leaf cut-set, run first to prove the engine — must still see
 * its FK roots present, or its NOT-NULL FK inserts fail.
 *
 * Resolution: a cut-set seeds the root rows it references, idempotently. The keys
 * (`id`/`email`/`slug`/…) are stable, so `ON CONFLICT DO NOTHING` makes this safe
 * to overlap with cut-set (b)'s later authoritative copy — whichever runs first
 * inserts; the other no-ops. Each cut-set's marker still guards its own copy, so
 * the seed never runs twice for the same cut-set. The values come straight from
 * the JSONB document (the single source of truth at switch time); they are NOT
 * re-normalized here — cut-set (b) owns identity normalization.
 */

/** Idempotently insert the teams + users a non-identity cut-set's FKs reference. */
export async function seedIdentityRoots(
  tx: BackfillTx,
  data: DeploData,
): Promise<void> {
  if (data.teams.length > 0) {
    await tx
      .insert(teams)
      .values(
        data.teams.map((t) => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          plan: t.plan,
          createdAt: t.createdAt,
        })),
      )
      .onConflictDoNothing();
  }
  if (data.users.length > 0) {
    await tx
      .insert(users)
      .values(
        data.users.map((u) => ({
          id: u.id,
          email: u.email,
          username: u.username,
          name: u.name,
          passwordHash: u.passwordHash,
          role: u.role,
          isInstanceAdmin: Boolean(u.isInstanceAdmin),
          suspended: Boolean(u.suspended),
          canExposePorts: Boolean(u.canExposePorts),
          canMountHostVolumes: Boolean(u.canMountHostVolumes),
          avatarColor: u.avatarColor,
          createdAt: u.createdAt,
        })),
      )
      .onConflictDoNothing();
  }
}
