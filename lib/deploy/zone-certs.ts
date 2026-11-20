import type {
  ClusterZoneCertificate,
  ClusterZoneChallenge,
} from "../agent/gen/agent";
import { zoneTarget } from "./cluster-zone";
import {
  certChallengeOf,
  challengeName,
  type CertChallenge,
} from "./dns-challenge";

// A zone's own certificate and the checks answered from it (ADR-0049 phase 3):
// https://deplo.build/docs/operations/clusters/dns-zone

/** How long the renewing server may stay unreachable before another takes the renewal over. */
export const RENEWER_LOST_AFTER_MS = 10 * 60_000;

export type ZoneCertMember = {
  serverId: string;
  fingerprint: string;
  joinedAt: string;
  emptying: boolean;
  /** Its agent sets certificate checks and its proxy has the resolver that asks for them. */
  capable: boolean;
  /** It answered the last time Deplo handed it the zone. */
  reachable: boolean;
};

export type ZoneCertDomain = {
  id: string;
  name: string;
  zoneId: string;
  zone: string;
  /** In the zone, rather than pointed into it by a CNAME. */
  inside: boolean;
  /** Its `_acme-challenge` CNAME into the zone was seen. */
  cnameSeen: boolean;
  /** The server its App runs on, whose proxy orders a certificate of the name's own. */
  serverId: string | null;
};

export type ZoneCertState = {
  renewerServerId: string | null;
  renewerLostAt: string | null;
  sha256: string | null;
  notAfter: string | null;
};

/** How each domain's certificate is checked, given the cluster's switch and whether its servers can check over DNS. */
export function domainModes(
  domains: ZoneCertDomain[],
  opts: { wildcard: boolean; eligible: boolean },
): Map<string, CertChallenge> {
  return new Map(
    domains.map((d) => [
      d.id,
      certChallengeOf(
        {
          name: d.name,
          zone: d.zone,
          inside: d.inside,
          cnameSeen: d.cnameSeen,
        },
        opts,
      ),
    ]),
  );
}

/** Whether every server Deplo can reach can take checks over DNS, so a name keeps its way wherever its App runs. */
export function clusterCanCheckOverDns(members: ZoneCertMember[]): boolean {
  const heard = members.filter((m) => m.reachable);
  return heard.length > 0 && heard.every((m) => m.capable);
}

const canRenew = (m: ZoneCertMember) => m.capable && m.reachable && !m.emptying;

/**
 * The server that renews a zone's certificate: the same one while it is a member, unless it has been unreachable for
 * RENEWER_LOST_AFTER_MS or is being emptied; then the one that joined longest ago of those that can.
 */
export function chooseRenewer(
  state: Pick<ZoneCertState, "renewerServerId" | "renewerLostAt"> | null,
  members: ZoneCertMember[],
  now: number,
): { serverId: string | null; lostAt: string | null } {
  const current = members.find((m) => m.serverId === state?.renewerServerId);
  if (current && current.capable && !current.emptying) {
    if (current.reachable) return { serverId: current.serverId, lostAt: null };
    const lostAt = state?.renewerLostAt ?? new Date(now).toISOString();
    if (now - Date.parse(lostAt) < RENEWER_LOST_AFTER_MS)
      return { serverId: current.serverId, lostAt };
  }
  const next = members
    .filter((m) => m !== current && canRenew(m))
    .sort(
      (a, b) =>
        a.joinedAt.localeCompare(b.joinedAt) ||
        a.serverId.localeCompare(b.serverId),
    )[0];
  if (next) return { serverId: next.serverId, lostAt: null };
  // Nobody can take it: the one there keeps it, so nothing is ordered twice.
  return current
    ? {
        serverId: current.serverId,
        lostAt: state?.renewerLostAt ?? new Date(now).toISOString(),
      }
    : { serverId: null, lostAt: null };
}

export type ZonePlanZone = {
  id: string;
  name: string;
  renewerServerId: string | null;
  sha256: string | null;
  notAfter: string | null;
  /** The pair Deplo holds, handed to a server that does not hold it yet. */
  pair: { certPem: string; keyPem: string } | null;
};

/** A zone's certificate is needed once a name in it is served by it, never for an empty zone. */
export function zonesNeedingCert(
  domains: ZoneCertDomain[],
  modes: Map<string, CertChallenge>,
): Set<string> {
  return new Set(
    domains.filter((d) => modes.get(d.id) === "zone").map((d) => d.zoneId),
  );
}

