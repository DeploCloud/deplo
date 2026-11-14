import { refreshClusterWarningsSoon } from "@/lib/data/clusters/warnings";
import { builder } from "../builder";
import { ServerStatusEnum } from "./server/server-ref";
import { TeamRef } from "./team";
import {
  createCluster,
  renameCluster,
  setClusterFailover,
  setClusterTeams,
} from "@/lib/data/clusters/manage";
import {
  ensureClusterLeader,
  getClusterLeader,
} from "@/lib/data/clusters/leader";
import {
  listClusterLeaderChoices,
  moveClusterLeader,
} from "@/lib/data/clusters/leader-move";
import { listClusterImageProgress } from "@/lib/data/clusters/images";
import { listClusterWaiting } from "@/lib/data/clusters/placement";
import {
  getCluster,
  getClusterTeams,
  listClusters,
} from "@/lib/data/clusters/roster";
import { listPlacementChoices } from "@/lib/data/clusters/choices";
import {
  deleteCluster,
  getClusterDeletion,
  removeClusterMember,
} from "@/lib/data/clusters/dissolve";
import { cancelClusterMemberRemoval } from "@/lib/data/clusters/empty";
import {
  addClusterMember,
  listClusterJoinCandidates,
  listClusterMembers,
} from "@/lib/data/clusters/members";
import {
  failoverOn,
  type Cluster,
  type ClusterDeletion,
  type ClusterEmptying,
  type ClusterImageProgress,
  type ClusterJoin,
  type ClusterJoinCandidate,
  type ClusterJoinReason,
  type ClusterLeader,
  type ClusterLeaderChoice,
  type ClusterMember,
  type ClusterReleasedWorkload,
} from "@/lib/types/cluster";

// What the actor just changed shows in the cluster's warnings now, not at the next background pass.
async function thenRefresh<T>(clusterId: string, done: Promise<T>): Promise<T> {
  const out = await done;
  refreshClusterWarningsSoon(clusterId);
  return out;
}

const ClusterLeaderStateEnum = builder.enumType("ClusterLeaderState", {
  values: [
    "running",
    "stopped",
    "not_installed",
    "unreachable",
    "unavailable",
    "outdated",
  ] as const,
});

const ClusterLeaderRef = builder
  .objectRef<ClusterLeader>("ClusterLeader")
  .implement({
    description:
      "Where a cluster's leader runs and whether it answers, asked live of the server that runs it.",
    fields: (t) => ({
      serverId: t.exposeID("serverId", {
        nullable: true,
        description:
          "The server it runs on; null when Deplo's machine has no server entry.",
      }),
      serverName: t.exposeString("serverName"),
      onDeploHost: t.exposeBoolean("onDeploHost", {
        description: "It runs on the machine Deplo itself runs on.",
      }),
      state: t.field({ type: ClusterLeaderStateEnum, resolve: (l) => l.state }),
      version: t.exposeString("version"),
      message: t.exposeString("message", {
        description:
          "One plain sentence on why it is not running, or that it hears too few servers to move anything; empty otherwise.",
      }),
      failoverReady: t.boolean({
        nullable: true,
        description:
          "Whether a failover would work right now: the leader answers and enough servers answer it. Null with fewer than two servers, or while Deplo's machine stands in for the leader.",
        resolve: (l) => l.failoverReady,
      }),
      takenOverAt: t.exposeString("takenOverAt", {
        nullable: true,
        description:
          "Since when Deplo's own machine leads the cluster because this leader does not answer; null while this leader leads. It leads again once it answers.",
      }),
      updateMessage: t.exposeString("updateMessage", {
        description:
          "One plain sentence while Deplo cannot update a leader this cluster relies on; empty otherwise. Deplo retries on its own.",
      }),
      relayMessage: t.exposeString("relayMessage", {
        description:
          "One plain sentence while servers may not reach the relay on Deplo's machine, so failover would stop with the leader's server; empty otherwise. Deplo retries on its own.",
      }),
      ownServerWarning: t.exposeString("ownServerWarning", {
        description:
          "The warning while Deplo's own server is a member of the cluster and the leader runs on it; empty otherwise. moveClusterLeader fixes it.",
      }),
    }),
  });

