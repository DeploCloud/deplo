import { builder } from "../builder";
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
import {
  getCluster,
  getClusterTeams,
  listClusters,
} from "@/lib/data/clusters/roster";
import type { Cluster, ClusterLeader } from "@/lib/types/cluster";

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

builder.queryFields((t) => ({
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
  startClusterLeader: t.field({
    type: ClusterLeaderRef,
    authScopes: { instanceAdmin: true },
    description:
      "Start the cluster's leader where it runs unless it already answers. Answers with the leader's state, never an error for a leader that could not start.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => ensureClusterLeader(id),
  }),
}));
