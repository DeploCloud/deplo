/**
 * Next.js instrumentation hook: runs ONCE per server instance at boot, before
 * the server handles requests (see node_modules/next/dist/docs/.../instrumentation.md).
 *
 * Deplo uses it for one thing today: reconciling deployments orphaned by a
 * control-plane restart (PLAN D5, Part-A half). A deploy is fire-and-forget — its
 * background job dies with the process — so a row left in `queued`/`building`
 * after a restart has no job to finish it. We mark those `error` on boot so a
 * hung deploy never lies indefinitely.
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
  } catch (e) {
    // Never let a boot-time reconcile failure crash the server.
    console.error("[deplo] startup reconcile failed:", e);
  }
}
