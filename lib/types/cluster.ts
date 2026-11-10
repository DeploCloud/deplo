import type { ID } from "./identity";

export interface Cluster {
  id: ID;
  name: string;
  allTeams: boolean;
  /** The server the leader runs on; null is Deplo's own machine. */
  leaderServerId: ID | null;
  leaderEpoch: number;
  createdAt: string;
}

export type ClusterLeaderState =
  "running" | "stopped" | "not_installed" | "unreachable" | "unavailable";

/** Where a cluster's leader runs and whether it answers, read live from the agent that supervises it. */
export interface ClusterLeader {
  serverId: ID | null;
  serverName: string;
  onDeploHost: boolean;
  state: ClusterLeaderState;
  version: string;
  /** One plain sentence when the leader is not running; empty otherwise. */
  message: string;
}
