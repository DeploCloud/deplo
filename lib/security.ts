// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { sql } from "drizzle-orm";

import { getDb } from "./db/client";

/**
 * Fixed-window rate limiter for the sensitive paths: login, the two-factor
 * challenge, the register link, the notification test button. Postgres-backed, so
 * it survives a restart - and it FAILS OPEN when the database is unreachable.
 */

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

/**
 * Count one attempt against `key` and say whether it is allowed.
 * Increments-or-resets in a single UPSERT so two concurrent attempts can never
 * both read the same count and both write `count + 1`.
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

    // drizzle's `execute` returns the DRIVER's shape, and the two drivers this runs on
    // do not agree on it: node-postgres hands back `{ rows: [...] }`, pglite the array
    // itself.
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