const ClusterLeaderChoiceRef = builder
  .objectRef<ClusterLeaderChoice>("ClusterLeaderChoice")
  .implement({
    description:
      "A server the leader can run on; an empty `blocked` means moveClusterLeader takes it.",
    fields: (t) => ({
      serverId: t.exposeID("serverId"),
      serverName: t.exposeString("serverName"),
      onDeploHost: t.exposeBoolean("onDeploHost", {
        description:
          "Deplo's own machine, where the leader runs unless it is moved.",
      }),
      current: t.exposeBoolean("current", {
        description: "The leader runs here now.",
      }),
      blocked: t.exposeString("blocked", {
        description:
          "Why the leader cannot run there right now; empty when it can.",
      }),
      note: t.exposeString("note", {
        description:
          "What a leader there cannot do; empty when nothing. A server with no proxy still needs Deplo's machine up to move anything.",
      }),
    }),
  });

const ClusterLeaseStateEnum = builder.enumType("ClusterLeaseState", {
  values: ["ok", "not_responding", "fenced"] as const,
});

const ClusterImageProgressRef = builder
  .objectRef<ClusterImageProgress>("ClusterImageProgress")
  .implement({
    description:
      "An App whose newest release is still being copied to the servers of the cluster.",
    fields: (t) => ({
      appId: t.exposeID("appId"),
      appName: t.exposeString("appName"),
      held: t.exposeInt("held", {
        description: "Servers that hold the release now.",
      }),
      total: t.exposeInt("total", {
        description: "Servers that will hold it when the copies finish.",
      }),
    }),
  });

const ClusterEmptyingRef = builder
  .objectRef<ClusterEmptying>("ClusterEmptying")
  .implement({
    description:
      "How far removing a server has got. Its Apps and databases move to the other servers of the cluster, one at a time, then it leaves.",
    fields: (t) => ({
      since: t.exposeString("since"),
      total: t.exposeInt("total", {
        description: "How many Apps and databases it held at the start.",
      }),
      left: t.exposeInt("left", {
        description: "How many it still holds; 0 means it is empty.",
      }),
      moving: t.exposeString("moving", {
        description: "The App or database moving now; empty between two moves.",
      }),
      error: t.exposeString("error", {
        description:
          "Why it stopped, in one sentence, until removeClusterMember is called again; empty while it runs.",
      }),
    }),
  });

const ClusterMemberRef = builder
  .objectRef<ClusterMember>("ClusterMember")
  .implement({
    description:
      "A server in a cluster. The cluster decides where its Apps and databases run, unless one is moved onto a server of it by hand.",
    fields: (t) => ({
      serverId: t.exposeID("serverId"),
      serverName: t.exposeString("serverName"),
      status: t.field({ type: ServerStatusEnum, resolve: (m) => m.status }),
      joinedAt: t.exposeString("joinedAt"),
      emptyingSince: t.exposeString("emptyingSince", {
        nullable: true,
        description: "Set while the member is being removed.",
      }),
      emptying: t.field({
        type: ClusterEmptyingRef,
        nullable: true,
        description:
          "Progress while the server is being removed; null otherwise. It takes no new work in the meantime.",
        resolve: (m) => m.emptying,
      }),
      leaseState: t.field({
        type: ClusterLeaseStateEnum,
        description:
          "What the cluster's leader last said: answering, not responding (3 seconds without an answer), or fenced (it has stopped its databases and Apps with files).",
        resolve: (m) => m.leaseState,
      }),
      held: t.exposeInt("held", {
        description:
          "How many Apps and databases it holds. Removing it needs 0, except for the last member, which may keep them.",
      }),
      provisioning: t.exposeBoolean("provisioning", {
        description:
          "True from the moment it joins until the cluster's leader answers for it.",
      }),
    }),
  });

const WorkloadKindEnum = builder.enumType("ClusterWorkloadKind", {
  values: ["app", "database"] as const,
});

const ClusterReleasedWorkloadRef = builder
  .objectRef<ClusterReleasedWorkload>("ClusterReleasedWorkload")
  .implement({
    description:
      "An App or database a cluster lets go of when it is deleted. It stays on the server it runs on.",
    fields: (t) => ({
      kind: t.field({ type: WorkloadKindEnum, resolve: (w) => w.kind }),
      name: t.exposeString("name"),
      serverName: t.exposeString("serverName", {
        description: "The server it stays on.",
      }),
      stopsOn: t.exposeStringList("stopsOn", {
        description:
          "The other servers a spread App also runs on. Its replicas there stop.",
      }),
      waiting: t.exposeBoolean("waiting", {
        description:
          "It found no room after a server stopped, so it is not running now and stays stopped.",
      }),
      losesReach: t.exposeStringList("losesReach", {
        description:
          "For an App: the Apps and databases of its Environment on another server, which it reaches by name today and no longer will once the cluster is gone.",
      }),
    }),
  });

