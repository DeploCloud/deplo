export async function register(): Promise<void> {
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
    // First and awaited: the panel address decides whether sessions get __Secure- cookies.
    const { hydratePublicBaseUrl } =
      await import("./lib/data/instance-settings/settings-store");
    await hydratePublicBaseUrl();
    const { reconcileOAuthResources } =
      await import("./lib/auth/oauth-resources");
    await reconcileOAuthResources();
  } catch (e) {
    console.error(
      "[deplo] could not read the stored panel address at boot:",
      e,
    );
  }
  try {
    const { ensureDeploHostServer } =
      await import("./lib/data/servers/enrollment");
    await ensureDeploHostServer();
  } catch (e) {
    console.error("[deplo] could not register this host as a server:", e);
  }
  try {
    const { ensureTakeoverFromEnv } = await import("./lib/data/takeover");
    await ensureTakeoverFromEnv();
  } catch (e) {
    console.error("[deplo] could not read the takeover this install is:", e);
  }
  try {
    // Retire anything left by the withdrawn Plugins feature (ADR-0013).
    const { retireInstalledPlugins } = await import("./lib/plugins/retire");
    void retireInstalledPlugins().catch((e) =>
      console.error("[deplo] plugin retirement sweep failed:", e),
    );
  } catch (e) {
    console.error("[deplo] plugin retirement sweep failed to start:", e);
  }
  try {
    const { reconcileInFlightDeployments } =
      await import("./lib/deploy/build/deployment-state");
    const { startDeployQueue } = await import("./lib/deploy/deploy-queue");
    void reconcileInFlightDeployments()
      .then(() => startDeployQueue())
      .catch((e) =>
        console.error("[deplo] deployment reconcile/redrain failed:", e),
      );
  } catch (e) {
    console.error("[deplo] deployment reconcile/redrain failed to start:", e);
  }
  try {
    const { reconcileInFlightBackupRuns } =
      await import("./lib/data/backups/orphan-sweep");
    await reconcileInFlightBackupRuns();
    const { startBackupScheduler } = await import("./lib/backups/scheduler");
    startBackupScheduler();
  } catch (e) {
    console.error("[deplo] backup reconcile/scheduler startup failed:", e);
  }
  try {
    const { reconcileInFlightCleanupRuns } =
      await import("./lib/data/docker-cleanup/run-history");
    await reconcileInFlightCleanupRuns();
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
    const { resumeAppDeletes } = await import("./lib/data/apps/delete");
    void resumeAppDeletes().catch((e) =>
      console.error("[deplo] unfinished app deletes could not be resumed:", e),
    );
  } catch (e) {
    console.error("[deplo] app delete reconcile failed to start:", e);
  }
  try {
    const { runNetworkIsolationSweep } =
      await import("./lib/deploy/network-migration");
    void runNetworkIsolationSweep().catch((e) =>
      console.error("[deplo] network isolation sweep failed:", e),
    );
  } catch (e) {
    console.error("[deplo] network isolation sweep failed to start:", e);
  }
  try {
    const { startPreviewReaper } = await import("./lib/previews/reaper");
    startPreviewReaper();
  } catch (e) {
    console.error("[deplo] preview reaper startup failed:", e);
  }
  try {
    const { startPubSubBridge } = await import("./lib/graphql/pubsub");
    startPubSubBridge();
  } catch (e) {
    console.error("[deplo] live-update bridge startup failed:", e);
  }
  try {
    const { startMigrationRunner } =
      await import("./lib/data/migration-runner/run-loop");
    startMigrationRunner();
  } catch (e) {
    console.error("[deplo] migration runner startup failed:", e);
  }
  try {
    const { startCronScheduler } = await import("./lib/crons/scheduler");
    startCronScheduler();
  } catch (e) {
    console.error("[deplo] cron scheduler startup failed:", e);
  }
  try {
    const { startMetricsStreams } = await import("./lib/monitoring/supervisor");
    startMetricsStreams();
  } catch (e) {
    console.error("[deplo] metrics stream supervisor startup failed:", e);
  }
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
      void import("./lib/data/migration-runner/run-loop")
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
