import "server-only";

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

import {
  acquireLease,
  releaseLease,
  SECURITY_UPDATES_LEASE,
} from "../backups/lease";
import { instanceFrozen } from "../data/deplo-move/freeze";
import { isTestEnv } from "../db/pg";
import { schedulesPaused } from "../data/deplo-move/schedules";
import { listAllServers } from "../data/servers/roster";
import { fetchKevCves } from "./kev";
import { matchWorkloads, storeKev } from "./match";
import { OsvUnavailableError } from "./osv";
import { securityState, stampSecurityState } from "./state";
import {
  dropUnusedInventories,
  refreshRegistryStates,
  refreshServer,
} from "./workloads";

const TICK_MS = 5 * 60_000;
// A deploy's containers settle first, then its image is read.
const SOON_MS = 20_000;
export const FULL_MATCH_EVERY_MS = 6 * 60 * 60_000;
const KEV_EVERY_MS = 24 * 60 * 60_000;

interface SchedulerState {
  started: boolean;
  owner: string;
  ticking: boolean;
  // A checkSoon asked for a tick; one that lands mid-tick runs again after it.
  wanted: boolean;
  soon: ReturnType<typeof setTimeout> | null;
}

const STATE_KEY = Symbol.for("deplo.security-updates.scheduler");
const g = globalThis as unknown as { [STATE_KEY]?: SchedulerState };
const state: SchedulerState = (g[STATE_KEY] ??= {
  started: false,
  owner: `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`,
  ticking: false,
  wanted: false,
  soon: null,
});

const olderThan = (at: string | null, ms: number, now: Date) =>
  !at || now.getTime() - new Date(at).getTime() >= ms;

// https://deplo.build/docs/guides/observability/security-updates
export async function runSecurityUpdatesTick(
  now: Date = new Date(),
): Promise<void> {
  if (await instanceFrozen()) return;
  if (await schedulesPaused()) return;
  if (state.ticking) return;
  state.ticking = true;
  state.wanted = false;
  try {
    if (!(await acquireLease(SECURITY_UPDATES_LEASE, state.owner, now))) return;
    const s = await securityState();
    if (!s.enabled) return;

    const servers = (await listAllServers()).filter((x) => !x.importOnly);
    const keepGoing = () => acquireLease(SECURITY_UPDATES_LEASE, state.owner);
    await Promise.allSettled(
      servers.map((x) => refreshServer(x.id, now, keepGoing)),
    );
    await refreshRegistryStates(now);

    const full = olderThan(s.checkedAt, FULL_MATCH_EVERY_MS, now);
    if (full && olderThan(s.kevFetchedAt, KEV_EVERY_MS, now)) {
      try {
        await storeKev(await fetchKevCves());
        await stampSecurityState({ kevFetchedAt: now.toISOString() });
      } catch (e) {
        console.warn(
          `[security-updates] known-exploited list: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    try {
      await matchWorkloads(full ? "full" : "light", now);
      await stampSecurityState({
        failingSince: null,
        ...(full ? { checkedAt: now.toISOString() } : {}),
      });
      if (full) await dropUnusedInventories(now);
    } catch (e) {
      if (!(e instanceof OsvUnavailableError)) throw e;
      console.warn(`[security-updates] ${e.message}`);
      await stampSecurityState({
        failingSince: s.failingSince ?? now.toISOString(),
      });
    }
  } catch (e) {
    console.error("[security-updates] tick failed:", e);
  } finally {
    state.ticking = false;
    if (state.wanted) checkSoon();
  }
}

// A deploy just went live: read its image now, not at the next tick.
export function checkSoon(): void {
  // Tests drive ticks themselves; a stray timer would land in the next file's database.
  if (isTestEnv()) return;
  state.wanted = true;
  if (state.soon) return;
  state.soon = setTimeout(() => {
    state.soon = null;
    void runSecurityUpdatesTick();
  }, SOON_MS);
  state.soon.unref?.();
}

export function startSecurityUpdatesScheduler(): void {
  if (state.started) return;
  state.started = true;
  const timer = setInterval(() => void runSecurityUpdatesTick(), TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  setTimeout(() => void runSecurityUpdatesTick(), 90_000).unref?.();
  console.log("[deplo] security updates scheduler started");
}

export async function releaseSecurityUpdatesLease(): Promise<void> {
  await releaseLease(SECURITY_UPDATES_LEASE, state.owner);
}
