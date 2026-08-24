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
 * The cron scheduler - the fourth lease-based tick loop, alongside backups,
 * docker cleanup and the preview reaper. Started once per boot from
 * `instrumentation-node.ts`. Every tick it:
 *
 *  1. claims the cross-process {@link CRON_SCHEDULER_LEASE}, so a
 *     horizontally-scaled deploy runs each job once rather than N times,
 *  2. REAPS: polls every in-flight run and settles what ended,
 *  3. FIRES: starts every job this minute calls for - at most once per minute,
 *     whichever tick lands in it first.
 *
 * The order of 2 and 3 is load-bearing. The overlap rule reads the `running`
 * rows, so a fire phase that went first would treat a run the agent finished ten
 * seconds ago as still in flight and skip a legitimate execution - once a minute,
 * for every job whose runtime is close to its interval.
 *
 * The two phases run at DIFFERENT cadences, and that is the whole point of
 * {@link TICK_MS}. Firing is minute-grained because a cron expression has no
 * finer resolution. Reaping is not: a run stays `running` in the store until
 * somebody polls the agent, so a command that ended in 200ms read as "Running"
 * for up to a minute - long enough for the next fire to skip under overlap=skip,
 * for a hand-started run to look queued behind it, and for a page showing it to
 * look frozen.
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
 *    ASK - and the immediate first tick below reaps before it fires, which IS the
 *    reconcile.
 *
 * Singleton on `globalThis` via `Symbol.for(...)`: Next compiles separate module
 * graphs, so a module-level flag could start two intervals.
 */

/** How often the reaper asks the agents what has ended. One agent connection
 *  per server per tick WHILE something is in flight, and none at all otherwise -
 *  an idle instance still costs one `cron_runs` query every five seconds. */
const TICK_MS = 5_000;

/** How often the fire phase runs, and the resolution a cron expression has. */
const FIRE_EVERY_MS = 60_000;

/** The wall-clock minute an instant falls in. */
const minuteOf = (d: Date): number => Math.floor(d.getTime() / FIRE_EVERY_MS);

/**
 * Does this tick own its minute's fire? Pure, and exported for the test that
 * pins the cadence: everything else here needs a lease and an agent.
 *
 * At most one fire per wall-clock minute, on whichever tick lands in it first.
 * The unique index would make an extra fire harmless anyway - this keeps the
 * other 11 ticks from asking the question at all.
 */
export function shouldFire(now: Date, lastFireAt: Date | null): boolean {
  return lastFireAt === null || minuteOf(now) !== minuteOf(lastFireAt);
}

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
  /** The `now` of the last tick that owned a minute's fire (lease held or not),
   *  so a tick after a long drain can replay the minutes it stepped over. */
  lastFireAt: Date | null;
}

const STATE_KEY = Symbol.for("deplo.cron.scheduler");
const g = globalThis as unknown as { [STATE_KEY]?: SchedulerState };
const state: SchedulerState = (g[STATE_KEY] ??= {
  started: false,
  timer: null,
  owner: makeOwner(),
  ticking: false,
  lastFireAt: null,
});

/**
 * The minutes this tick is answering for: its own, plus every whole minute since
 * the last tick that fired.
 *
 * Reaping a fleet can outrun a minute, and `state.ticking` skips the interval
 * ticks underneath, which would step straight past a schedule whose exact minute
 * fell inside the drain. Bounded by the staleness window, past which another
 * instance may legitimately have been driving.
 */
function replayWindow(now: Date): Date[] {
  const minutes: Date[] = [];
  if (state.lastFireAt) {
    const floor = Math.max(
      state.lastFireAt.getTime() + FIRE_EVERY_MS,
      now.getTime() - LEASE_STALE_MS,
    );
    for (let t = floor; t < now.getTime(); t += FIRE_EVERY_MS)
      minutes.push(new Date(t));
  }
  minutes.push(now);
  return minutes;
}

/**
 * One tick. Exported for tests and for the immediate first run. Never throws -
 * both phases contain per-job and per-run failures so one bad row cannot stop the
 * instance's other jobs.
 */
export async function runCronSchedulerTick(
  now: Date = new Date(),
): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  const fire = shouldFire(now, state.lastFireAt);
  try {
    if (!(await acquireLease(CRON_SCHEDULER_LEASE, state.owner, now))) return;
    // Renewing per server / per job is the heartbeat: a cron job can outlive
    // LEASE_STALE_MS, and a lease whose heartbeat only advanced at tick start
    // would go stale mid-drain and be stolen. A lost renewal means it WAS
    // stolen, so stop rather than race the new owner.
    const heartbeat = () => acquireLease(CRON_SCHEDULER_LEASE, state.owner);
    await reapInFlightRuns(now, heartbeat);
    if (fire) await fireDueJobs(replayWindow(now), heartbeat);
  } catch (e) {
    console.error(
      `[crons] scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // Advance even when the lease was denied: those minutes were the OTHER
    // instance's to fire, so they must never enter OUR replay window.
    if (fire) state.lastFireAt = now;
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
  state.lastFireAt = null;
  await releaseLease(CRON_SCHEDULER_LEASE, state.owner);
}
