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

const TICK_MS = 5_000;

const FIRE_EVERY_MS = 60_000;

const minuteOf = (d: Date): number => Math.floor(d.getTime() / FIRE_EVERY_MS);

export function shouldFire(now: Date, lastFireAt: Date | null): boolean {
  return lastFireAt === null || minuteOf(now) !== minuteOf(lastFireAt);
}

function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface SchedulerState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  ticking: boolean;
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

export async function runCronSchedulerTick(
  now: Date = new Date(),
): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  const fire = shouldFire(now, state.lastFireAt);
  try {
    if (!(await acquireLease(CRON_SCHEDULER_LEASE, state.owner, now))) return;
    const heartbeat = () => acquireLease(CRON_SCHEDULER_LEASE, state.owner);
    await reapInFlightRuns(now, heartbeat);
    if (fire) await fireDueJobs(replayWindow(now), heartbeat);
  } catch (e) {
    console.error(
      `[crons] scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    if (fire) state.lastFireAt = now;
    state.ticking = false;
  }
}

export async function releaseCronSchedulerLease(): Promise<void> {
  await releaseLease(CRON_SCHEDULER_LEASE, state.owner);
}

export function startCronScheduler(): void {
  if (state.started) return;
  state.started = true;
  const timer = setInterval(() => {
    void runCronSchedulerTick();
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
  void runCronSchedulerTick();
  console.log("[deplo] cron scheduler started");
}

export async function __stopCronScheduler(): Promise<void> {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.ticking = false;
  state.lastFireAt = null;
  await releaseLease(CRON_SCHEDULER_LEASE, state.owner);
}
