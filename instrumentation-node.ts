/**
 * The Node-runtime half of the instrumentation hook (instrumentation.ts imports
 * this file only when NEXT_RUNTIME === "nodejs"). It runs ONCE per server
 * instance at boot, before the server handles requests
 * (see node_modules/next/dist/docs/.../instrumentation.md).
 *
 * FIRST it APPLIES PENDING DB MIGRATIONS (the journal-driven Drizzle migrator),
 * so the reconcile + app reads below — and every request — run against the current
 * schema without a manual `db:migrate` step. Idempotent; a failure re-throws
 * (fail fast) rather than serve on an out-of-date schema.
 *
 * It also RETIRES the withdrawn Plugins feature (ADR-0013) — a container an older
 * version installed has no UI left to remove it, so the sweep in
 * lib/plugins/retire.ts tears it down. A no-op once the table is empty.
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
 * Node runtime only: the reconcile + scheduler touch the `server-only` store and
 * this file registers process signal handlers, neither of which the Edge runtime
 * has. instrumentation.ts owns that guard so this module is never bundled for Edge.
 */
export async function register(): Promise<void> {
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
    // AWAITED, and first: the stored panel address decides whether this process
    // issues `__Secure-` session cookies (lib/auth/better-auth.ts reads it
    // synchronously when it builds the auth instance). A request served before
    // this lands on a panel moved to http would mint a cookie the browser then
    // refuses to send back - a login screen that accepts the password and
    // returns to the login screen. One indexed SELECT.
    const { hydratePublicBaseUrl } = await import("./lib/data/instance-settings");
    await hydratePublicBaseUrl();
  } catch (e) {
    // Not fatal: without it the address falls back to DEPLO_PUBLIC_URL, which is
    // what every Deplo did before the setting existed.
    console.error("[deplo] could not read the stored panel address at boot:", e);
  }
  try {
    // Retire anything left by the withdrawn Plugins feature (ADR-0013): with no
    // Plugins UI left, an installed plugin's container would otherwise be an
    // orphan only a shell on the host could remove. Floated — a teardown can take
    // a couple of minutes and nothing at boot waits on it — and a no-op (one
    // indexed SELECT) once the table is empty, which it is on any fresh install.
    const { retireInstalledPlugins } = await import("./lib/plugins/retire");
    void retireInstalledPlugins().catch((e) =>
      console.error("[deplo] plugin retirement sweep failed:", e),
    );
  } catch (e) {
    console.error("[deplo] plugin retirement sweep failed to start:", e);
  }
  // Each reconcile/start below runs in ITS OWN try/catch: these are independent
  // subsystems, and one transient failure (say, the backup reconcile losing its
  // connection) must not silently skip every startup after it — which is exactly
  // what a single shared block would do. Never let any of them crash the server.
  try {
    const { reconcileInFlightDeployments } = await import("./lib/deploy/build");
    const { startDeployQueue } = await import("./lib/deploy/deploy-queue");
    // The deployment reconcile is now async (relational); it may be floated
    // (genuinely fire-and-forget — nothing downstream at boot depends on it).
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
  } catch (e) {
    console.error("[deplo] deployment reconcile/redrain failed to start:", e);
  }
  try {
    const { reconcileInFlightBackupRuns } = await import("./lib/data/backups");
    // AWAITED (now relational/async): the backup reconcile MUST complete before
    // the scheduler's first tick reads a `running` run it never settled — the two
    // stay ordered inside ONE block, so a failed reconcile also skips the start.
    await reconcileInFlightBackupRuns();
    // Start the backup scheduler after the reconcile so a boot tick never trips
    // over an orphaned `running` run. Idempotent + lease-guarded internally.
    const { startBackupScheduler } = await import("./lib/backups/scheduler");
    startBackupScheduler();
  } catch (e) {
    console.error("[deplo] backup reconcile/scheduler startup failed:", e);
  }
  try {
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
  } catch (e) {
    console.error("[deplo] docker-cleanup reconcile/scheduler startup failed:", e);
  }
  try {
    // The pull request preview reaper — a third sibling under its own lease.
    // No reconcile to await: unlike backups and cleanup it keeps no `running`
    // rows, and every predicate it uses is a plain DB state query, so a tick
    // that never happened costs nothing — the next one sees the same rows.
    // Its boot tick IS load-bearing though: it is what turns an outage into
    // minutes of delay for a preview whose pull request closed while we were
    // down, rather than a stack left running with nobody watching.
    const { startPreviewReaper } = await import("./lib/previews/reaper");
    startPreviewReaper();
  } catch (e) {
    console.error("[deplo] preview reaper startup failed:", e);
  }
  try {
    // No reconcile to await either, and for a better reason than the reaper's: a
    // cron job runs inside the AGENT's process, so restarting Deplo does not kill
    // it. The scheduler's boot tick REAPS before it fires, and reaping asks the
    // agent what actually happened — which is a reconcile that returns the real
    // exit code instead of guessing "interrupted".
    const { startCronScheduler } = await import("./lib/crons/scheduler");
    startCronScheduler();
  } catch (e) {
    console.error("[deplo] cron scheduler startup failed:", e);
  }
  try {
    // Finally the metrics stream supervisor — holds ONE long-lived telemetry
    // stream per server, which is what keeps every Monitoring chart warm whether
    // or not anybody has the page open (no reconcile to wait on: its state is
    // process RAM, born empty on every boot by design).
    const { startMetricsStreams } = await import("./lib/monitoring/supervisor");
    startMetricsStreams();
  } catch (e) {
    console.error("[deplo] metrics stream supervisor startup failed:", e);
  }
  // Agent mTLS cert renewal: an agent leaf lives ~365 days, so twice a day sweep
  // the fleet and renew any leaf within 30 days of expiry (the agent hot-swaps it
  // without a restart). Off the hot path; a failure just retries next tick with
  // the still-valid cert pinned, so this can never black out the fleet. Scheduled
  // ONCE (guarded across dev HMR re-runs) and unref'd so it never keeps the
  // process alive.
  {
    const g = globalThis as { __deploCertSweep?: boolean };
    if (!g.__deploCertSweep) {
      g.__deploCertSweep = true;
      try {
        const { sweepExpiringAgentCerts } = await import(
          "./lib/agent/cert-renewal"
        );
        const { runMaintenanceSweep } = await import("./lib/notify/maintenance");
        const run = () => {
          void sweepExpiringAgentCerts().catch((e) =>
            console.error("[cert-renewal] sweep failed:", e),
          );
          // Piggybacks the same twice-daily tick: a new Deplo release, an
          // outdated agent, a custom certificate about to lapse and a domain
          // whose DNS moved are all things nothing else ever polls.
          void runMaintenanceSweep().catch((e) =>
            console.error("[deplo] maintenance sweep failed:", e),
          );
        };
        setInterval(run, 12 * 60 * 60 * 1000).unref?.();
        setTimeout(run, 60_000).unref?.();
      } catch (e) {
        console.error("[deplo] cert-renewal sweep startup failed:", e);
      }
    }
  }
  // Teardown, registered OUTSIDE the fragile blocks above so a failed start can
  // never skip it. Unlike the interval-based collector this replaced, the metrics
  // streams MUST be torn down: each holds an open gRPC channel here and a ticker
  // plus a `docker events` child on the agent. An unref()'d interval could be left
  // to leak; these cannot — and dev HMR re-runs register() on every edit. The two
  // scheduler leases are handed back too, so the NEXT instance's first tick claims
  // them immediately — a lease left behind blocks backups + cleanup for up to the
  // 2h staleness window. Fire-and-forget (Next's own signal handler owns the
  // actual exit); each teardown is guarded so one failure never blocks the others.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void import("./lib/monitoring/supervisor")
        .then(({ stopMetricsStreams }) => stopMetricsStreams())
        .catch(() => {});
      void import("./lib/backups/scheduler")
        .then(({ releaseBackupSchedulerLease }) => releaseBackupSchedulerLease())
        .catch(() => {});
      void import("./lib/docker-cleanup/scheduler")
        .then(({ releaseDockerCleanupLease }) => releaseDockerCleanupLease())
        .catch(() => {});
      void import("./lib/previews/reaper")
        .then(({ releasePreviewReaperLease }) => releasePreviewReaperLease())
        .catch(() => {});
      void import("./lib/crons/scheduler")
        .then(({ releaseCronSchedulerLease }) => releaseCronSchedulerLease())
        .catch(() => {});
    });
  }
}
