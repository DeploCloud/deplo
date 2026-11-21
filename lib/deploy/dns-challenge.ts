// Certificate checks over DNS answered by a cluster's own zone (ADR-0049 phase 3):
// https://deplo.build/docs/operations/clusters/dns-zone

/** The proxy's certificate resolver whose checks go through its own server agent, over DNS. */
export const DNS_CHALLENGE_RESOLVER = "deplo-dns";
/** Where that agent listens, on the proxy's own loopback, and the secret only the proxy reads. */
export const CHALLENGE_PORT = 8444;
export const CHALLENGE_SECRET_FILE = "dns-challenge.secret";
export const CHALLENGE_LABEL = "_acme-challenge";

/**
 * How a domain's certificate is checked: by the zone's own certificate, its own over DNS renewed by one server and
 * held by every other (`shared`, #228), its own over DNS on its App's server (`dns`), or HTTP-01 as before.
 */
export type CertChallenge = "zone" | "shared" | "dns" | "http";

export const challengeName = (name: string) => `${CHALLENGE_LABEL}.${name}`;

/** Whether the zone's own certificate serves a name: the zone itself, or a name one label below it. */
export function zoneCertCovers(zone: string, name: string): boolean {
  if (name === zone) return true;
  if (!name.endsWith(`.${zone}`)) return false;
  const label = name.slice(0, -zone.length - 1);
  return label.length > 0 && !label.includes(".");
}

/** The zone's own certificate: the zone and every name one label below it. */
export const zoneCertNames = (zone: string) => [zone, `*.${zone}`];

/**
 * A name inside the zone is served by the zone's certificate (wildcard on) or gets its own over DNS; one outside it
 * gets its own over DNS once its `_acme-challenge` CNAME points into the zone, and keeps HTTP-01 otherwise.
 */
export function certChallengeOf(
  d: { name: string; zone: string | null; inside: boolean; cnameSeen: boolean },
  opts: { wildcard: boolean; eligible: boolean; shared?: boolean },
): CertChallenge {
  if (!d.zone || !opts.eligible) return "http";
  const own = opts.shared ? "shared" : "dns";
  if (d.inside)
    return opts.wildcard && zoneCertCovers(d.zone, d.name) ? "zone" : own;
  return d.cnameSeen ? own : "http";
}