/** The checks every member is told of: who may set each, and where in the zone it is answered. */
export function zoneChallenges(input: {
  zones: ZonePlanZone[];
  domains: ZoneCertDomain[];
  modes: Map<string, CertChallenge>;
  fingerprintOf: (serverId: string) => string | null;
}): ClusterZoneChallenge[] {
  const out = new Map<string, ClusterZoneChallenge>();
  const need = zonesNeedingCert(input.domains, input.modes);
  for (const z of input.zones) {
    const owner = z.renewerServerId && input.fingerprintOf(z.renewerServerId);
    if (!need.has(z.id) || !owner) continue;
    const name = challengeName(z.name);
    out.set(name, { asked: name, at: name, ownerFingerprint: owner });
  }
  for (const d of input.domains) {
    if (input.modes.get(d.id) !== "dns") continue;
    const owner = d.serverId && input.fingerprintOf(d.serverId);
    const asked = challengeName(d.name);
    if (!owner || out.has(asked)) continue;
    out.set(asked, {
      asked,
      at: challengeName(zoneTarget(d.name, d.zone)),
      ownerFingerprint: owner,
    });
  }
  return [...out.values()].sort((a, b) => a.asked.localeCompare(b.asked));
}

/**
 * What one member is told of each zone's certificate: whether it renews it, the digest Deplo holds, the pair when the
 * member last said it holds another, and the names it serves once it is valid.
 */
export function zoneCertificatesFor(input: {
  serverId: string;
  zones: ZonePlanZone[];
  domains: ZoneCertDomain[];
  modes: Map<string, CertChallenge>;
  /** The digest the member last said it holds, by zone; absent when Deplo has not heard. */
  reported: (zone: string) => string | undefined;
  now: number;
}): ClusterZoneCertificate[] {
  const need = zonesNeedingCert(input.domains, input.modes);
  return input.zones
    .filter((z) => need.has(z.id))
    .map((z) => {
      const valid = !!z.notAfter && Date.parse(z.notAfter) > input.now;
      const send =
        valid && z.pair && z.sha256 && input.reported(z.name) !== z.sha256;
      return {
        zone: z.name,
        renew: z.renewerServerId === input.serverId,
        order: z.renewerServerId === input.serverId,
        sha256: valid ? (z.sha256 ?? "") : "",
        certPem: send ? z.pair!.certPem : "",
        keyPem: send ? z.pair!.keyPem : "",
        covered: valid
          ? [
              ...new Set(
                input.domains
                  .filter(
                    (d) =>
                      d.zoneId === z.id && input.modes.get(d.id) === "zone",
                  )
                  .map((d) => d.name),
              ),
            ].sort()
          : [],
      };
    });
}

/** Members in the order to hand them the zone: the renewers last, so a pair one just renewed reaches the rest next. */
export function renewersLast<M extends { serverId: string }>(
  members: M[],
  zones: ZonePlanZone[],
): M[] {
  const renewers = new Set(zones.map((z) => z.renewerServerId));
  return [
    ...members.filter((m) => !renewers.has(m.serverId)),
    ...members.filter((m) => renewers.has(m.serverId)),
  ];
}

/** A failed order, said in the words of someone who never ordered a certificate. */
export function zoneCertErrorWords(raw: string): string {
  const e = raw.toLowerCase();
  if (e.includes("ratelimited") || e.includes("too many"))
    return "The certificate authority issued too many certificates for this zone lately. Deplo asks again later.";
  if (e.includes("caa"))
    return "A CAA record of the domain does not let this certificate authority issue it.";
  if (
    e.includes("nxdomain") ||
    e.includes("servfail") ||
    e.includes(":dns ::") ||
    e.includes("no such host")
  )
    return "The certificate authority could not look the zone up. Check that the records above are added where the domain was bought.";
  if (e.includes("unauthorized") || e.includes("incorrect txt"))
    return "The certificate authority read a different check than the one the cluster set. Deplo asks again shortly.";
  if (
    e.includes("timeout") ||
    e.includes("deadline") ||
    e.includes("connection refused") ||
    e.includes("connection reset")
  )
    return "The server renewing it could not reach the certificate authority. Deplo asks again shortly.";
  return "The certificate authority refused the certificate. Deplo asks again shortly.";
}
