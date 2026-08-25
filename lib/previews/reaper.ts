import "server-only";

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import {
  acquireLease,
  PREVIEW_REAPER_LEASE,
  releaseLease,
} from "../backups/lease";
import {
  closePreview,
  openPreviewsForStateCheck,
  previewsDueForReaping,
  teardownPreviewStack,
} from "../deploy/preview-lifecycle";
import { drainTeardowns } from "../data/teardown-queue";
import { drainMigrationSourceUninstalls } from "../data/dokploy-import";
import { getPullRequestState } from "../github/app";

/**
 * The pull request preview reaper - the loop that makes "torn down when the pull
 * request closes" true even when the close never reached us. Same singleton-on-
 * `globalThis` shape, same `ticking` re-entrancy guard, lease claimed first.
 */

const TICK_MS = 60_000;

/** Sweep at most once an hour: nothing here changes minute to minute. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Teardowns per tick. Bounds how long one tick can hold the lease. */
const REAP_BATCH = 20;

/** Pull requests re-checked against GitHub per sweep (the slowest step). */
const STATE_CHECK_BATCH = 20;

function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface ReaperState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  /** Epoch ms of the last completed sweep (0 ⇒ never), so the boot tick runs. */
  lastSweepAt: number;
  /** True while a tick is in flight, so a slow tick never overlaps the next. */
  ticking: boolean;
}

const STATE_KEY = Symbol.for("deplo.preview.reaper");
const g = globalThis as unknown as { [STATE_KEY]?: ReaperState };
const state: ReaperState = (g[STATE_KEY] ??= {
  started: false,
  timer: null,
  owner: makeOwner(),
  lastSweepAt: 0,
  ticking: false,
});

/**
 * One reaper tick. Exported for tests and for an immediate first run; safe to
 * call directly and never throws - one unreachable host is contained so the rest
 * still get swept.
 */
export async function runPreviewReaperTick(
  now: Date = new Date(),
): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    // Lease first: no point reading if another instance owns the sweep.
    if (!(await acquireLease(PREVIEW_REAPER_LEASE, state.owner, now))) return;
    // The teardown queue drains on EVERY tick, under this lease: its backoff
    // ladder starts at a minute, and it is the same job as the retry loop below
    // (finish a teardown that could not finish) for stacks whose row is gone.
    // ponytail: one lease for two loops. If they ever contend, the drain takes a
    // fifth `scheduler_lease` name (no migration) and a boot block of its own.
    await drainTeardowns(now);
    // And the other thing a finished action can still owe a host: taking Deplo's agent
    // back off a migration source.
    await drainMigrationSourceUninstalls(now);
    // The preview sweep stays hourly: nothing here changes minute to minute.
    if (now.getTime() - state.lastSweepAt < SWEEP_INTERVAL_MS) return;
    state.lastSweepAt = now.getTime();

    const { retry, expired } = await previewsDueForReaping(now, REAP_BATCH);

    for (const p of retry) {
      // Re-heartbeat between teardowns: one tick must not hold the lease for an
      // hour because twenty hosts were slow.
      if (!(await acquireLease(PREVIEW_REAPER_LEASE, state.owner, new Date())))
        return;
      await teardownPreviewStack(p).catch(() => false);
    }

    for (const p of expired) {
      if (!(await acquireLease(PREVIEW_REAPER_LEASE, state.owner, new Date())))
        return;
      await closePreview(p.id, "no activity on the pull request").catch(
        () => false,
      );
    }

    // The missed-`closed`-webhook net, last because it is the only networked
    // step. A GitHub failure reports null, "don't know", and the preview is
    // left alone; only a definite `closed` tears anything down.
    const open = await openPreviewsForStateCheck(STATE_CHECK_BATCH);
    for (const p of open) {
      if (!p.installationId || !p.repo) continue;
      if (!(await acquireLease(PREVIEW_REAPER_LEASE, state.owner, new Date())))
        return;
      const upstream = await getPullRequestState(
        p.installationId,
        p.repo,
        p.prNumber,
      );
      if (upstream === "closed") {
        await closePreview(p.id, "pull request is closed on GitHub").catch(
          () => false,
        );
      }
    }
  } catch (e) {
    console.error("[deplo] preview reaper tick failed:", e);
  } finally {
    state.ticking = false;
  }
}

/**
 * Start the reaper (idempotent). The interval is `unref()`'d so it never keeps the
 * process alive.
 */
export function startPreviewReaper(): void {
  if (state.started) return;
  state.started = true;
  void runPreviewReaperTick();
  state.timer = setInterval(() => {
    void runPreviewReaperTick();
  }, TICK_MS);
  state.timer.unref?.();
}

/** Hand the lease back on shutdown so the next instance claims it immediately
 *  instead of waiting out the staleness window. */
export async function releasePreviewReaperLease(): Promise<void> {
  await releaseLease(PREVIEW_REAPER_LEASE, state.owner);
}

/** Test-only: forget the "already swept" clock so the next tick does work. */
export function __resetPreviewReaperForTest(): void {
  state.started = false;
  state.lastSweepAt = 0;
  state.ticking = false;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}
