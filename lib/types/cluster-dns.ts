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
  /** It holds the release's location table and every server has a place: visitors get the nearest servers. */
  nearest: boolean;
};

/** Where a server is (ADR-0049 phase 2). */
export type ClusterServerPlace = {
  serverId: string;
  serverName: string;
  place: {
    latitude: number;
    longitude: number;
    label: string;
    source: "city" | "coordinates" | "address";
  } | null;
};

/** The location table this release carries, as the cluster's DNS settings show it. */
export type ClusterGeoTable = {
  state: "ready" | "missing" | "damaged";
  /** DB-IP's release, "2026-11". */
  release: string | null;
  /** Older than three months. */
  stale: boolean;
  /** The release whose copy this one reuses, when DB-IP's download failed at release time. */
  reusedFrom: string | null;
  problem: string;
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
  places: ClusterServerPlace[];
  geo: ClusterGeoTable;
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
