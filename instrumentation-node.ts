/**
 * The Node-runtime half of the instrumentation hook (instrumentation.ts imports
 * this file only when NEXT_RUNTIME === "nodejs").
 */
export async function register(): Promise<void> {
  // Apply pending migrations BEFORE anything reads the schema.
  try {
    const { runMigrations } = await import("./lib/db/migrate");
    await runMigrations();
  } catch (e) {
    console.error(
      "[deplo] DB migration failed at boot - refusing to serve on an out-of-date schema:",
      e,
    );
    throw e;
  }
  try {
    // AWAITED, and first: the stored panel address decides whether this process issues
    // `__Secure-` session cookies (lib/auth/better-auth.ts reads it synchronously when
    // it builds the auth instance).
    const { hydratePublicBaseUrl } =
      await import("./lib/data/instance-settings");
    await hydratePublicBaseUrl();
    // Immediately after, and for the same reason it had to come first: the OAuth
    // audience is DERIVED from that address, and since Better Auth 1.7.0 it is a stored
    // row rather than config.
    const { reconcileOAuthResources } =
      await import("./lib/auth/oauth-resources");
    await reconcileOAuthResources();
  } catch (e) {
    // Not fatal: without it the address falls back to DEPLO_PUBLIC_URL, which is
    // what every Deplo did before the setting existed.
    console.error(
      "[deplo] could not read the stored panel address at boot:",
      e,
    );
  }
  try {
    // Register this host as a server if nothing has yet - the first server a new
    // install gets, without anyone opening a shell.
    const { ensureDeploHostServer } = await import("./lib/data/servers");
    await ensureDeploHostServer();
  } catch (e) {
    // Not fatal: the panel still boots and the host can be added from the
    // dashboard the old way. Loud, though - a fresh install that lands here has
    // an empty server list and nothing to deploy to.
    console.error("[deplo] could not register this host as a server:", e);
  }
  try {
    // Retire anything left by the withdrawn Plugins feature (ADR-0013): with no Plugins
    // UI left, an installed plugin's container would otherwise be an orphan only a
    // shell on the host could remove.
    const { retireInstalledPlugins } = await import("./lib/plugins/retire");
    void retireInstalledPlugins().catch((e) =>
      console.error("[deplo] plugin retirement sweep failed:", e),
    );
  } catch (e) {
    console.error("[deplo] plugin retirement sweep failed to start:", e);
  }
  // Each reconcile/start below runs in ITS OWN try/catch: these are independent
  // subsystems, and one transient failure (say, the backup reconcile losing its
  // connection) must not silently skip every startup after it, which is exactly what
  // a single shared block would do.
  try {
    const { reconcileInFlightDeployments } = await import("./lib/deploy/build");
    const { startDeployQueue } = await import("./lib/deploy/deploy-queue");
    // The deployment reconcile is now async (relational); it may be floated (genuinely
    // fire-and-forget, nothing downstream at boot depends on it).
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
    // the scheduler's first tick reads a `running` run it never settled - the two
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
    const { reconcileInFlightCleanupRuns } =
      await import("./lib/data/docker-cleanup");
    // AWAITED, same rule as the backup reconcile: the cleanup tick SKIPS a server that
    // already has a `running` run (two `docker rmi` sweeps on one host would race each
    // other's candidate lists), so a run stranded by the restart that brought us here
    // would exclude its host from the schedule forever.
    await reconcileInFlightCleanupRuns();
    // Then the cleanup loop - a sibling of the backup scheduler under its own lease.
    // Its boot tick is load-bearing: unlike backups, cleanup CATCHES UP, so a control
    // plane that was down at 04:00 sweeps on the way back up.
    const { startDockerCleanupScheduler } =
      await import("./lib/docker-cleanup/scheduler");
    startDockerCleanupScheduler();
  } catch (e) {
    console.error(
      "[deplo] docker-cleanup reconcile/scheduler startup failed:",
      e,
    );
  }
  try {
    // Deletes stamped by a control plane that died mid-teardown.
    const { resumeAppDeletes } = await import("./lib/data/apps");
    void resumeAppDeletes().catch((e) =>
      console.error("[deplo] unfinished app deletes could not be resumed:", e),
    );
  } catch (e) {
    console.error("[deplo] app delete reconcile failed to start:", e);
  }
  try {
    // The pull request preview reaper - a third sibling under its own lease.
    const { startPreviewReaper } = await import("./lib/previews/reaper");
    startPreviewReaper();
  } catch (e) {
    console.error("[deplo] preview reaper startup failed:", e);
  }
  try {
    // Live updates reach the OTHER control planes on this database, if there are any.
    const { startPubSubBridge } = await import("./lib/graphql/pubsub");
    startPubSubBridge();
  } catch (e) {
    console.error("[deplo] live-update bridge startup failed:", e);
  }
  try {
    // The migration runner, and its boot tick is the load-bearing part: a control plane
    // that restarted mid-import is exactly the case this exists for.
    const { startMigrationRunner } = await import("./lib/data/dokploy-runner");
    startMigrationRunner();
  } catch (e) {
    console.error("[deplo] migration runner startup failed:", e);
  }
  try {
    // No reconcile to await either, and for a better reason than the reaper's: a cron
    // job runs inside the AGENT's process, so restarting Deplo does not kill it.
    const { startCronScheduler } = await import("./lib/crons/scheduler");
    startCronScheduler();
  } catch (e) {
    console.error("[deplo] cron scheduler startup failed:", e);
  }
  try {
    // Finally the metrics stream supervisor - holds ONE long-lived telemetry stream per
    // server, which is what keeps every Monitoring chart warm whether or not anybody
    // has the page open (no reconcile to wait on: its state is process RAM, born empty
    // on every boot by design).
    const { startMetricsStreams } = await import("./lib/monitoring/supervisor");
    startMetricsStreams();
  } catch (e) {
    console.error("[deplo] metrics stream supervisor startup failed:", e);
  }
  // Agent mTLS cert renewal: an agent leaf lives ~365 days, so twice a day sweep the
  // fleet and renew any leaf within 30 days of expiry (the agent hot-swaps it without
  // a restart).
  {
    const g = globalThis as { __deploCertSweep?: boolean };
    if (!g.__deploCertSweep) {
      g.__deploCertSweep = true;
      try {
        const { sweepExpiringAgentCerts } =
          await import("./lib/agent/cert-renewal");
        const { runMaintenanceSweep } =
          await import("./lib/notify/maintenance");
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
  // Teardown, registered OUTSIDE the fragile blocks above so a failed start can never
  // skip it. An unref()'d interval could be left to leak; these cannot, and dev HMR
  // re-runs register() on every edit.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void import("./lib/monitoring/supervisor")
        .then(({ stopMetricsStreams }) => stopMetricsStreams())
        .catch(() => {});
      void import("./lib/backups/scheduler")
        .then(({ releaseBackupSchedulerLease }) =>
          releaseBackupSchedulerLease(),
        )
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
      // Five leases, not four: the migration runner holds one too, and a
      // migration nobody may drive is worse than a backup nobody may take.
      void import("./lib/data/dokploy-runner")
        .then(({ releaseMigrationRunnerLease }) =>
          releaseMigrationRunnerLease(),
        )
        .catch(() => {});
      void import("./lib/graphql/pubsub")
        .then(({ stopPubSubBridge }) => stopPubSubBridge())
        .catch(() => {});
    });
  }
}
