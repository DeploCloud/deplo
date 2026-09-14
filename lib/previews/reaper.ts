import "server-only";

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import {
  acquireLease,
  PREVIEW_REAPER_LEASE,
  releaseLease,
} from "../backups/lease";
import { closePreview } from "../deploy/preview-lifecycle/close";
import {
  openPreviewsForStateCheck,
  previewsDueForReaping,
  pruneClosedPreviews,
  retryPreviewTeardown,
} from "../deploy/preview-lifecycle/reaper";
import { drainTeardowns } from "../data/teardown-queue";
import { drainMigrationSourceUninstalls } from "../data/migration-import/source-agents";
import { getPullRequestState } from "../github/app";

const TICK_MS = 60_000;

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// Bounds how long one tick can hold the lease.
const REAP_BATCH = 50;

// One GitHub API call each, so a lost close is found within the hour up to fifty open previews.
const STATE_CHECK_BATCH = 50;

function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface ReaperState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
  // Epoch ms of the last completed sweep (0 ⇒ never), so the boot tick runs.
  lastSweepAt: number;
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

// runPreviewReaperTick runs one tick; it never throws, so one unreachable host does not stop the rest.
export async function runPreviewReaperTick(
  now: Date = new Date(),
): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    // Lease first: no point reading if another instance owns the sweep.
    if (!(await acquireLease(PREVIEW_REAPER_LEASE, state.owner, now))) return;
    // Drains on EVERY tick, above the hourly gate: its backoff ladder starts at a minute.
    // Same job as the retry loop below, for stacks whose preview row is already gone.
    // ponytail: one lease for two loops. If they ever contend, the drain takes a
    // fifth `scheduler_lease` name (no migration) and a boot block of its own.
    await drainTeardowns(now);
    await drainMigrationSourceUninstalls(now);
    if (now.getTime() - state.lastSweepAt < SWEEP_INTERVAL_MS) return;
    state.lastSweepAt = now.getTime();

    const { retry, expired } = await previewsDueForReaping(now, REAP_BATCH);

    for (const p of retry) {
      // Re-heartbeat: one tick must not hold the lease for an hour because hosts were slow.
      if (!(await acquireLease(PREVIEW_REAPER_LEASE, state.owner, new Date())))
        return;
      await retryPreviewTeardown(p.id).catch(() => false);
    }

    for (const p of expired) {
      if (!(await acquireLease(PREVIEW_REAPER_LEASE, state.owner, new Date())))
        return;
      await closePreview(p.id, "no activity on the pull request").catch(
        () => false,
      );
    }

    // Without this the list grew by one closed row per pull request, forever.
    await pruneClosedPreviews(now, REAP_BATCH).catch(() => 0);

    // A GitHub failure reports null, "don't know", so only a definite closed tears anything down.
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

// startPreviewReaper starts the reaper (idempotent); the interval is unref()'d so it never keeps the process alive.
export function startPreviewReaper(): void {
  if (state.started) return;
  state.started = true;
  void runPreviewReaperTick();
  state.timer = setInterval(() => {
    void runPreviewReaperTick();
  }, TICK_MS);
  state.timer.unref?.();
}

// releasePreviewReaperLease hands the lease back on shutdown instead of waiting out the staleness window.
export async function releasePreviewReaperLease(): Promise<void> {
  await releaseLease(PREVIEW_REAPER_LEASE, state.owner);
}
