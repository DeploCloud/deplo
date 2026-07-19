/**
 * Next.js instrumentation hook: runs ONCE per server instance at boot, before
 * the server handles requests (see node_modules/next/dist/docs/.../instrumentation.md).
 *
 * FIRST it APPLIES PENDING DB MIGRATIONS (the journal-driven Drizzle migrator),
 * so the reconcile + app reads below — and every request — run against the current
 * schema without a manual `db:migrate` step. Idempotent; a failure re-throws
 * (fail fast) rather than serve on an out-of-date schema.
 *
 * Then Deplo uses it to reconcile work orphaned by a control-plane restart:
 *  - Deployments: a deploy is fire-and-forget — its background job dies with the
 *    process. A `building` row (a build was actually in flight) has no job to
 *    finish it, so we mark it `error`. A `queued` row never started, so it is
 *    DURABLE: reconcile leaves it queued and re-drains the per-server deploy queue
 *    (lib/deploy/deploy-queue) so a restart mid-backlog resumes instead of losing
 *    it. Both live inside reconcileInFlightDeployments.
 *  - Backup runs (PLAN backups Step 3): a run is recorded `running` before the
 *    long dump and only flipped at the terminal mutate; a restart in between
 *    leaves it stuck `running`, which retention also never prunes. We mark stale
 *    `running` runs `failed` on boot so a hung backup never lies indefinitely.
 *
 *  - Docker-cleanup runs: identical shape (a `running` row is written before a sweep
 *    that can take half an hour), with one extra edge — the cleanup tick skips a
 *    server that already has a `running` run, so an unsettled orphan would take that
 *    host out of the schedule permanently.
 *
 * It also STARTS the two schedulers — the backup one (PLAN backups Step 6) and the
 * Docker-cleanup one — each a once-a-minute loop that fires due cron `schedule`s —
 * plus the metrics stream supervisor (lib/monitoring/supervisor.ts), which holds
 * one long-lived telemetry stream per server to keep the Monitoring history warm.
 * Boot is the natural home: it runs once per server instance, after the reconciles
 * have settled any orphaned runs, and each loop is lease-guarded (under its own
 * lease name) so multiple instances don't double-fire.
 *
 * Node runtime only: the reconcile + scheduler touch the `server-only` store. The
 * Edge runtime has neither, so guard on NEXT_RUNTIME.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Apply pending migrations BEFORE anything reads the schema. Deliberately OUTSIDE
  // the swallowing try below and re-thrown on failure: booting the app against an
  // out-of-date schema would fail every request, so a migration error must be loud
  // and stop the boot, not be silently ignored.
  try {
    const { runMigrations } = await import("./lib/db/migrate");
    await runMigrations();
  } catch (e) {
    console.error("[deplo] DB migration failed at boot — refusing to serve on an out-of-date schema:", e);
    throw e;
  }
  try {
    // The deployment reconcile is now async (relational). It marks orphaned
    // queued/building deploys error; it may be floated (genuinely fire-and-forget
    // — nothing downstream at boot depends on it). The BACKUP reconcile, by
    // contrast, MUST complete before the scheduler's first tick (its comment), so
    // it stays ordered before startBackupScheduler in cut-set (d).
    const { reconcileInFlightDeployments } = await import("./lib/deploy/build");
    const { startDeployQueue } = await import("./lib/deploy/deploy-queue");
    // Error orphaned `building` deploys, THEN re-drain the DURABLE `queued` backlog
    // per server (deploys that never started — a restart mid-queue resumes instead
    // of discarding them). Chained so the queue never dispatches alongside a
    // not-yet-errored orphan of the same service; floated as a whole since nothing
    // else at boot waits on deploys.
    void reconcileInFlightDeployments()
      .then(() => startDeployQueue())
      .catch((e) =>
        console.error("[deplo] deployment reconcile/redrain failed:", e),
      );
    const { reconcileInFlightBackupRuns } = await import("./lib/data/backups");
    // AWAITED (now relational/async): the backup reconcile MUST complete before
    // the scheduler's first tick reads a `running` run it never settled.
    await reconcileInFlightBackupRuns();
    // Start the backup scheduler after the reconcile so a boot tick never trips
    // over an orphaned `running` run. Idempotent + lease-guarded internally.
    const { startBackupScheduler } = await import("./lib/backups/scheduler");
    startBackupScheduler();
    const { reconcileInFlightCleanupRuns } = await import(
      "./lib/data/docker-cleanup"
    );
    // AWAITED, same rule as the backup reconcile: the cleanup tick SKIPS a server
    // that already has a `running` run (two `docker rmi` sweeps on one host would
    // race each other's candidate lists), so a run stranded by the restart that
    // brought us here would exclude its host from the schedule forever.
    await reconcileInFlightCleanupRuns();
    // Then the cleanup loop — a sibling of the backup scheduler under its own lease.
    // Its boot tick is load-bearing: unlike backups, cleanup CATCHES UP, so a control
    // plane that was down at 04:00 sweeps on the way back up.
    const { startDockerCleanupScheduler } = await import(
      "./lib/docker-cleanup/scheduler"
    );
    startDockerCleanupScheduler();
    // Finally the metrics stream supervisor — holds ONE long-lived telemetry
    // stream per server, which is what keeps every Monitoring chart warm whether
    // or not anybody has the page open (no reconcile to wait on: its state is
    // process RAM, born empty on every boot by design).
    const { startMetricsStreams, stopMetricsStreams } = await import(
      "./lib/monitoring/supervisor"
    );
    startMetricsStreams();
    // Unlike the interval-based collector this replaced, the streams MUST be torn
    // down: each holds an open gRPC channel here and a ticker plus a
    // `docker events` child on the agent. An unref()'d interval could be left to
    // leak; these cannot — and dev HMR re-runs register() on every edit.
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.once(sig, () => {
        void stopMetricsStreams();
      });
    }
  } catch (e) {
    // Never let a boot-time reconcile/scheduler failure crash the server.
    console.error("[deplo] startup reconcile failed:", e);
  }
}
