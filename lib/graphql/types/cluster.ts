import { builder } from "../builder";
import { ServerStatusEnum } from "./server/server-ref";
import { TeamRef } from "./team";
import {
  createCluster,
  renameCluster,
  setClusterTeams,
} from "@/lib/data/clusters/manage";
import {
  ensureClusterLeader,
  getClusterLeader,
} from "@/lib/data/clusters/leader";
import { listClusterImageProgress } from "@/lib/data/clusters/images";
import {
  getCluster,
  getClusterTeams,
  listClusters,
} from "@/lib/data/clusters/roster";
import { listPlacementChoices } from "@/lib/data/clusters/choices";
import {
  addClusterMember,
  listClusterJoinCandidates,
  listClusterMembers,
} from "@/lib/data/clusters/members";
import {
  failoverOn,
  type Cluster,
  type ClusterImageProgress,
  type ClusterJoin,
  type ClusterJoinCandidate,
  type ClusterJoinReason,
  type ClusterLeader,
  type ClusterMember,
} from "@/lib/types/cluster";

const ClusterLeaderStateEnum = builder.enumType("ClusterLeaderState", {
  values: [
    "running",
    "stopped",
    "not_installed",
    "unreachable",
    "unavailable",
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
          "One plain sentence on why it is not running; empty when it is.",
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

const ClusterMemberRef = builder
  .objectRef<ClusterMember>("ClusterMember")
  .implement({
    description:
      "A server in a cluster. Nothing is ever placed on a member directly: the cluster decides.",
    fields: (t) => ({
      serverId: t.exposeID("serverId"),
      serverName: t.exposeString("serverName"),
      status: t.field({ type: ServerStatusEnum, resolve: (m) => m.status }),
      joinedAt: t.exposeString("joinedAt"),
      emptyingSince: t.exposeString("emptyingSince", {
        nullable: true,
        description: "Set while the member is being emptied.",
      }),
      leaseState: t.field({
        type: ClusterLeaseStateEnum,
        description:
          "What the cluster's leader last said: answering, not responding (15 seconds without an answer), or fenced (a minute: it has stopped its databases and Apps with files).",
        resolve: (m) => m.leaseState,
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
    failoverOn: t.boolean({
      authScopes: { loggedIn: true },
      description:
        "Failover is on from two members: with one there is nowhere to move an App to.",
      resolve: async (c) => failoverOn((await listClusterMembers(c.id)).length),
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
  startClusterLeader: t.field({
    type: ClusterLeaderRef,
    authScopes: { instanceAdmin: true },
    description:
      "Start the cluster's leader where it runs unless it already answers. Answers with the leader's state, never an error for a leader that could not start.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => ensureClusterLeader(id),
  }),
}));
