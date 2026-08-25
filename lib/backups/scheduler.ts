import "server-only";

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { backups as backupsTable } from "../db/schema/control-plane";
import { assembleBackup } from "../data/backup-rows";
import type { Backup } from "../types";
import {
  runScheduledBackup,
  sweepOrphanedBackupArtifacts,
} from "../data/backups";
import { cronMatchesInZone, dedupeKeyFor } from "../crons/cron-tz";
import {
  acquireLease,
  releaseLease,
  BACKUP_SCHEDULER_LEASE,
  LEASE_STALE_MS,
} from "./lease";

/**
 * The backup scheduler (PLAN Step 6) - the thing that makes a stored cron
 * `schedule` actually fire. In dev with no Postgres the lease degrades to an
 * in-process lock - safe because `next start`/`next dev` are single-process.
 */

const TICK_MS = 60_000;

/** How often the orphaned-artifact sweep runs. Daily: it scans every orphaned
 *  run on the instance, and a month-old file can wait an hour. */
const ORPHAN_SWEEP_EVERY_MS = 24 * 60 * 60_000;

/** A label identifying THIS process as the lease owner across restarts. */
function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface SchedulerState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  /**
   * Guards against firing one schedule twice for the same scheduled instant
   * (overlapping ticks / drift): backupId → the dedupe key we last fired it for,
   * plus WHEN we recorded it so the map can be bounded.
   */
  lastFired: Map<string, { key: string; at: number }>;
  /** True while a tick is in flight, so a slow tick never overlaps the next. */
  ticking: boolean;
  /** The `now` of the last tick that reached the lease check (held or not), so a
   *  tick after a long drain can replay the cron minutes the drain stepped over.
   *  Null on a fresh process - restarts never replay (no persisted last run). */
  lastTickAt: Date | null;
  /** When the orphan-artifact sweep last ran (epoch ms; 0 = never this process). */
  lastOrphanSweepAt: number;
}

const STATE_KEY = Symbol.for("deplo.backup.scheduler");
const g = globalThis as unknown as { [STATE_KEY]?: SchedulerState };
const state: SchedulerState = (g[STATE_KEY] ??= {
  started: false,
  timer: null,
  owner: makeOwner(),
  lastFired: new Map(),
  ticking: false,
  lastTickAt: null,
  lastOrphanSweepAt: 0,
});