const ClusterDeletionTeamRef = builder
  .objectRef<ClusterDeletion["otherTeams"][number]>("ClusterDeletionTeam")
  .implement({
    description:
      "How much of another team's work a cluster holds: a count, never the names.",
    fields: (t) => ({
      teamName: t.exposeString("teamName"),
      apps: t.exposeInt("apps"),
      databases: t.exposeInt("databases"),
    }),
  });

const ClusterDeletionRef = builder
  .objectRef<ClusterDeletion>("ClusterDeletion")
  .implement({
    description:
      "What deleting a cluster does, for the confirmation: the active team's Apps and databases by name, every other team's as a count.",
    fields: (t) => ({
      failoverOn: t.exposeBoolean("failoverOn", {
        description:
          "True when the cluster fails work over today, so deleting it takes that away.",
      }),
      workloads: t.field({
        type: [ClusterReleasedWorkloadRef],
        resolve: (d) => d.workloads,
      }),
      otherTeams: t.field({
        type: [ClusterDeletionTeamRef],
        resolve: (d) => d.otherTeams,
      }),
    }),
  });

const ClusterJoinReasonCodeEnum = builder.enumType("ClusterJoinReasonCode", {
  values: [
    "offline",
    "agent_too_old",
    "in_cluster",
    "cannot_host",
    "other_teams",
  ] as const,
});

const ClusterJoinReasonRef = builder
  .objectRef<ClusterJoinReason>("ClusterJoinReason")
  .implement({
    description: "One thing that stops a server joining a cluster.",
    fields: (t) => ({
      code: t.field({
        type: ClusterJoinReasonCodeEnum,
        resolve: (r) => r.code,
      }),
      message: t.exposeString("message"),
    }),
  });

const ClusterJoinCandidateRef = builder
  .objectRef<ClusterJoinCandidate>("ClusterJoinCandidate")
  .implement({
    description:
      "A server the join picker offers; an empty `reasons` means it can join.",
    fields: (t) => ({
      serverId: t.exposeID("serverId"),
      serverName: t.exposeString("serverName"),
      reasons: t.field({
        type: [ClusterJoinReasonRef],
        resolve: (c) => c.reasons,
      }),
      apps: t.exposeInt("apps", {
        description: "The Apps on it now: they join the cluster with it.",
      }),
      databases: t.exposeInt("databases", {
        description: "The databases on it now: they join the cluster with it.",
      }),
    }),
  });

const ClusterJoinRef = builder.objectRef<ClusterJoin>("ClusterJoin").implement({
  fields: (t) => ({
    member: t.field({ type: ClusterMemberRef, resolve: (j) => j.member }),
    apps: t.exposeInt("apps", {
      description: "Apps that came along, where they run.",
    }),
    databases: t.exposeInt("databases"),
    note: t.exposeString("note", {
      nullable: true,
      description: "One plain line while the cluster has a single member.",
    }),
  }),
});

