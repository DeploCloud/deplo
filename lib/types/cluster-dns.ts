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

/** A zone's own certificate (ADR-0049 phase 3), as the cluster's settings show it. */
export type ZoneCertificateView = {
  /** The names on it: the zone and every name one label below. */
  names: string[];
  /** The domains it serves now. */
  serves: string[];
  validUntil: string | null;
  /** It has not expired. */
  valid: boolean;
  issuedAt: string | null;
  renewedAt: string | null;
  /** The one server that orders and renews it. */
  renewer: { serverId: string; serverName: string } | null;
  ordering: boolean;
  /** The last failed order in plain words, and as the certificate authority said it. */
  error: string;
  errorDetail: string;
  errorAt: string | null;
};

export type ClusterDnsZoneView = {
  id: string;
  name: string;
  records: DelegationRecord[];
  /** The domains it answers, as each one's name in the zone. */
  names: string[];
  /** The domain connected for automatic DNS where Deplo keeps its NS and glue, in Cloudflare; null when typed by hand. */
  keptIn: string | null;
  certificate: ZoneCertificateView;
};

export type ClusterDnsView = {
  zones: ClusterDnsZoneView[];
  nameServers: { position: number; serverId: string; serverName: string }[];
  servers: ClusterZoneServerState[];
  places: ClusterServerPlace[];
  geo: ClusterGeoTable;
  answerTtl: number;
  dropAfter: number;
  /** One certificate per zone for every name one label below it; off, each name gets its own. */
  wildcard: boolean;
};

export type DelegationCheck = {
  /** The parent zone names exactly the cluster's name servers, with their addresses, and no DS record. */
  delegated: boolean;
  parent: string | null;
  /** What to fix, in the person's words: one record each. */
  problems: string[];
  nameServers: { name: string; address: string; answers: boolean }[];
};
