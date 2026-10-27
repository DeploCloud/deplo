import { builder } from "../builder";
import { AgentUpdateRef } from "./server/server-ref";
import {
  strandedByPanelUpdate,
  type StrandedServer,
} from "@/lib/data/servers/stranded-servers";
import {
  fleetAgentStatus,
  type FleetAgentStatus,
} from "@/lib/data/servers/agent-rollout";
import {
  applyDeploUpdate,
  getUpdateInfo,
  listDeploReleases,
  refreshUpdateInfo,
  setCanaryReleases,
  type DeploRelease,
  type DeploUpdateStarted,
  type UpdateInfo,
} from "@/lib/data/updates";

const StrandedServerRef = builder
  .objectRef<StrandedServer>("StrandedServer")
  .implement({
    description:
      "A server the offered Deplo version could not use: offline with an agent it would refuse, or not linked to this Deplo when that version reaches servers only over their link.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      version: t.exposeString("version", { nullable: true }),
      reinstall: t.exposeBoolean("reinstall", {
        description:
          "True when the offered version could not reach it at all: it has not linked to this Deplo since it started, and that version no longer contacts a server any other way. Only reinstalling its server agent would bring it back. False for an offline server that comes back once its server agent updates.",
      }),
    }),
  });

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
    canary: t.exposeBoolean("canary", {
      description:
        "Whether canary (pre-release) versions count as updates. Off: only stable releases do.",
    }),
    error: t.exposeString("error", { nullable: true }),
    strandedServers: t.field({
      type: [StrandedServerRef],
      authScopes: { instanceAdmin: true },
      description:
        "Servers the `latest` Deplo could not use. Offline servers whose agent is older than the minimum it supports: they stay unusable until they come back and their server agent updates. And, when `latest` reaches servers only over their link and this Deplo still contacts them directly, every server that has not linked to this Deplo since it started (`reinstall`). Empty when there is no update or the release does not say.",
      resolve: (info) =>
        info.updateAvailable && info.latest
          ? strandedByPanelUpdate(info.latest.replace(/^v/i, ""))
          : [],
    }),
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
      available: t.exposeBoolean("available", {
        description:
          "Newer than the running version, so installing an update brings it in.",
      }),
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
      usable: t.exposeBoolean("usable", {
        description:
          "False when the agent is older than `FleetAgents.minimum`: the server refuses everything until it updates.",
      }),
      update: t.field({
        type: AgentUpdateRef,
        nullable: true,
        resolve: (a) => a.update,
      }),
    }),
  });

const FleetAgentsRef = builder
  .objectRef<FleetAgentStatus>("FleetAgents")
  .implement({
    description:
      "How far the server agents are from the agent this Deplo is pinned to. Deplo updates every server that is behind on its own, so `behind` is what it has not carried yet.",
    fields: (t) => ({
      expected: t.exposeString("expected", {
        description: "The agent version this Deplo installs everywhere.",
      }),
      minimum: t.exposeString("minimum", {
        description:
          "The oldest agent this Deplo still talks to. Older is unusable until it updates.",
      }),
      total: t.exposeInt("total"),
      behind: t.field({ type: [FleetAgentRef], resolve: (f) => f.behind }),
      updating: t.exposeBoolean("updating", {
        description:
          "Deplo is still working on it: some server behind `expected` has not used up its 24 hours of retries.",
      }),
      pausedBy: t.exposeString("pausedBy", {
        nullable: true,
        description:
          "The server that took a new agent and did not come back on it. Every other update waits until it recovers.",
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
      "Deplo's published releases with their notes, newest first; canaries only while `updateInfo.canary` is on (or the one running). Cached for an hour and refreshed by checkForUpdates.",
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
  setCanaryReleases: t.field({
    type: UpdateInfoRef,
    authScopes: { instanceAdmin: true },
    description:
      "Offer canary (pre-release) versions of Deplo as updates, or go back to stable ones. Server agents follow the agent version the installed Deplo is pinned to, never this switch. Installs nothing: a newer version shows up as an update, and turning it off never downgrades anything already on a canary.",
    args: { enabled: t.arg.boolean({ required: true }) },
    resolve: (_r, { enabled }) => setCanaryReleases(enabled),
  }),
  checkForUpdates: t.field({
    type: UpdateInfoRef,
    authScopes: { instanceAdmin: true },
    description:
      "Re-run the upstream release check ignoring the cache, and expire the changelog beside it.",
    resolve: () => refreshUpdateInfo(),
  }),
}));
