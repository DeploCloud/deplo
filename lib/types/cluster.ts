import type { ID } from "./identity";
import type { ServerStatus } from "./server";

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

/** Failover needs somewhere to move an App to, so it starts at two members. */
export const FAILOVER_MIN_MEMBERS = 2;

export function failoverOn(memberCount: number): boolean {
  return memberCount >= FAILOVER_MIN_MEMBERS;
}

export interface ClusterMember {
  serverId: ID;
  serverName: string;
  status: ServerStatus;
  joinedAt: string;
  /** Set while the member is being emptied. */
  emptyingSince: string | null;
}

export type ClusterJoinReasonCode =
  "offline" | "agent_too_old" | "in_cluster" | "cannot_host" | "other_teams";

/** One thing that stops a server joining a cluster, in words the admin can act on. */
export interface ClusterJoinReason {
  code: ClusterJoinReasonCode;
  message: string;
}

/** A server the join picker offers, with what blocks it right now (empty: it can join). */
export interface ClusterJoinCandidate {
  serverId: ID;
  serverName: string;
  reasons: ClusterJoinReason[];
}

export interface ClusterJoin {
  member: ClusterMember;
  /** Apps and databases that came along, where they run. */
  apps: number;
  databases: number;
  /** One plain line when the cluster still has a single member. */
  note: string | null;
}

/** An App whose newest release is still being copied: "web: on 2 of 3 servers". */
export interface ClusterImageProgress {
  appId: ID;
  appName: string;
  held: number;
  total: number;
}
