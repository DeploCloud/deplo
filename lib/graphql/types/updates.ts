import { builder } from "../builder";
import {
  fleetAgentStatus,
  type FleetAgentStatus,
} from "@/lib/data/servers/agent-rollout";
import {
  applyDeploUpdate,
  getUpdateInfo,
  listDeploReleases,
  refreshUpdateInfo,
  type DeploRelease,
  type DeploUpdateStarted,
  type UpdateInfo,
} from "@/lib/data/updates";

const UpdateInfoRef = builder.objectRef<UpdateInfo>("UpdateInfo").implement({
  description:
    "Result of checking the upstream GitHub repository for a newer Deplo release.",
  fields: (t) => ({
    current: t.exposeString("current"),
    latest: t.exposeString("latest", { nullable: true }),
    updateAvailable: t.exposeBoolean("updateAvailable"),
    url: t.exposeString("url", { nullable: true }),
    name: t.exposeString("name", { nullable: true }),
    publishedAt: t.exposeString("publishedAt", { nullable: true }),
    checkedAt: t.exposeString("checkedAt"),
    error: t.exposeString("error", { nullable: true }),
  }),
});

const DeploReleaseRef = builder
  .objectRef<DeploRelease>("DeploRelease")
  .implement({
    description: "One published release of Deplo, as the changelog renders it.",
    fields: (t) => ({
      tag: t.exposeString("tag"),
      name: t.exposeString("name"),
      url: t.exposeString("url"),
      publishedAt: t.exposeString("publishedAt", { nullable: true }),
      body: t.exposeString("body"),
      prerelease: t.exposeBoolean("prerelease"),
      current: t.exposeBoolean("current"),
    }),
  });

const ChangelogRef = builder
  .objectRef<{ releases: DeploRelease[]; error?: string }>("DeploChangelog")
  .implement({
    description: "Deplo's published releases, newest first.",
    fields: (t) => ({
      releases: t.field({
        type: [DeploReleaseRef],
        resolve: (c) => c.releases,
      }),
      error: t.exposeString("error", { nullable: true }),
    }),
  });

const FleetAgentRef = builder
  .objectRef<FleetAgentStatus["behind"][number]>("FleetAgent")
  .implement({
    description: "One server whose agent is older than the fleet version.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      version: t.exposeString("version", { nullable: true }),
    }),
  });

const FleetAgentsRef = builder
  .objectRef<FleetAgentStatus>("FleetAgents")
  .implement({
    description:
      "How far the server agents are from the version this panel expects. They follow a panel update on their own, so `behind` is what that rollout has not carried yet.",
    fields: (t) => ({
      expected: t.exposeString("expected"),
      total: t.exposeInt("total"),
      behind: t.field({ type: [FleetAgentRef], resolve: (f) => f.behind }),
      updating: t.exposeBoolean("updating", {
        description:
          "A rollout is still owed: Deplo retries every 15 minutes until every server is on `expected`.",
      }),
    }),
  });

builder.queryFields((t) => ({
  fleetAgents: t.field({
    type: FleetAgentsRef,
    authScopes: { instanceAdmin: true },
    description:
      "The fleet's agent versions, and whether Deplo is still rolling an update out to them.",
    resolve: () => fleetAgentStatus(),
  }),
  updateInfo: t.field({
    type: UpdateInfoRef,
    authScopes: { instanceAdmin: true },
    description:
      "Check the upstream repository for a newer Deplo release; cached for an hour.",
    resolve: () => getUpdateInfo(),
  }),
  deploChangelog: t.field({
    type: ChangelogRef,
    authScopes: { instanceAdmin: true },
    description:
      "Deplo's published releases with their notes, newest first; cached for an hour and refreshed by checkForUpdates.",
    resolve: () => listDeploReleases(),
  }),
}));

const UpdateStartedRef = builder
  .objectRef<DeploUpdateStarted>("DeploUpdateStarted")
  .implement({
    description:
      "An update the host has STARTED. Deplo restarts as it lands, so there is no completion to report here.",
    fields: (t) => ({
      version: t.exposeString("version"),
      logPath: t.exposeString("logPath"),
    }),
  });

builder.mutationFields((t) => ({
  updateDeplo: t.field({
    type: UpdateStartedRef,
    authScopes: { instanceAdmin: true },
    description:
      "Update this instance to the newest release: the agent on the machine Deplo runs on re-runs the installer.",
    resolve: () => applyDeploUpdate(),
  }),
  checkForUpdates: t.field({
    type: UpdateInfoRef,
    authScopes: { instanceAdmin: true },
    description:
      "Re-run the upstream release check ignoring the cache, and expire the changelog beside it.",
    resolve: () => refreshUpdateInfo(),
  }),
}));
