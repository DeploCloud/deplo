import "server-only";

import { sql } from "drizzle-orm";

import { getDb } from "./db/client";

/**
 * Fixed-window rate limiter for the sensitive paths: login, the two-factor
 * challenge, the register link, the notification test button.
 *
 * Backed by Postgres, not by process memory. The Map this replaced failed in
 * two ways that mattered for the thing it protects:
 *
 *  - **A restart emptied it.** Whoever could make the control plane restart
 *    could also reset the login-attempt counter for every account at once -
 *    which turns "8 attempts per address per minute" into "8 per restart".
 *  - **It was per-process.** The moment two instances serve one database, each
 *    keeps its own buckets and every limit is silently multiplied by the
 *    instance count. For a hosted deplo that is not a degradation, it is the
 *    limiter not being there.
 *
 * Postgres is already the only control-plane store, so this costs no new moving
 * part - no Redis to stand up, which is also the answer the mission asks for
 * (use the infrastructure the operator already has). The whole limiter is ONE
 * statement, which additionally makes it atomic: the old read-modify-write on
 * the Map could not have been correct under real concurrency, it was only ever
 * saved by the single-threaded event loop.
 */

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Count one attempt against `key` and say whether it is allowed.
 *
 * Increments-or-resets in a single UPSERT so two concurrent attempts can never
 * both read the same count and both write `count + 1`. `reset_at` in the past
 * means the window is over: the row is reused rather than deleted, because a
 * DELETE + INSERT race is exactly the gap an attacker would want.
 *
 * FAILS OPEN, deliberately, and it is the one judgement call here. If the
 * database is unreachable the control plane cannot authenticate anyone anyway -
 * the login it guards is about to fail on its own - so refusing every request
 * would turn a database blip into a total lockout with no way back in. The
 * limiter is a brake on guessing, not an authorization decision, and the
 * authorization decisions all sit behind their own gates.
 */
export async function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): Promise<RateLimitResult> {
  const windowSec = Math.max(1, Math.ceil(opts.windowMs / 1000));
  try {
    const result: unknown = await getDb().execute(sql`
      insert into rate_limits ("key", "count", "reset_at")
      values (${key}, 1, now() + make_interval(secs => ${windowSec}))
      on conflict ("key") do update set
        "count" = case
          when rate_limits."reset_at" <= now() then 1
          else rate_limits."count" + 1
        end,
        "reset_at" = case
          when rate_limits."reset_at" <= now()
            then now() + make_interval(secs => ${windowSec})
          else rate_limits."reset_at"
        end
      returning
        "count",
        greatest(0, ceil(extract(epoch from ("reset_at" - now()))))::int as retry_after
    `);

    // drizzle's `execute` returns the DRIVER's shape, and the two drivers this
    // runs on do not agree on it: node-postgres hands back `{ rows: [...] }`,
    // pglite the array itself. Both are handled rather than picked, because the
    // suite runs on one and production on the other - a limiter that silently
    // returned "allowed" under pglite would test as working and not be.
    const rows = (
      Array.isArray(result)
        ? result
        : ((result as { rows?: unknown[] })?.rows ?? [])
    ) as {
      count: number | string;
      retry_after: number | string;
    }[];
    const row = rows[0];
    if (!row) return { ok: true, remaining: opts.limit - 1, retryAfterSec: 0 };

    const count = Number(row.count);
    const retryAfterSec = Number(row.retry_after);
    if (count > opts.limit) return { ok: false, remaining: 0, retryAfterSec };
    return { ok: true, remaining: opts.limit - count, retryAfterSec: 0 };
  } catch {
    // See the docblock: a limiter that locks everyone out when the database
    // hiccups is worse than one that briefly stops counting.
    return { ok: true, remaining: opts.limit - 1, retryAfterSec: 0 };
  }
}

/**
 * Drop windows that have already closed.
 *
 * Not correctness - a closed window is treated as absent by the UPSERT above
 * whether or not its row is still there - just housekeeping, so a year of
 * guessed addresses does not accumulate as dead rows. Called by the maintenance
 * sweep; safe to call at any time, from any instance.
 */
export async function sweepRateLimits(): Promise<void> {
  try {
    await getDb().execute(
      sql`delete from rate_limits where "reset_at" <= now()`,
    );
  } catch {
    // Housekeeping. A failure here costs disk, never correctness.
  }
}
