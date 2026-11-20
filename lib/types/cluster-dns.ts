import type { DelegationRecord } from "../deploy/cluster-zone";

// A cluster's own DNS zone (ADR-0049), as the cluster's settings show it.

export type ClusterZoneServerState = {
  serverId: string;
  serverName: string;
  serving: boolean;
  problem: string;
  state: string;
  heard: number;
  checkedAt: string;
};

export type ClusterDnsZoneView = {
  id: string;
  name: string;
  records: DelegationRecord[];
  /** The domains it answers, as each one's name in the zone. */
  names: string[];
};

export type ClusterDnsView = {
  zones: ClusterDnsZoneView[];
  nameServers: { position: number; serverId: string; serverName: string }[];
  servers: ClusterZoneServerState[];
  answerTtl: number;
  dropAfter: number;
};

export type DelegationCheck = {
  /** The parent zone names exactly the cluster's name servers, with their addresses, and no DS record. */
  delegated: boolean;
  parent: string | null;
  /** What to fix, in the person's words: one record each. */
  problems: string[];
  nameServers: { name: string; address: string; answers: boolean }[];
};
