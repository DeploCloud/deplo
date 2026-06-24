/**
 * Next.js instrumentation hook: runs ONCE per server instance at boot, before
 * the server handles requests (see node_modules/next/dist/docs/.../instrumentation.md).
 *
 * Deplo uses it to reconcile work orphaned by a control-plane restart:
 *  - Deployments (PLAN D5, Part-A half): a deploy is fire-and-forget — its
 *    background job dies with the process — so a row left in `queued`/`building`
 *    after a restart has no job to finish it. We mark those `error` on boot.
 *  - Backup runs (PLAN backups Step 3): a run is recorded `running` before the
 *    long dump and only flipped at the terminal mutate; a restart in between
 *    leaves it stuck `running`, which retention also never prunes. We mark stale
 *    `running` runs `failed` on boot so a hung backup never lies indefinitely.
 *
 * It also STARTS the backup scheduler (PLAN backups Step 6) — the once-a-minute
 * loop that fires due cron `schedule`s. Boot is the natural home: it runs once
 * per server instance, after the reconcile has settled any orphaned runs, and the
 * loop is lease-guarded so multiple instances don't double-fire.
 *
 * Node runtime only: the reconcile + scheduler touch the `server-only` store. The
 * Edge runtime has neither, so guard on NEXT_RUNTIME.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureStoreReady } = await import("./lib/store");
    await ensureStoreReady();
    // The deployment reconcile is now async (relational). It marks orphaned
    // queued/building deploys error; it may be floated (genuinely fire-and-forget
    // — nothing downstream at boot depends on it). The BACKUP reconcile, by
    // contrast, MUST complete before the scheduler's first tick (its comment), so
    // it stays ordered before startBackupScheduler in cut-set (d).
    const { reconcileInFlightDeployments } = await import("./lib/deploy/build");
    void reconcileInFlightDeployments().catch((e) =>
      console.error("[deplo] deployment reconcile failed:", e),
    );
    const { reconcileInFlightBackupRuns } = await import("./lib/data/backups");
    // AWAITED (now relational/async): the backup reconcile MUST complete before
    // the scheduler's first tick reads a `running` run it never settled.
    await reconcileInFlightBackupRuns();
    // Start the backup scheduler after the reconcile so a boot tick never trips
    // over an orphaned `running` run. Idempotent + lease-guarded internally.
    const { startBackupScheduler } = await import("./lib/backups/scheduler");
    startBackupScheduler();
  } catch (e) {
    // Never let a boot-time reconcile/scheduler failure crash the server.
    console.error("[deplo] startup reconcile failed:", e);
  }
}
