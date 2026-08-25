import type { AlertKey } from "../types";

/**
 * One state machine for every repeated condition.
 *
 * Emitters call this UNCONDITIONALLY — they report what they observed, good or
 * bad, and this decides whether it is worth telling anybody. That is what makes
 * the recovery alert free: "server back online" is just a state change away from
 * "server offline", with no separate bookkeeping at the call site.
 *
 *   no entry            -> fire   (first observation)
 *   state changed       -> fire   (the recovery edge, and every other edge)
 *   same state, cooled  -> fire   (the re-nag)
 *   otherwise           -> stay quiet
 *
 * Fired first in the dispatcher, before any query: the hot emitters run twelve
 * times a minute per host, and a suppressed alert has to cost a `Map.get`.
 *
 * ponytail: per-process RAM. N control-plane instances = N copies of a repeated
 * alert, and a restart re-announces an ongoing outage once. Move the map into a
 * `notification_state` table if deplo is ever run horizontally scaled; a single
 * instance is the shipped topology.
 */

interface Seen {
  state: string;
  at: number;
}

const KEY = Symbol.for("deplo.notify.cooldown");
const store = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<
  string,
  Seen
>()) as Map<string, Seen>;

/**
 * How long the SAME state stays quiet before it is worth repeating. One-shot
 * events (a deploy, a backup run) pass no dedupe at all and never reach here.
 */
const COOLDOWN_MS: Partial<Record<AlertKey, number>> = {
  server_offline: 30 * 60_000,
  server_online: 30 * 60_000,
  server_unmanageable: 30 * 60_000,
  server_trust_changed: 30 * 60_000,
  app_crash_loop: 30 * 60_000,
  server_resources_high: 60 * 60_000,
  server_disk_low: 60 * 60_000,
  cleanup_failed: 6 * 60 * 60_000,
  agent_certificate_failed: 6 * 60 * 60_000,
  // A weekly nag, not a daily one. The dedupe state is the VERSION, so a new
  // release re-fires immediately instead of waiting out the week.
  deplo_update_available: 7 * 24 * 60 * 60_000,
  certificate_expiring: 24 * 60 * 60_000,
  domain_dns_drift: 24 * 60 * 60_000,
  failed_logins: 15 * 60_000,
};

const DEFAULT_COOLDOWN_MS = 30 * 60_000;

export function shouldFire(
  key: AlertKey,
  id: string,
  state: string,
  now: number = Date.now(),
): boolean {
  const slot = `${key}:${id}`;
  const seen = store.get(slot);
  if (seen && seen.state === state) {
    if (now - seen.at < (COOLDOWN_MS[key] ?? DEFAULT_COOLDOWN_MS)) return false;
  }
  store.set(slot, { state, at: now });
  return true;
}

/**
 * Drop entries nothing can still be suppressing. Same shape as `lib/security.ts`'s
 * own sweeper, unref'd for the same reason: it must never be what keeps the
 * process alive.
 */
const MAX_COOLDOWN_MS = Math.max(
  DEFAULT_COOLDOWN_MS,
  ...Object.values(COOLDOWN_MS).filter((v): v is number => v !== undefined),
);

if (typeof setInterval === "function" && process.env.NEXT_RUNTIME !== "edge") {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [slot, seen] of store)
      if (now - seen.at > MAX_COOLDOWN_MS) store.delete(slot);
  }, 60 * 60_000);
  (t as unknown as { unref?: () => void }).unref?.();
}

/** Test hook — the map outlives a single test file otherwise. */
export function __resetCooldowns(): void {
  store.clear();
}
