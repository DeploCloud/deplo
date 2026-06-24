import "server-only";

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { backups as backupsTable } from "../db/schema/control-plane";
import { assembleBackup } from "../data/backup-rows";
import { runScheduledBackup } from "../data/backups";
import { cronMatches } from "./cron";
import {
  acquireLease,
  releaseLease,
  BACKUP_SCHEDULER_LEASE,
} from "./lease";

/**
 * The backup scheduler (PLAN Step 6) — the thing that makes a stored cron
 * `schedule` actually fire. Started once per server boot from
 * `instrumentation.ts` (Node runtime only). Every minute it:
 *
 *  1. claims the cross-process {@link BACKUP_SCHEDULER_LEASE} (so at most one
 *     control-plane instance drives the schedule — a horizontally-scaled deploy
 *     doesn't dump every database N times); a tick that can't get the lease does
 *     nothing this minute,
 *  2. reads the enabled `backups`, evaluates each `schedule` against the current
 *     minute with the dependency-free {@link cronMatches}, and
 *  3. runs the due ones via {@link runScheduledBackup} (the session-free executor
 *     entry), which records the same `BackupRun` history + retention as a manual
 *     run.
 *
 * Concurrency / crash recovery is the lease's job: a held lease blocks a second
 * instance; a lease whose heartbeat is stale (crashed owner) is stealable, so a
 * dead run never blocks the schedule forever (see lib/backups/lease.ts). In dev
 * with no Postgres the lease degrades to an in-process lock — safe because
 * `next start`/`next dev` are single-process.
 *
 * Singleton on `globalThis` via `Symbol.for(...)` (the store's pattern): Next
 * compiles separate module graphs, and `register()` could import this through
 * more than one, so a module-level flag would start two intervals.
 */

const TICK_MS = 60_000;

/** A label identifying THIS process as the lease owner across restarts. */
function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface SchedulerState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  /** Guards against firing one schedule twice within the same wall-clock minute
   *  (overlapping ticks / drift): backupId → the minute key we last fired it for. */
  lastFired: Map<string, string>;
  /** True while a tick is in flight, so a slow tick never overlaps the next. */
  ticking: boolean;
}

const STATE_KEY = Symbol.for("deplo.backup.scheduler");
const g = globalThis as unknown as { [STATE_KEY]?: SchedulerState };
const state: SchedulerState = (g[STATE_KEY] ??= {
  started: false,
  timer: null,
  owner: makeOwner(),
  lastFired: new Map(),
  ticking: false,
});

/** Minute-precision key for the dedup guard, e.g. "2026-06-23T17:45". */
function minuteKey(at: Date): string {
  return at.toISOString().slice(0, 16);
}

/**
 * One scheduler tick: claim the lease, then run every enabled schedule due this
 * minute. Exported for tests + an immediate first run; safe to call directly.
 * Never throws — a single schedule's failure is contained so the rest still run.
 */
export async function runSchedulerTick(now: Date = new Date()): Promise<void> {
  if (state.ticking) return; // a previous tick is still draining; skip this one.
  state.ticking = true;
  try {
    // Lease first: no point reading/evaluating if another instance owns the tick.
    const held = await acquireLease(BACKUP_SCHEDULER_LEASE, state.owner, now);
    if (!held) return;

    const key = minuteKey(now);
    // Snapshot the enabled, well-formed schedules due this minute. The enabled
    // filter is pushed into SQL; `cronMatches` (and the per-minute dedup) stay in
    // memory. Capture the list up front, then await each run.
    const enabledRows = await getDb()
      .select()
      .from(backupsTable)
      .where(eq(backupsTable.enabled, true));
    const due = enabledRows
      .map(assembleBackup)
      .filter(
        (b) =>
          b.schedule &&
          cronMatches(b.schedule, now) &&
          state.lastFired.get(b.id) !== key,
      );

    for (const b of due) {
      // Stamp BEFORE awaiting so a re-entrant/overlapping tick in the same minute
      // can't double-fire this schedule even before the run resolves.
      state.lastFired.set(b.id, key);
      try {
        await runScheduledBackup(b);
      } catch (e) {
        // runScheduledBackup already swallows + records; this is belt-and-braces.
        console.warn(
          `[backups] scheduled backup ${b.id} errored: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Bound the dedup map: drop entries for minutes other than the current one
    // (a schedule fires at most once a minute, so older keys are dead weight).
    for (const [id, k] of state.lastFired) {
      if (k !== key) state.lastFired.delete(id);
    }
  } finally {
    state.ticking = false;
  }
}

/**
 * Start the once-a-minute scheduler loop. Idempotent — a second call is a no-op,
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
  await releaseLease(BACKUP_SCHEDULER_LEASE, state.owner);
}