export const ClusterRef = builder.objectRef<Cluster>("Cluster").implement({
  description:
    "Several servers that act as one. A cluster is shared across teams like a server: `allTeams` or the teams in `teams`.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    allTeams: t.exposeBoolean("allTeams", {
      description:
        "True (the default) when every team may use this cluster. False restricts it to `teams`.",
    }),
    failoverEnabled: t.exposeBoolean("failoverEnabled", {
      description:
        "True (the default) when the cluster moves work off a server that stops. False keeps everything where it is.",
    }),
    leaderEpoch: t.exposeInt("leaderEpoch", {
      description:
        "The leader epoch Deplo last heard of; 0 before a leader has reported.",
    }),
    createdAt: t.exposeString("createdAt"),
    teams: t.field({
      type: [TeamRef],
      authScopes: { capability: "manage_team" },
      description:
        "Teams granted access when `allTeams` is false. Only an instance admin sees every team; anyone else sees the active team at most.",
      resolve: (c) => getClusterTeams(c.id),
    }),
    members: t.field({
      type: [ClusterMemberRef],
      authScopes: { loggedIn: true },
      description:
        "The servers in this cluster, in the order they joined. Anyone the cluster is shared with sees them.",
      resolve: (c) => listClusterMembers(c.id),
    }),
    imageCopies: t.field({
      type: [ClusterImageProgressRef],
      authScopes: { loggedIn: true },
      description:
        "The active team's Apps on this cluster whose newest release has not reached every server yet, so failover is not ready for them. Empty when every App is everywhere.",
      resolve: (c) => listClusterImageProgress(c.id),
    }),
    waiting: t.stringList({
      authScopes: { loggedIn: true },
      description:
        "The names of the active team's Apps on this cluster that found no room after a server stopped. They are tried again every 30 seconds; empty when everything runs.",
      resolve: (c) => listClusterWaiting(c.id),
    }),
    failoverOn: t.boolean({
      authScopes: { loggedIn: true },
      description:
        "Failover is on from two members while `failoverEnabled`: with one there is nowhere to move an App to.",
      resolve: async (c) =>
        failoverOn((await listClusterMembers(c.id)).length, c.failoverEnabled),
    }),
    joinCandidates: t.field({
      type: [ClusterJoinCandidateRef],
      authScopes: { instanceAdmin: true },
      description:
        "Every server, with what stops it joining this cluster right now. Requires instanceAdmin.",
      resolve: (c) => listClusterJoinCandidates(c.id),
    }),
    leader: t.field({
      type: ClusterLeaderRef,
      authScopes: { instanceAdmin: true },
      description:
        "Where the leader runs and whether it answers. Live, so select it on one cluster at a time. Requires instanceAdmin.",
      resolve: (c) => getClusterLeader(c.id),
    }),
    leaderChoices: t.field({
      type: [ClusterLeaderChoiceRef],
      authScopes: { instanceAdmin: true },
      description:
        "Every server the leader can run on, Deplo's own machine first. Requires instanceAdmin.",
      resolve: (c) => listClusterLeaderChoices(c.id),
    }),
  }),
});

const ClusterSharingInputType = builder.inputType("ClusterSharingInput", {
  description:
    "Which teams may use a cluster. allTeams: true opens it to every team; false restricts it to teamIds.",
  fields: (t) => ({
    allTeams: t.boolean({ required: true }),
    teamIds: t.stringList({ required: false }),
  }),
});

const PlacementKindEnum = builder.enumType("PlacementKind", {
  values: ["server", "cluster"] as const,
});

const PlacementChoiceRef = builder
  .objectRef<{
    kind: "server" | "cluster";
    id: string;
    name: string;
    isDeploHost: boolean;
  }>("PlacementChoice")
  .implement({
    description:
      "Somewhere an App can be placed: a server, or a cluster whose leader picks the server. A cluster's members are never listed here.",
    fields: (t) => ({
      kind: t.field({ type: PlacementKindEnum, resolve: (c) => c.kind }),
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      isDeploHost: t.exposeBoolean("isDeploHost"),
    }),
  });

builder.queryFields((t) => ({
  placementChoices: t.field({
    type: [PlacementChoiceRef],
    authScopes: { loggedIn: true },
    description:
      "The servers and clusters the active team may place an App on, servers first.",
    resolve: () => listPlacementChoices(),
  }),
  clusters: t.field({
    type: [ClusterRef],
    authScopes: { loggedIn: true },
    description: "The clusters the active team may use, by creation order.",
    resolve: () => listClusters(),
  }),
  cluster: t.field({
    type: ClusterRef,
    nullable: true,
    authScopes: { loggedIn: true },
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getCluster(id),
  }),
  clusterDeletion: t.field({
    type: ClusterDeletionRef,
    authScopes: { instanceAdmin: true },
    description:
      "What `deleteCluster` would do: which Apps and databases stop failing over. The active team's are named; another team's are counted. Requires instanceAdmin.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => getClusterDeletion(id),
  }),
}));

