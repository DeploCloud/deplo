import "server-only";

/**
 * Process teardown for the boot-time subsystems (see instrumentation.ts).
 *
 * Lives in its own Node-only module rather than inline in `instrumentation.ts`
 * because that file is compiled for the Edge runtime too (a `proxy.ts` exists),
 * and Turbopack statically rejects `process.once` there — the
 * `NEXT_RUNTIME !== "nodejs"` early return happens too late to help a static
 * check. Every other Node-only side effect in that file already hides behind an
 * `await import(...)` for the same reason.
 *
 * Unlike the interval-based collector it replaced, the metrics streams MUST be
 * torn down: each holds an open gRPC channel here plus a ticker and a
 * `docker events` child on the agent. The two scheduler leases are handed back
 * too, so the NEXT instance's first tick claims them immediately — a lease left
 * behind blocks backups + cleanup for up to the 2h staleness window.
 *
 * Fire-and-forget (Next's own signal handler owns the actual exit); each
 * teardown is guarded so one failure never blocks the others. Guarded across dev
 * HMR re-runs, which call `register()` again on every edit.
 */
export function registerShutdownHooks(): void {
  const g = globalThis as { __deploShutdownHooks?: boolean };
  if (g.__deploShutdownHooks) return;
  g.__deploShutdownHooks = true;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void import("./monitoring/supervisor")
        .then(({ stopMetricsStreams }) => stopMetricsStreams())
        .catch(() => {});
      void import("./backups/scheduler")
        .then(({ releaseBackupSchedulerLease }) => releaseBackupSchedulerLease())
        .catch(() => {});
      void import("./docker-cleanup/scheduler")
        .then(({ releaseDockerCleanupLease }) => releaseDockerCleanupLease())
        .catch(() => {});
    });
  }
}
