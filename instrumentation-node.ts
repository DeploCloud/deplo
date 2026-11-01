import { UpdateRefusedError } from "./lib/db/update-stops";

export async function register(): Promise<void> {
  try {
    const { runMigrations } = await import("./lib/db/migrate");
    await runMigrations();
  } catch (e) {
    // A refused update has already logged the one line the installer reads (ADR-0041).
    if (!(e instanceof UpdateRefusedError))
      console.error(
        "[deplo] DB migration failed at boot - refusing to serve on an out-of-date schema:",
        e,
      );
    throw e;
  }
  // Before the door opens, so server status hears every link come and go.
  try {
    const { startServerLinkStatus } = await import("./lib/data/server-health");
    startServerLinkStatus();
  } catch (e) {
    console.error("[deplo] server status could not follow agent links:", e);
  }
  try {
    const { startLinkAddressSync } =
      await import("./lib/data/servers/link-addresses");
    startLinkAddressSync();
  } catch (e) {
    console.error(
      "[deplo] agents could not be kept on the panel's addresses:",
      e,
    );
  }
  // Early, so servers relink while the jobs below make their first calls (ADR-0040).
  try {
    const { startAgentLinkListener } =
      await import("./lib/infra/agent-link/listener");
    await startAgentLinkListener();
  } catch (e) {
    console.error("[deplo] agent link listener could not start:", e);
  }
  try {
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
  // After the panel address: a resumed Deplo move sends it to the old Deplo.
  try {
    const { resumeDeploMoves } = await import("./lib/data/deplo-move/runner");
    await resumeDeploMoves();
  } catch (e) {
    console.error("[deplo] could not resume a Deplo move:", e);
  }
  try {
    const { logSetupLink } = await import("./lib/auth/setup");
    await logSetupLink();
  } catch (e) {
    console.error("[deplo] could not check for a first account:", e);
  }
  try {
    const { ensureDeploHostServer } =
      await import("./lib/data/servers/enrollment");
    await ensureDeploHostServer();
  } catch (e) {
    console.error("[deplo] could not register this host as a server:", e);
  }
  // After this host is a server: a move `deplo recover panel-address` left rides its own link.
  try {
    const { applyRecoveredPanelAddress } =
      await import("./lib/data/instance-settings/panel-route");
    void applyRecoveredPanelAddress().catch((e) =>
      console.error(
        "[deplo] could not move the panel as deplo recover asked; Deplo tries again at its next start:",
        e,
      ),
    );
  } catch (e) {
    console.error("[deplo] could not read a move deplo recover asked for:", e);
  }
  try {
    const { ensureTakeoverFromEnv } = await import("./lib/data/takeover");
    await ensureTakeoverFromEnv();
  } catch (e) {
    console.error("[deplo] could not read the takeover this install is:", e);
  }
  try {
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
  // Skipped while a move has this Deplo paused; the move picks them up when it ends (ADR-0035).
  const frozenAtBoot = await import("./lib/data/deplo-move/freeze")
    .then((m) => m.instanceFrozen())
    .catch(() => null);
  try {
    const { resumeAppDeletes } = await import("./lib/data/apps/delete");
    if (!frozenAtBoot)
      void resumeAppDeletes().catch((e) =>
        console.error(
          "[deplo] unfinished app deletes could not be resumed:",
          e,
        ),
      );
  } catch (e) {
    console.error("[deplo] app delete reconcile failed to start:", e);
  }
  try {
    const { runNetworkIsolationSweep } =
      await import("./lib/deploy/network-migration");
    if (!frozenAtBoot)
      void runNetworkIsolationSweep().catch((e) =>
        console.error("[deplo] network isolation sweep failed:", e),
      );
  } catch (e) {
    console.error("[deplo] network isolation sweep failed to start:", e);
  }
  try {
    const { startAgentRollout } =
      await import("./lib/data/servers/agent-rollout");
    await startAgentRollout();
  } catch (e) {
    console.error("[deplo] agent rollout startup failed:", e);
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
    const { startSecurityUpdatesScheduler } =
      await import("./lib/security-updates/scheduler");
    startSecurityUpdatesScheduler();
  } catch (e) {
    console.error("[deplo] security updates scheduler startup failed:", e);
  }
  try {
    const { startMetricsStreams } = await import("./lib/monitoring/supervisor");
    startMetricsStreams();
  } catch (e) {
    console.error("[deplo] metrics stream supervisor startup failed:", e);
  }
  // Never frozen-gated: a workload lent to a Deplo move starts again here once its lease lapses.
  try {
    const { startPauseSweep } =
      await import("./lib/data/deplo-move/source-pauses");
    startPauseSweep();
  } catch (e) {
    console.error("[deplo] Deplo move pause sweep startup failed:", e);
  }
  // A Deplo update rewrites this host's proxy stack; apps' Cloudflare Tunnel connectors come back here.
  {
    const g = globalThis as { __deploTunnelRestore?: boolean };
    if (!g.__deploTunnelRestore) {
      g.__deploTunnelRestore = true;
      const run = async () => {
        const { instanceFrozen } = await import("./lib/data/deplo-move/freeze");
        if (await instanceFrozen()) return;
        const { restoreTunnelConnectors } =
          await import("./lib/data/dns-providers/tunnels");
        const n = await restoreTunnelConnectors();
        if (n > 0)
          console.log(`[deplo] restored ${n} Cloudflare Tunnel connector(s)`);
      };
      const tick = () =>
        void run().catch((e) =>
          console.error("[deplo] tunnel connector check failed:", e),
        );
      setInterval(tick, 10 * 60 * 1000).unref?.();
      setTimeout(tick, 60_000).unref?.();
    }
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
  const { holdExitUntil } = await import("./lib/hold-exit");
  const { stopAcquiringLeases } = await import("./lib/backups/lease");
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      // A recreated container has a new hostname, so a lease left behind blocks its successor for 2h.
      stopAcquiringLeases();
      const done = Promise.allSettled([
        import("./lib/monitoring/supervisor").then(({ stopMetricsStreams }) =>
          stopMetricsStreams(),
        ),
        import("./lib/backups/scheduler").then(
          ({ releaseBackupSchedulerLease }) => releaseBackupSchedulerLease(),
        ),
        import("./lib/docker-cleanup/scheduler").then(
          ({ releaseDockerCleanupLease }) => releaseDockerCleanupLease(),
        ),
        import("./lib/previews/reaper").then(({ releasePreviewReaperLease }) =>
          releasePreviewReaperLease(),
        ),
        import("./lib/crons/scheduler").then(({ releaseCronSchedulerLease }) =>
          releaseCronSchedulerLease(),
        ),
        import("./lib/security-updates/scheduler").then(
          ({ releaseSecurityUpdatesLease }) => releaseSecurityUpdatesLease(),
        ),
        import("./lib/data/migration-runner/run-loop").then(
          ({ releaseMigrationRunnerLease }) => releaseMigrationRunnerLease(),
        ),
        import("./lib/graphql/pubsub").then(({ stopPubSubBridge }) =>
          stopPubSubBridge(),
        ),
        import("./lib/infra/agent-link/listener").then(
          ({ stopAgentLinkListener }) => stopAgentLinkListener(),
        ),
      ]);
      holdExitUntil(done, 3000);
    });
  }
}
