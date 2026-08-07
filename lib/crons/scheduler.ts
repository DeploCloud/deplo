import "server-only";

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

import {
  acquireLease,
  releaseLease,
  CRON_SCHEDULER_LEASE,
  LEASE_STALE_MS,
} from "../backups/lease";
import { fireDueJobs, reapInFlightRuns } from "./runner";

/**
 * The cron scheduler — the fourth lease-based tick loop, alongside backups,
 * docker cleanup and the preview reaper. Started once per boot from
 * `instrumentation-node.ts`. Every minute it:
 *
 *  1. claims the cross-process {@link CRON_SCHEDULER_LEASE}, so a
 *     horizontally-scaled deploy runs each job once rather than N times,
 *  2. REAPS: polls every in-flight run and settles what ended,
 *  3. FIRES: starts every job this minute calls for.
 *
 * The order of 2 and 3 is load-bearing. The overlap rule reads the `running`
 * rows, so a fire phase that went first would treat a run the agent finished ten
 * seconds ago as still in flight and skip a legitimate execution — once a minute,
 * for every job whose runtime is close to its interval.
 *
 * Two things the backup scheduler needs and this one does not:
 *
 *  - **An in-RAM `lastFired` map.** `UNIQUE(cron_runs.job_id, dedupe_key)` does
 *    the same job in the database, which is strictly less code and also survives
 *    a restart, two instances racing on a stolen lease, and a backwards clock
 *    step.
 *  - **A boot reconcile.** `reconcileInFlightBackupRuns` exists because a backup
 *    dies with the control plane, so an orphaned `running` row can only be
 *    guessed at. A cron job runs inside the AGENT, so the reap phase can simply
 *    ASK — and the immediate first tick below reaps before it fires, which IS the
 *    reconcile.
 *
 * Singleton on `globalThis` via `Symbol.for(...)`: Next compiles separate module
 * graphs, so a module-level flag could start two intervals.
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
  /** True while a tick is in flight, so a slow tick never overlaps the next. */
  ticking: boolean;
  /** The `now` of the last tick that reached the lease check (held or not), so a
   *  tick after a long drain can replay the minutes the drain stepped over. */
  lastTickAt: Date | null;
}

const STATE_KEY = Symbol.for("deplo.cron.scheduler");
const g = globalThis as unknown as { [STATE_KEY]?: SchedulerState };
const state: SchedulerState = (g[STATE_KEY] ??= {
  started: false,
  timer: null,
  owner: makeOwner(),
  ticking: false,
  lastTickAt: null,
});

/**
 * The minutes this tick is answering for: its own, plus every whole minute since
 * the last tick that reached the lease check.
 *
 * Reaping a fleet can outrun 60 seconds, and `state.ticking` skips the interval
 * ticks underneath, which would step straight past a schedule whose exact minute
 * fell inside the drain. Bounded by the staleness window, past which another
 * instance may legitimately have been driving.
 */
function replayWindow(now: Date): Date[] {
  const minutes: Date[] = [];
  if (state.lastTickAt) {
    const floor = Math.max(
      state.lastTickAt.getTime() + TICK_MS,
      now.getTime() - LEASE_STALE_MS,
    );
    for (let t = floor; t < now.getTime(); t += TICK_MS) minutes.push(new Date(t));
  }
  minutes.push(now);
  return minutes;
}

/**
 * One tick. Exported for tests and for the immediate first run. Never throws —
 * both phases contain per-job and per-run failures so one bad row cannot stop the
 * instance's other jobs.
 */
export async function runCronSchedulerTick(now: Date = new Date()): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    if (!(await acquireLease(CRON_SCHEDULER_LEASE, state.owner, now))) return;
    // Renewing per server / per job is the heartbeat: a cron job can outlive
    // LEASE_STALE_MS, and a lease whose heartbeat only advanced at tick start
    // would go stale mid-drain and be stolen. A lost renewal means it WAS
    // stolen, so stop rather than race the new owner.
    const heartbeat = () => acquireLease(CRON_SCHEDULER_LEASE, state.owner);
    await reapInFlightRuns(now, heartbeat);
    await fireDueJobs(replayWindow(now), heartbeat);
  } catch (e) {
    console.error(
      `[crons] scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // Advance even when the lease was denied: those minutes were the OTHER
    // instance's to fire, so they must never enter OUR replay window.
    state.lastTickAt = now;
    state.ticking = false;
  }
}

/**
 * Release this process's hold on the lease, on SIGTERM/SIGINT, so a clean restart
 * hands the schedule over immediately instead of leaving it to age out over
 * LEASE_STALE_MS (two hours of nothing running).
 */
export async function releaseCronSchedulerLease(): Promise<void> {
  await releaseLease(CRON_SCHEDULER_LEASE, state.owner);
}

/** Start the once-a-minute loop. Idempotent. */
export function startCronScheduler(): void {
  if (state.started) return;
  state.started = true;
  const timer = setInterval(() => {
    void runCronSchedulerTick();
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
  // Immediate first tick: its REAP phase is what settles the runs that were in
  // flight when this process last stopped, and a job already due at boot should
  // not wait up to a full minute.
  void runCronSchedulerTick();
  console.log("[deplo] cron scheduler started");
}

/** Test-only: stop the loop, drop the lease, reset the per-process state. */
export async function __stopCronScheduler(): Promise<void> {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.ticking = false;
  state.lastTickAt = null;
  await releaseLease(CRON_SCHEDULER_LEASE, state.owner);
}
