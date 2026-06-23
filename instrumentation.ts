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
 * Node runtime only: the reconcile touches the `server-only` store. The Edge
 * runtime has neither, so guard on NEXT_RUNTIME.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { ensureStoreReady } = await import("./lib/store");
    await ensureStoreReady();
    const { reconcileInFlightDeployments } = await import("./lib/deploy/build");
    reconcileInFlightDeployments();
    const { reconcileInFlightBackupRuns } = await import("./lib/data/backups");
    reconcileInFlightBackupRuns();
  } catch (e) {
    // Never let a boot-time reconcile failure crash the server.
    console.error("[deplo] startup reconcile failed:", e);
  }
}
