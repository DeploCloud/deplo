import "server-only";

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

import {
  acquireLease,
  releaseLease,
  CRON_SCHEDULER_LEASE,
  LEASE_STALE_MS,
} from "../backups/lease";
import { reapInFlightRuns } from "./runner/attempt";
import { fireDueJobs } from "./runner/fire";

// How often the reaper asks the agents what has ended: one agent connection per server per tick WHILE something is in flight, none otherwise.
const TICK_MS = 5_000;

// How often the fire phase runs, and the resolution a cron expression has.
const FIRE_EVERY_MS = 60_000;

const minuteOf = (d: Date): number => Math.floor(d.getTime() / FIRE_EVERY_MS);

// shouldFire: at most one fire per wall-clock minute, on whichever tick lands in it first. The unique index makes an extra fire harmless anyway.
export function shouldFire(now: Date, lastFireAt: Date | null): boolean {
  return lastFireAt === null || minuteOf(now) !== minuteOf(lastFireAt);
}

// A label identifying THIS process as the lease owner across restarts.
function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface SchedulerState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  // True while a tick is in flight, so a slow tick never overlaps the next.
  ticking: boolean;
  // The `now` of the last tick that owned a minute's fire (lease held or not), so a long drain can replay the minutes it stepped over.
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

// runCronSchedulerTick never throws: both phases contain per-job failures so one bad row cannot stop the instance's other jobs.
export async function runCronSchedulerTick(
  now: Date = new Date(),
): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  const fire = shouldFire(now, state.lastFireAt);
  try {
    if (!(await acquireLease(CRON_SCHEDULER_LEASE, state.owner, now))) return;
    // A cron job can outlive LEASE_STALE_MS, and a lease renewed only at tick start would go stale mid-drain and be stolen.
    const heartbeat = () => acquireLease(CRON_SCHEDULER_LEASE, state.owner);
    await reapInFlightRuns(now, heartbeat);
    if (fire) await fireDueJobs(replayWindow(now), heartbeat);
  } catch (e) {
    console.error(
      `[crons] scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    // Advance even when the lease was denied: those minutes were the OTHER instance's to fire, so they must never enter OUR replay window.
    if (fire) state.lastFireAt = now;
    state.ticking = false;
  }
}

// releaseCronSchedulerLease runs on SIGTERM/SIGINT: without it a restart leaves the schedule to age out over LEASE_STALE_MS (two hours of nothing running).
export async function releaseCronSchedulerLease(): Promise<void> {
  await releaseLease(CRON_SCHEDULER_LEASE, state.owner);
}

// startCronScheduler starts the once-a-minute loop. Idempotent.
export function startCronScheduler(): void {
  if (state.started) return;
  state.started = true;
  const timer = setInterval(() => {
    void runCronSchedulerTick();
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
  // The immediate first tick's REAP phase settles the runs that were in flight when this process last stopped.
  void runCronSchedulerTick();
  console.log("[deplo] cron scheduler started");
}

// Test-only: stop the loop, drop the lease, reset the per-process state.
export async function __stopCronScheduler(): Promise<void> {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.ticking = false;
  state.lastFireAt = null;
  await releaseLease(CRON_SCHEDULER_LEASE, state.owner);
}
