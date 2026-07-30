/**
 * Cloudflare-awareness for the domain DNS check.
 *
 * A domain proxied through Cloudflare's "orange-cloud" no longer resolves (via
 * its public A records) to the origin server's IP — it resolves to one of
 * Cloudflare's shared anycast addresses, so a bare "does an A record equal this
 * server's IP?" check reads every proxied domain as misconfigured, the
 * correctly-configured ones included. This module supplies the two pure
 * primitives the check needs to tell those apart: membership in Cloudflare's
 * published IP ranges, and the three-way classification of a resolved A-record
 * set.
 *
 * What this CANNOT do is a property of DNS, not a gap to be filled later: those
 * anycast addresses are IDENTICAL for every proxied domain on the internet, so
 * public DNS can prove a domain is proxied and NOTHING about where Cloudflare
 * forwards it afterwards — that origin lives in the zone's private
 * configuration. `cloudflare` therefore means "plausible but unverified", never
 * "confirmed": the domain may just as well be forwarded to somebody else's
 * server. Proving the rest needs a reachability probe (fetch the host and look
 * for a per-server fingerprint), which is a separate feature; until it exists,
 * every layer above must present this status as an open question — see
 * {@link classifyDomainDns}.
 *
 * Pure and dependency-free (no `node:dns`, no `server-only`) so the DNS-resolving
 * caller stays the only I/O boundary and the classification is unit-testable
 * without a network. (The two imports below are TYPE-only — erased at compile,
 * so nothing runtime comes with them.)
 */

import type { CertProvider, DomainStatus } from "../types";

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
 *   - `cloudflare`    no record points here, but a resolved address is a
 *                     Cloudflare edge IP: the domain is proxied through
 *                     Cloudflare, which INTENTIONALLY hides the origin behind its
 *                     anycast IPs. UNVERIFIED — deliberately its own status
 *                     rather than either neighbour: the DNS is delegated exactly
 *                     as a working proxied setup looks, so calling it
 *                     "misconfigured" would flash red at users who did
 *                     everything right; but the anycast IPs are the same for
 *                     every proxied domain alive, so nothing here shows that
 *                     Cloudflare forwards to THIS server, and calling it `valid`
 *                     would claim a fact we cannot see. It exists to stop a
 *                     correct setup reading as broken — not to certify a
 *                     possibly-wrong one as working.
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

/**
 * The certificate provider a domain carries once a DNS check has settled its
 * status — the ONE place the "proxied ⇒ Cloudflare issues the certificate" rule
 * lives, so adding, verifying and renaming a domain all reach the same answer.
 *
 * A domain behind the orange-cloud is served to the public BY Cloudflare, which
 * terminates TLS at its edge and presents its own certificate: the visitor gets
 * HTTPS whatever the origin does. Leaving such a domain on `none` — the
 * born-with default — therefore produced a row that contradicted itself: an
 * "HTTP" badge and an `http://` link for a site every browser loads over HTTPS,
 * and a router parked on `web` (:80) even though the row's own advice (and
 * Cloudflare's) is SSL/TLS **Full**, which dials the origin on :443. Selecting
 * `cloudflare` settles both at once — the router moves to `websecure` and every
 * URL deplo prints says `https` — with no trip into Advanced settings.
 *
 * Deliberately ONE-WAY, and only out of `none`:
 *   - `letsencrypt` is never touched. That is an explicit request for the origin
 *     to hold its own certificate, which stays a legitimate choice behind a proxy.
 *   - a domain that STOPS being proxied KEEPS `cloudflare`, because that provider
 *     is equally the expert choice for a grey-clouded domain (DNS-01 through
 *     Cloudflare's API); flipping it back to `none` would silently strip TLS from
 *     a working origin. The user changes it from the Edit dialog like any other
 *     setting — this rule only ever picks the first value, never overrules one.
 *
 * An ABSENT provider (a row written before the field existed, which the deploy
 * edge reads as `letsencrypt`) is likewise left alone.
 */
export function certProviderForDns<T extends CertProvider | undefined>(
  status: DomainStatus,
  current: T,
): T | "cloudflare" {
  return status === "cloudflare" && current === "none" ? "cloudflare" : current;
}

/**
 * Second-level public suffixes — the ccTLDs where the registrable domain is the
 * LAST THREE labels (`example.co.uk`), not the last two. Deliberately a short,
 * common-case list rather than a vendored Public Suffix List: the only consumer
 * is {@link cloudflareDnsRecordsUrl}, whose worst case when the guess is wrong
 * is that Cloudflare opens its own zone picker instead of the right zone — a
 * click, not a breakage. Not worth a megabyte of suffix data shipped to the
 * browser on every domains page.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // uk
  "co.uk", "org.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk", "sch.uk", "ac.uk", "gov.uk",
  // au / nz
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "ac.nz", "govt.nz",
  // asia
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "co.kr", "ne.kr", "or.kr",
  "com.cn", "net.cn", "org.cn", "com.hk", "org.hk", "com.tw",
  "co.in", "net.in", "org.in", "co.id", "com.my", "com.sg", "com.ph", "com.vn", "com.pk",
  // americas
  "com.br", "net.br", "org.br", "com.ar", "com.mx", "org.mx", "com.co", "com.pe",
  // emea
  "co.za", "org.za", "net.za", "com.tr", "net.tr", "org.tr", "com.ua",
  "com.es", "org.es", "nom.es", "com.pl", "net.pl", "org.pl",
  "co.il", "org.il", "net.il", "ac.il", "com.sa", "com.eg", "com.ng",
]);

/**
 * The Cloudflare ZONE a host lives in — its registrable domain
 * (`api.staging.example.co.uk` → `example.co.uk`), or null when the host is not
 * a plausible hostname or is too short to have a zone (a bare `localhost`).
 * A leading `*.` (wildcard host) and a trailing root dot are stripped first.
 */
export function cloudflareZoneName(host: string): string | null {
  const clean = host
    .trim()
    .toLowerCase()
    .replace(/^\*\./, "")
    .replace(/\.$/, "");
  // Anything that isn't a plain LDH hostname (no scheme, path, port, spaces,
  // unicode) gets no guess — the caller falls back to Cloudflare's picker.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(clean)) {
    return null;
  }
  const labels = clean.split(".");
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length > 2 && MULTI_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/**
 * A deep link straight to the **DNS records** screen of the Cloudflare zone that
 * owns `host` — where the user edits the proxied record's origin IP. This is the
 * one part of "point Cloudflare at this server" deplo can do for them without
 * holding a Cloudflare API token: the origin lives in the zone's private
 * configuration (see the module header), so deplo cannot read it, let alone
 * write it — but it CAN land the user on the exact screen with the exact zone
 * already selected, instead of "go find it in your Cloudflare account".
 *
 * Uses Cloudflare's documented magic-link form — `?to=` with `:account` /
 * `:zone` placeholders the dashboard resolves after login
 * (https://blog.cloudflare.com/deeplinks-and-scrollanchor). `:zone` takes a zone
 * NAME, so the guessed zone drops straight in; when the zone can't be guessed —
 * or the guess isn't a zone on the account — the placeholder stays and
 * Cloudflare shows its zone picker, which is the same page one click away.
 * Nothing about the record is prefillable: Cloudflare exposes no such parameter.
 */
export function cloudflareDnsRecordsUrl(host: string): string {
  const zone = cloudflareZoneName(host) ?? ":zone";
  return `https://dash.cloudflare.com/?to=${encodeURIComponent(`/:account/${zone}/dns/records`)}`;
}
