import type { AlertKey } from "../types/notification";

/**
 * ponytail: per-process RAM, so N instances mean N copies of a repeated alert and
 * a restart re-announces an ongoing outage once. A `notification_state` table if
 * Deplo is ever run horizontally scaled; a single instance is the shipped shape.
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

// How long the SAME state stays quiet; one-shot events pass no dedupe and never reach here.
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
  // The dedupe state is the VERSION, so a new release re-fires instead of waiting out the week.
  deplo_update_available: 7 * 24 * 60 * 60_000,
  certificate_expiring: 24 * 60 * 60_000,
  // Only fixable on the provider's own settings page, so a half-hourly nag just gets muted.
  git_access_missing: 24 * 60 * 60_000,
  domain_dns_drift: 24 * 60 * 60_000,
  failed_logins: 15 * 60_000,
};

const DEFAULT_COOLDOWN_MS = 30 * 60_000;

// Emitters report every observation, good or bad, unconditionally; this decides who is told.
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

// Unref'd like `lib/security.ts`'s own sweeper: it must never be what keeps the process alive.
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

// Test hook - the map outlives a single test file otherwise.
export function __resetCooldowns(): void {
  store.clear();
}