/**
 * One scheduler tick: claim the lease, then run every enabled schedule due this
 * minute. Exported for tests + an immediate first run; safe to call directly.
 * Never throws - a single schedule's failure is contained so the rest still run.
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<void> {
  if (state.ticking) return; // a previous tick is still draining; skip this one.
  state.ticking = true;
  try {
    // Lease first: no point reading/evaluating if another instance owns the tick.
    const held = await acquireLease(BACKUP_SCHEDULER_LEASE, state.owner, now);
    if (!held) return;

    // CATCH-UP over an overrun drain: one slow dump holds `state.ticking`, so the
    // interval ticks under it are SKIPPED, which used to step straight past every
    // schedule whose exact cron minute fell inside the drain, silently losing that run
    const minutes: Date[] = [];
    if (state.lastTickAt) {
      const floor = Math.max(
        state.lastTickAt.getTime() + TICK_MS,
        now.getTime() - LEASE_STALE_MS,
      );
      for (let t = floor; t < now.getTime(); t += TICK_MS) {
        minutes.push(new Date(t));
      }
    }
    minutes.push(now);
    // Snapshot the enabled, well-formed schedules due this minute. The enabled
    // filter is pushed into SQL; `cronMatches` (and the per-minute dedup) stay in
    // memory. Capture the list up front, then await each run.
    const enabledRows = await getDb()
      .select()
      .from(backupsTable)
      .where(eq(backupsTable.enabled, true));
    // Each due schedule carries the exact minute it matched, so the dedupe key is
    // the SCHEDULED instant rather than the tick's own clock - the two differ by
    // the whole catch-up window after a slow drain.
    const due: { backup: Backup; firedFor: string }[] = [];
    for (const b of enabledRows.map(assembleBackup)) {
      if (!b.schedule) continue;
      // A schedule now names the zone it is read in. A bad one throws out of
      // `cronMatchesInZone`; contained per row, so one bad value cannot stop the
      // instance's other backups (same rule the cron runner follows).
      let fireAt: Date | undefined;
      try {
        fireAt = minutes
          .filter((m) => cronMatchesInZone(b.schedule, m, b.timezone || "UTC"))
          .pop();
      } catch (e) {
        console.warn(
          `[backups] schedule ${b.id} has an unusable timezone ${b.timezone}: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
        continue;
      }
      if (!fireAt) continue;
      const firedFor = dedupeKeyFor(b.schedule, fireAt, b.timezone || "UTC");
      if (state.lastFired.get(b.id)?.key === firedFor) continue;
      due.push({ backup: b, firedFor });
    }

    for (const { backup: b, firedFor } of due) {
      // Heartbeat mid-drain: one slow dump can outlast LEASE_STALE_MS, and a lease whose
      // heartbeat only advances at tick start would go stale - free for another instance
      // to steal and double-fire.
      if (!(await acquireLease(BACKUP_SCHEDULER_LEASE, state.owner))) break;
      // Stamp BEFORE awaiting so a re-entrant/overlapping tick in the same minute
      // can't double-fire this schedule even before the run resolves.
      state.lastFired.set(b.id, { key: firedFor, at: now.getTime() });
      try {
        await runScheduledBackup(b);
      } catch (e) {
        // runScheduledBackup already swallows + records; this is belt-and-braces.
        console.warn(
          `[backups] scheduled backup ${b.id} errored: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Bound the dedup map by AGE, not by "is this the current minute": an entry stays
    // useful for as long as its scheduled instant can still be replayed, and the replay
    // window is the lease's staleness bound.
    for (const [id, seen] of state.lastFired) {
      if (now.getTime() - seen.at > LEASE_STALE_MS) state.lastFired.delete(id);
    }

    // Reclaim the artifacts of apps and databases that no longer exist.
    if (now.getTime() - state.lastOrphanSweepAt > ORPHAN_SWEEP_EVERY_MS) {
      state.lastOrphanSweepAt = now.getTime();
      try {
        await sweepOrphanedBackupArtifacts();
      } catch (e) {
        console.warn(
          `[backups] orphan sweep failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } finally {
    // Advance even when the lease was denied: those minutes were the OTHER
    // instance's to fire, so they must never enter OUR replay window.
    state.lastTickAt = now;
    state.ticking = false;
  }
}

/**
 * Release this process's hold on the scheduler lease. Best-effort and safe when we
 * never held it - the lease layer ignores a release by a non-holder.
 */
export async function releaseBackupSchedulerLease(): Promise<void> {
  await releaseLease(BACKUP_SCHEDULER_LEASE, state.owner);
}

/**
 * Start the once-a-minute scheduler loop. Idempotent - a second call is a no-op,
 * so importing this through more than one Next module graph can't start two
 * loops. Called from `instrumentation.ts` at boot (Node runtime only).
 */
export function startBackupScheduler(): void {
  if (state.started) return;
  state.started = true;
  // `unref()` so the interval never keeps the process alive on its own (it rides
  // the server's lifetime; an idle CLI/script wouldn't be pinned open by it).
  const timer = setInterval(() => {
    void runSchedulerTick();
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
  // Kick an immediate tick so a schedule that's already due at boot doesn't wait
  // up to a full minute. Floated; its own try/finally contains any failure.
  void runSchedulerTick();
  console.log("[deplo] backup scheduler started");
}

/** Test-only: stop the loop, drop the lease, and reset the per-process state. */
export async function __stopBackupScheduler(): Promise<void> {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.ticking = false;
  state.lastFired.clear();
  state.lastTickAt = null;
  await releaseLease(BACKUP_SCHEDULER_LEASE, state.owner);
}
