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
  lastRefusedUpdate,
  type RefusedUpdate,
} from "@/lib/data/update-stops/refused";
import { leaveServerBehind } from "@/lib/data/update-stops/leave-behind";
import {
  applyDeploUpdate,
  listDeploReleases,
  readUpdateInfo,
  refreshUpdateInfo,
  setCanaryReleases,
  type DeploRelease,
  type DeploUpdateStarted,
  type UpdateInfo,
  type UpdateStopInfo,
} from "@/lib/data/updates";
import { bareVersion } from "@/lib/version";

const StrandedServerRef = builder
  .objectRef<StrandedServer>("StrandedServer")
  .implement({
    description:
      "An offline server whose agent the offered Deplo version would refuse.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      version: t.exposeString("version", { nullable: true }),
    }),
  });

const UpdateStopServerRef = builder
  .objectRef<{ id: string; name: string }>("UpdateStopServer")
  .implement({
    description:
      "A server an update stop named. No stop names one any more: kept one release for older API clients.",
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
    }),
  });

const NOTHING_WAITS =
  "Always empty: no update stop waits on servers any more (ADR-0041). Goes in the next release.";

const UpdateStopRef = builder
  .objectRef<UpdateStopInfo>("UpdateStop")
  .implement({
    description:
      "A release this instance must install, and whose conditions it must meet, before it can update past it (ADR-0041).",
    fields: (t) => ({
      version: t.exposeString("version"),
      reason: t.exposeString("reason", {
        description:
          "One plain sentence saying why Update offers what it does.",
      }),
      waiting: t.exposeBoolean("waiting", {
        description:
          "This instance runs the stop and its conditions do not hold yet, so Update offers nothing until they do.",
      }),
      waitingOn: t.field({
        type: [UpdateStopServerRef],
        deprecationReason: NOTHING_WAITS,
        resolve: () => [],
      }),
      leftBehind: t.field({
        type: [UpdateStopServerRef],
        deprecationReason: NOTHING_WAITS,
        resolve: () => [],
      }),
    }),
  });

const RefusedUpdateRef = builder
  .objectRef<RefusedUpdate>("RefusedUpdate")
  .implement({
    description:
      "An update that did not start, so the installer put the previous version back (ADR-0041).",
    fields: (t) => ({
      version: t.exposeString("version", {
        nullable: true,
        description:
          "The version that was rolled back, `v`-prefixed. Null when the installer could not tell.",
      }),
      reason: t.exposeString("reason", {
        description:
          "One plain sentence: the update stop to install first, or that the new version did not start.",
      }),
      at: t.exposeString("at", {
        nullable: true,
        description: "When the installer rolled it back (ISO 8601, UTC).",
      }),
    }),
  });

const UpdateInfoRef = builder.objectRef<UpdateInfo>("UpdateInfo").implement({
  description:
    "Result of checking the upstream GitHub repository for a newer Deplo release.",
  fields: (t) => ({
    current: t.exposeString("current"),
    latest: t.exposeString("latest", {
      nullable: true,
      description:
        "The newest release on this instance's channel. Update may install an update stop before it: see `next`.",
    }),
    updateAvailable: t.exposeBoolean("updateAvailable", {
      description: "Update installs something now: `next` is set.",
    }),
    next: t.exposeString("next", {
      nullable: true,
      description:
        "The version Update installs: `latest`, or the update stop this instance has to pass first. Null when there is nothing to install.",
    }),
    nextIsStop: t.exposeBoolean("nextIsStop", {
      description: "`next` is an update stop on the way to `latest`.",
    }),
    stop: t.field({
      type: UpdateStopRef,
      nullable: true,
      description:
        "The update stop between this instance and `latest`, while it has not passed it. Before any newer release requires it, this release itself while it is a stop not passed yet.",
      resolve: (info) => info.stop,
    }),
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
        "Offline servers whose agent is older than the minimum the `next` Deplo supports. They cannot update while offline, so they stay unusable until they come back and their agent updates. Empty when there is no update or the release does not say.",
      resolve: (info) =>
        info.next ? strandedByPanelUpdate(bareVersion(info.next)) : [],
    }),
    lastRefusedUpdate: t.field({
      type: RefusedUpdateRef,
      nullable: true,
      authScopes: { instanceAdmin: true },
      description:
        "The last update the installer rolled back, and why. Null once an update succeeds.",
      resolve: () => lastRefusedUpdate(),
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
          "Newer than the running version and no newer than `updateInfo.next`, so Update brings it in.",
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

const AgentReachEnum = builder.enumType("AgentReach", {
  description: "What this Deplo can do with a server's agent.",
  values: {
    usable: { description: "It talks to it." },
    updatable: {
      description:
        "It refuses it until it updates, which Deplo does on its own.",
    },
    unlinked: {
      description:
        "The server enrolled but has not connected to Deplo yet, so nothing reaches it. It comes back by itself once it connects.",
    },
    reinstall: {
      description:
        "The server can never connect: its agent is too old to, or it was left behind at an update stop on a version Deplo never read. Only reinstalling its server agent brings it back.",
    },
  } as const,
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
          "False when the agent is older than `FleetAgents.minimum`, or the server can never connect: it refuses everything meanwhile.",
      }),
      reach: t.field({
        type: AgentReachEnum,
        description:
          "Whether an update can bring it back, or only a reinstall.",
        resolve: (a) => a.reach,
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
    resolve: () => readUpdateInfo(),
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
      "Update this instance to `updateInfo.next`: the newest release, or the update stop it has to pass first. The server agent on the machine Deplo runs on re-runs the installer.",
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
  leaveServerBehind: t.field({
    type: UpdateInfoRef,
    authScopes: { instanceAdmin: true },
    description:
      "Refused: no update stop waits on servers any more, so there is no server to leave behind.",
    deprecationReason:
      "Always refused: no update stop waits on servers any more (ADR-0041). Goes in the next release.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => leaveServerBehind(id),
  }),
}));
