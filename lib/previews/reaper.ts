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

const REAP_BATCH = 50;

const STATE_CHECK_BATCH = 50;

function makeOwner(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

interface ReaperState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  owner: string;
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

export async function runPreviewReaperTick(
  now: Date = new Date(),
): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    if (!(await acquireLease(PREVIEW_REAPER_LEASE, state.owner, now))) return;
    // ponytail: one lease for two loops. If they ever contend, the drain takes a
    await drainTeardowns(now);
    await drainMigrationSourceUninstalls(now);
    if (now.getTime() - state.lastSweepAt < SWEEP_INTERVAL_MS) return;
    state.lastSweepAt = now.getTime();

    const { retry, expired } = await previewsDueForReaping(now, REAP_BATCH);

    for (const p of retry) {
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

    await pruneClosedPreviews(now, REAP_BATCH).catch(() => 0);

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

export function startPreviewReaper(): void {
  if (state.started) return;
  state.started = true;
  void runPreviewReaperTick();
  state.timer = setInterval(() => {
    void runPreviewReaperTick();
  }, TICK_MS);
  state.timer.unref?.();
}

export async function releasePreviewReaperLease(): Promise<void> {
  await releaseLease(PREVIEW_REAPER_LEASE, state.owner);
}
