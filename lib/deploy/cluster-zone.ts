import { createHash } from "node:crypto";

import type {
  ClusterZoneCertificate,
  ClusterZoneChallenge,
  SetClusterZoneRequest,
} from "../agent/gen/agent";
import { zoneCovers } from "../dns-zone";

// A cluster's own DNS zone (ADR-0049): https://deplo.build/docs/operations/clusters/dns-zone

export const DNS_TTL = { default: 30, min: 10, max: 300 } as const;
export const DNS_DROP_AFTER = { default: 10, min: 5, max: 60 } as const;
export const MAX_NAME_SERVERS = 4;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** A zone or domain name as typed, made canonical (lower case, no trailing dot), or why it is not one. */
export function cleanZoneName(
  raw: string,
): { name: string; error?: undefined } | { name?: undefined; error: string } {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  const labels = name.split(".");
  if (
    name.length === 0 ||
    name.length > 253 ||
    labels.length < 2 ||
    !labels.every((l) => LABEL.test(l)) ||
    /^[0-9]+$/.test(labels[labels.length - 1])
  )
    return {
      error: `${raw.trim() || "That"} is not a domain. Type one you own, such as go.example.com.`,
    };
  return { name };
}

/** The name in the zone a domain answers as: itself when it is in the zone, else one its CNAME points at. */
export function zoneTarget(domain: string, zone: string): string {
  if (zoneCovers(zone, domain)) return domain;
  const room = Math.min(63, 253 - zone.length - 1);
  let label = domain.replace(/\./g, "-");
  if (label.length > room) {
    const tag = createHash("sha256").update(domain).digest("hex").slice(0, 8);
    label = `${label.slice(0, room - 9).replace(/-+$/, "")}-${tag}`;
  }
  return `${label}.${zone}`;
}

export type NameServerChoice = { position: number; serverId: string };

export type NameServerCandidate = {
  serverId: string;
  joinedAt: string;
  /** In the cluster, able to answer on port 53, and not being emptied. */
  eligible: boolean;
  /** Still a member: a chosen server keeps its place while it is, whatever else it reports. */
  member: boolean;
};

/**
 * ns1 to ns4. A chosen server keeps its place while it is a member and has not said it cannot answer, so the records
 * at the registrar stay right; an empty place takes the eligible server that joined longest ago.
 */
export function chooseNameServers(
  current: NameServerChoice[],
  candidates: NameServerCandidate[],
): NameServerChoice[] {
  const byId = new Map(candidates.map((c) => [c.serverId, c]));
  const kept = current.filter((c) => {
    const s = byId.get(c.serverId);
    return s?.member === true && s.eligible;
  });
  const taken = new Set(kept.map((c) => c.serverId));
  const free = candidates
    .filter((c) => c.eligible && !taken.has(c.serverId))
    .sort(
      (a, b) =>
        a.joinedAt.localeCompare(b.joinedAt) ||
        a.serverId.localeCompare(b.serverId),
    );
  const out = [...kept];
  for (let position = 1; position <= MAX_NAME_SERVERS; position++) {
    if (out.some((c) => c.position === position)) continue;
    const next = free.shift();
    if (!next) break;
    out.push({ position, serverId: next.serverId });
  }
  // A place no server can fill closes up, so the names stay ns1, ns2, ... with no gap.
  return out
    .sort((a, b) => a.position - b.position)
    .map((c, i) => ({ position: i + 1, serverId: c.serverId }));
}

export type ZoneServer = {
  fingerprint: string;
  v4: string[];
  v6: string[];
  emptying: boolean;
  /** Where it is (phase 2): a visitor is answered with the servers nearest it; null when Deplo cannot say. */
  place?: { lat: number; lon: number } | null;
};

export type ClusterZoneInput = {
  clusterId: string;
  /** The certificate of the server the request is for. */
  self: string;
  zones: { name: string; names: string[] }[];
  servers: ZoneServer[];
  /** ns1, ns2, ... by certificate. */
  nameServers: string[];
  ttl: number;
  dropAfter: number;
  /** The certificate checks answered from the zone, and this server's part in each zone's own certificate. */
  challenges?: ClusterZoneChallenge[];
  certificates?: ClusterZoneCertificate[];
};

/** What one server agent is handed: the same for every member but `selfFingerprint`. */
export function renderClusterZone(
  input: ClusterZoneInput,
): SetClusterZoneRequest {
  return {
    clusterId: input.clusterId,
    selfFingerprint: input.self,
    zones: [...input.zones]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((z) => ({ name: z.name, names: [...new Set(z.names)].sort() })),
    servers: input.servers.map((s) => ({
      fingerprint: s.fingerprint,
      addresses: [...s.v4, ...s.v6].slice(0, 8),
      emptying: s.emptying,
      located: s.place != null,
      latitude: s.place ? round2(s.place.lat) : 0,
      longitude: s.place ? round2(s.place.lon) : 0,
    })),
    nameServers: input.nameServers,
    answerTtlSeconds: input.ttl,
    dropAfterSeconds: input.dropAfter,
    challenges: input.challenges ?? [],
    certificates: input.certificates ?? [],
  };
}

export type DelegationRecord = {
  name: string;
  type: "NS" | "A" | "AAAA";
  value: string;
};

/** The records to add where the domain was bought: the zone's NS, then each name server's addresses (the glue). */
export function delegationRecords(
  zone: string,
  nameServers: { v4: string[]; v6: string[] }[],
): DelegationRecord[] {
  const out: DelegationRecord[] = [];
  nameServers.forEach((_, i) =>
    out.push({ name: zone, type: "NS", value: `ns${i + 1}.${zone}` }),
  );
  nameServers.forEach((ns, i) => {
    for (const a of ns.v4)
      out.push({ name: `ns${i + 1}.${zone}`, type: "A", value: a });
    for (const a of ns.v6)
      out.push({ name: `ns${i + 1}.${zone}`, type: "AAAA", value: a });
  });
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Whether coordinates typed for a server are a place on the globe, and why not. */
export function placeRefusal(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90)
    return "A latitude is between -90 and 90.";
  if (!Number.isFinite(lon) || lon < -180 || lon > 180)
    return "A longitude is between -180 and 180.";
  return null;
}

/** Whether a time a person typed is one the agent takes, and why not. */
export function dnsTimesRefusal(ttl: number, dropAfter: number): string | null {
  if (!Number.isInteger(ttl) || ttl < DNS_TTL.min || ttl > DNS_TTL.max)
    return `Answers last ${DNS_TTL.min} to ${DNS_TTL.max} seconds.`;
  if (
    !Number.isInteger(dropAfter) ||
    dropAfter < DNS_DROP_AFTER.min ||
    dropAfter > DNS_DROP_AFTER.max
  )
    return `A stopped server leaves the answers after ${DNS_DROP_AFTER.min} to ${DNS_DROP_AFTER.max} seconds.`;
  return null;
}