builder.mutationFields((t) => ({
  createCluster: t.field({
    type: ClusterRef,
    authScopes: { instanceAdmin: true },
    description:
      "Create a cluster and ask the machine that leads it to start its leader. A leader that cannot start does not undo the cluster: read `leader` for why.",
    args: {
      name: t.arg.string({ required: true }),
      sharing: t.arg({ type: ClusterSharingInputType, required: true }),
    },
    resolve: (_r, { name, sharing }) =>
      createCluster(name, {
        allTeams: sharing.allTeams,
        teamIds: sharing.teamIds ?? [],
      }),
  }),
  renameCluster: t.field({
    type: ClusterRef,
    authScopes: { instanceAdmin: true },
    args: {
      id: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: (_r, { id, name }) => renameCluster(id, name),
  }),
  setClusterFailover: t.field({
    type: ClusterRef,
    authScopes: { instanceAdmin: true },
    description:
      "Turn a cluster's failover on or off. Off, its leader holds nothing to restart elsewhere, so a server that stops keeps its Apps and databases until it comes back.",
    args: {
      id: t.arg.string({ required: true }),
      enabled: t.arg.boolean({ required: true }),
    },
    resolve: (_r, { id, enabled }) =>
      thenRefresh(id, setClusterFailover(id, enabled)),
  }),
  setClusterTeams: t.field({
    type: ClusterRef,
    authScopes: { instanceAdmin: true },
    description:
      "Change which teams may use a cluster, with the same rules as a server.",
    args: {
      id: t.arg.string({ required: true }),
      sharing: t.arg({ type: ClusterSharingInputType, required: true }),
    },
    resolve: (_r, { id, sharing }) =>
      setClusterTeams(id, {
        allTeams: sharing.allTeams,
        teamIds: sharing.teamIds ?? [],
      }),
  }),
  addClusterMember: t.field({
    type: ClusterJoinRef,
    authScopes: { instanceAdmin: true },
    description:
      "Add an existing server to a cluster. Its Apps and databases come along where they run: nothing restarts and no address changes. Refused with every blocking reason listed.",
    args: {
      clusterId: t.arg.string({ required: true }),
      serverId: t.arg.string({ required: true }),
    },
    resolve: (_r, { clusterId, serverId }) =>
      addClusterMember(clusterId, serverId),
  }),
  cancelClusterMemberRemoval: t.field({
    type: ClusterRef,
    authScopes: { instanceAdmin: true },
    description:
      "Cancel removing a server: it stays in the cluster and takes work again. What is moving right now finishes its move, and what already moved stays where it is.",
    args: {
      clusterId: t.arg.string({ required: true }),
      serverId: t.arg.string({ required: true }),
    },
    resolve: (_r, { clusterId, serverId }) =>
      cancelClusterMemberRemoval(clusterId, serverId),
  }),
  removeClusterMember: t.field({
    type: ClusterRef,
    authScopes: { instanceAdmin: true },
    description:
      "Remove a server from a cluster; it stays a server of this Deplo. Its Apps and databases first move to the other servers, one at a time in the background (read `members.emptying` for progress), and it leaves once nothing is left; refused before anything moves when the others lack the room. Call it again to continue a removal that stopped. With keepWorkloads it leaves at once and its Apps and databases stay on it as ordinary ones that no cluster moves; the last server must pass it.",
    args: {
      clusterId: t.arg.string({ required: true }),
      serverId: t.arg.string({ required: true }),
      keepWorkloads: t.arg.boolean({ required: false }),
    },
    resolve: (_r, { clusterId, serverId, keepWorkloads }) =>
      removeClusterMember(clusterId, serverId, {
        keepWorkloads: keepWorkloads === true,
      }),
  }),
  deleteCluster: t.field({
    type: "Boolean",
    authScopes: { instanceAdmin: true },
    description:
      "Delete a cluster. Every App and database stays on the server it runs on, as an ordinary one that nothing fails over; its servers stay connected. Read `clusterDeletion` first for what that covers. Refused while a server that still runs work does not answer.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteCluster(id);
      return true;
    },
  }),
  moveClusterLeader: t.field({
    type: ClusterRef,
    authScopes: { instanceAdmin: true },
    description:
      "Run the cluster's leader on another server, so failover keeps working while Deplo's own machine is down. That server installs the leader and leads from the next epoch; while it does not answer, Deplo's machine leads in its place. Pass the server of Deplo's own machine to move it back.",
    args: {
      id: t.arg.string({ required: true }),
      serverId: t.arg.string({ required: true }),
    },
    resolve: (_r, { id, serverId }) =>
      thenRefresh(id, moveClusterLeader(id, serverId)),
  }),
  startClusterLeader: t.field({
    type: ClusterLeaderRef,
    authScopes: { instanceAdmin: true },
    description:
      "Start the cluster's leader where it runs unless it already answers. Answers with the leader's state, never an error for a leader that could not start.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => thenRefresh(id, ensureClusterLeader(id)),
  }),
}));
