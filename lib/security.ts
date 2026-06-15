import "server-only";

/**
 * In-memory fixed-window rate limiter for sensitive server actions / routes
 * (login, signup, token creation). For multi-instance production deployments
 * swap the Map for Redis with the same interface.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number }
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, remaining: opts.limit - 1, retryAfterSec: 0 };
  }
  existing.count += 1;
  if (existing.count > opts.limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.ceil((existing.resetAt - now) / 1000),
    };
  }
  return {
    ok: true,
    remaining: opts.limit - existing.count,
    retryAfterSec: 0,
  };
}

/** Best-effort periodic cleanup to bound memory. */
function sweep() {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
}
// Avoid unhandled timer in edge; only schedule in Node runtime.
if (typeof setInterval === "function" && process.env.NEXT_RUNTIME !== "edge") {
  const t = setInterval(sweep, 60_000);
  // Do not keep the process alive solely for the sweeper.
  (t as unknown as { unref?: () => void }).unref?.();
}
