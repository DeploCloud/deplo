/**
 * Cloudflare-awareness for the domain DNS check.
 *
 * A domain proxied through Cloudflare's "orange-cloud" no longer resolves (via
 * its public A records) to the origin server's IP — it resolves to one of
 * Cloudflare's shared anycast addresses, so a bare "does an A record equal this
 * server's IP?" check reads a perfectly-configured proxied domain as
 * misconfigured. This module supplies the two pure primitives the check needs to
 * tell those apart: membership in Cloudflare's published IP ranges, and the
 * three-way classification of a resolved A-record set.
 *
 * Pure and dependency-free (no `node:dns`, no `server-only`) so the DNS-resolving
 * caller stays the only I/O boundary and the classification is unit-testable
 * without a network.
 */

/**
 * Cloudflare's published proxy **IPv4** ranges — the anycast addresses a domain
 * resolves to while proxied through Cloudflare. Mirrors
 * https://www.cloudflare.com/ips-v4/ (JSON at https://api.cloudflare.com/client/v4/ips).
 *
 * Hard-coded rather than fetched at runtime: the set is small, has been stable
 * for years, and Cloudflare commits to announcing any change well in advance —
 * so baking it in keeps the DNS check deterministic and free of an outbound
 * dependency on every verify. If Cloudflare ever adds a range, update this list.
 */
export const CLOUDFLARE_IPV4_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
] as const;

/**
 * Cloudflare's published proxy **IPv6** ranges. Mirrors
 * https://www.cloudflare.com/ips-v6/. The domain check resolves IPv4 (A records)
 * today, so these are only exercised when {@link isCloudflareIp} is handed an
 * IPv6 literal, but they keep the membership test complete for future AAAA use.
 */
export const CLOUDFLARE_IPV6_RANGES = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

/** Parse a dotted-quad into an unsigned 32-bit int, or null if it is not a
 * syntactically valid IPv4 (each octet a plain 0–255 integer). */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0; // force unsigned
}

/** True iff the 32-bit `ipInt` falls inside the `a.b.c.d/bits` CIDR. */
function inV4Cidr(ipInt: number, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const baseInt = ipv4ToInt(cidr.slice(0, slash));
  const bits = Number(cidr.slice(slash + 1));
  if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  // A /bits mask, unsigned. (bits is 13–22 for every Cloudflare range, never 0.)
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

/** Expand an IPv6 literal (including `::` compression) to a 128-bit BigInt, or
 * null if it is not a parseable IPv6 address. IPv4-mapped tails are not needed
 * for Cloudflare's ranges, so they are treated as invalid. */
function ipv6ToBigInt(ip: string): bigint | null {
  const raw = ip.trim();
  if (!raw.includes(":")) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null; // more than one "::" is illegal
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups =
    halves.length === 2
      ? [...head, ...Array(missing).fill("0"), ...tail]
      : head;
  // BigInt(...) constructor calls, not `0n`/`16n` literals: the literal syntax
  // needs target ES2020 but this project targets ES2017 (the `bigint` type
  // itself is available via the `esnext` lib).
  let n = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** True iff the 128-bit `ipInt` falls inside the `prefix/bits` IPv6 CIDR. */
function inV6Cidr(ipInt: bigint, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const baseInt = ipv6ToBigInt(cidr.slice(0, slash));
  const bits = Number(cidr.slice(slash + 1));
  if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 128) {
    return false;
  }
  if (bits === 0) return true;
  const mask = ((BigInt(1) << BigInt(bits)) - BigInt(1)) << BigInt(128 - bits);
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * True iff `ip` (an IPv4 dotted-quad or IPv6 literal) belongs to one of
 * Cloudflare's published proxy ranges — i.e. the address is a Cloudflare edge,
 * so a domain resolving to it is sitting behind the orange-cloud proxy rather
 * than pointing straight at an origin. A malformed / unparseable address is not
 * a Cloudflare IP (returns false).
 */
export function isCloudflareIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ipv6ToBigInt(ip);
    return v6 !== null && CLOUDFLARE_IPV6_RANGES.some((c) => inV6Cidr(v6, c));
  }
  const v4 = ipv4ToInt(ip);
  return v4 !== null && CLOUDFLARE_IPV4_RANGES.some((c) => inV4Cidr(v4, c));
}

/** The three outcomes of classifying a domain's resolved A records against the
 * server it should point at. A subset of `DomainStatus` (the settled states a
 * verify can produce — `pending`/`error` are lifecycle states set elsewhere). */
export type DomainDnsClass = "valid" | "cloudflare" | "misconfigured";

/**
 * Classify a domain's resolved A records against the `target` server IP it must
 * point at — the CORE of the DNS check, kept pure so it is exhaustively testable
 * without a live resolver:
 *
 *   - `valid`         an A record points straight at this server. Traefik gets
 *                     the request directly and issues its own certificate. (The
 *                     long-standing check — unchanged for direct/grey-cloud DNS.)
 *   - `cloudflare`    no record points here, but every/any resolved address is a
 *                     Cloudflare edge IP: the domain is proxied through
 *                     Cloudflare, which INTENTIONALLY hides the origin behind its
 *                     anycast IPs. That is a correct, working setup — not the
 *                     false "misconfigured" a bare server-IP match would report.
 *   - `misconfigured` no record points here and none is a Cloudflare edge: the
 *                     domain resolves nowhere useful (NXDOMAIN / empty ⇒ `[]`) or
 *                     to some unrelated address, so it genuinely isn't set up.
 *
 * A direct hit wins over the Cloudflare check: if the server's own IP is among
 * the records the domain is reachable directly regardless of any other record.
 */
export function classifyDomainDns(
  resolvedIps: string[],
  target: string,
): DomainDnsClass {
  if (resolvedIps.includes(target)) return "valid";
  if (resolvedIps.some(isCloudflareIp)) return "cloudflare";
  return "misconfigured";
}
