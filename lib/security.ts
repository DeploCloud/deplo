import "server-only";

import { sql } from "drizzle-orm";

import { getDb } from "./db/client";

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

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
    return { ok: true, remaining: opts.limit - 1, retryAfterSec: 0 };
  }
}

export async function sweepRateLimits(): Promise<void> {
  try {
    await getDb().execute(
      sql`delete from rate_limits where "reset_at" <= now()`,
    );
  } catch {}
}
