import "server-only";

import { hostname } from "node:os";
import { randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { backups as backupsTable } from "../db/schema/control-plane/backups";
import { assembleBackup } from "../data/backup-rows";
import type { Backup } from "../types/backup";
import { sweepOrphanedBackupArtifacts } from "../data/backups/orphan-sweep";
import { runScheduledBackup } from "../data/backups/run-now";
import { cronMatchesInZone, dedupeKeyFor } from "../crons/cron-tz";
import {
  acquireLease,
  releaseLease,
  BACKUP_SCHEDULER_LEASE,
  LEASE_STALE_MS,
} from "./lease";

const TICK_MS = 60_000;

const ORPHAN_SWEEP_EVERY_MS = 24 * 60 * 60_000;

function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface SchedulerState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  lastFired: Map<string, { key: string; at: number }>;
  ticking: boolean;
  lastTickAt: Date | null;
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

// runSchedulerTick claims the lease, then runs every schedule due this minute.
export async function runSchedulerTick(now: Date = new Date()): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const held = await acquireLease(BACKUP_SCHEDULER_LEASE, state.owner, now);
    if (!held) return;

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
    const enabledRows = await getDb()
      .select()
      .from(backupsTable)
      .where(eq(backupsTable.enabled, true));
    const due: { backup: Backup; firedFor: string }[] = [];
    for (const b of enabledRows.map(assembleBackup)) {
      if (!b.schedule) continue;
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
      // Heartbeat mid-drain: a slow dump can outlast the lease and let another steal it.
      if (!(await acquireLease(BACKUP_SCHEDULER_LEASE, state.owner))) break;
      // Stamp before awaiting: an overlapping tick must not double-fire this schedule.
      state.lastFired.set(b.id, { key: firedFor, at: now.getTime() });
      try {
        await runScheduledBackup(b);
      } catch (e) {
        console.warn(
          `[backups] scheduled backup ${b.id} errored: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    for (const [id, seen] of state.lastFired) {
      if (now.getTime() - seen.at > LEASE_STALE_MS) state.lastFired.delete(id);
    }

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
    // Advance even when the lease was denied: those minutes were another instance's.
    state.lastTickAt = now;
    state.ticking = false;
  }
}

// releaseBackupSchedulerLease drops this process's hold; safe when it never held it.
export async function releaseBackupSchedulerLease(): Promise<void> {
  await releaseLease(BACKUP_SCHEDULER_LEASE, state.owner);
}

// startBackupScheduler starts the once-a-minute loop; idempotent, called at boot.
export function startBackupScheduler(): void {
  if (state.started) return;
  state.started = true;
  const timer = setInterval(() => {
    void runSchedulerTick();
  }, TICK_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;
  void runSchedulerTick();
  console.log("[deplo] backup scheduler started");
}

// __stopBackupScheduler is test-only: stop the loop, drop the lease, reset the state.
export async function __stopBackupScheduler(): Promise<void> {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.started = false;
  state.ticking = false;
  state.lastFired.clear();
  state.lastTickAt = null;
  await releaseLease(BACKUP_SCHEDULER_LEASE, state.owner);
}
