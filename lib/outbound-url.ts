import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The SSRF guard for every user-supplied URL Deplo dials itself. A dialer not on
 * the list is a hole, so put a new outbound `fetch` through here first. ONE
 * exemption exists: `probePanel` dials the panel's own (often private) address
 * and is instance-admin gated instead. There is no second one.
 */

/**
 * The one name resolver the outbound guard goes through, swappable so the pglite
 * suite stays hermetic (a real lookup would hit the network, and answer
 * differently on every machine). Production always uses node's resolver.
 */
let dnsLookup: (host: string) => Promise<{ address: string }[]> = (host) =>
  lookup(host, { all: true });

export function __setDnsLookupForTest(
  fn: (host: string) => Promise<{ address: string }[]>,
): void {
  dnsLookup = fn;
}

export function __resetDnsLookupForTest(): void {
  dnsLookup = (host) => lookup(host, { all: true });
}

/**
 * Guard a user-supplied outbound URL (S3 endpoint, notification webhook) against
 * SSRF: the control plane dials the webhooks itself and the agents dial the
 * endpoint, so it must be http(s) and must never aim INSIDE the deployment.
 */
export async function assertSafeOutboundUrl(
  raw: string,
  label: string,
  opts?: { allowHttp?: boolean },
): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (
    url.protocol !== "https:" &&
    !(opts?.allowHttp && url.protocol === "http:")
  )
    throw new Error(
      `${label} must be an ${opts?.allowHttp ? "http(s)" : "https"} URL`,
    );
  await assertSafeOutboundHost(url.hostname.replace(/^\[|\]$/g, ""), label);
}

/**
 * The same guard for a destination that is a bare HOST rather than a URL - an SMTP
 * server, which nodemailer dials by `host` + `port` and which therefore never goes
 * near {@link assertSafeOutboundUrl}.
 */
export async function assertSafeOutboundHost(
  raw: string,
  label: string,
): Promise<void> {
  // Strip IPv6 brackets: the URL path already does, but a bare SMTP host arrives
  // raw, so `[::1]` must be judged as `::1`, not sailed past as an opaque literal.
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const refuseError = () =>
    new Error(`${label} must not point at a private or internal address`);
  const refuse = (): never => {
    throw refuseError();
  };
  if (isInternalHost(host)) refuse();
  // An IPv6 LITERAL is its own answer (no DNS), but isInternalHost only reads the
  // compressed form, so an un-compressed spelling (`0:0:0:0:0:0:0:1`, a padded
  // loopback, an expanded v4-mapped address) sails past it.
  if (isIP(host) === 6) {
    // Strip a zone id (`::1%eth0`) before canonicalizing: WHATWG URL THROWS on
    // one, and a throw used to fall through to "allowed" - an internal literal
    // could dodge the guard just by naming an interface.
    const bare = host.split("%")[0];
    let canon: string | null = null;
    try {
      canon = new URL(`http://[${bare}]/`).hostname
        .replace(/^\[|\]$/g, "")
        .toLowerCase();
    } catch {
      canon = null;
    }
    // A literal we cannot canonicalize is not a literal we can vouch for.
    if (canon === null) throw refuseError();
    if (isInternalHost(canon)) refuse();
    return;
  }
  // A canonical dotted-quad is its own answer (isInternalHost already ran).
  if (isIP(host) === 4) return;
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host);
  } catch {
    return; // unresolvable today - the dial fails too, see the docblock
  }
  if (addresses.some((a) => isInternalHost(a.address.toLowerCase()))) refuse();
}

/** True for a host literal inside the deployment's own network (see above). */
function isInternalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 || // "this network"
      a === 10 || // RFC1918
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT (100.64/10)
      (a === 169 && b === 254) || // link-local + the metadata IP
      (a === 172 && b >= 16 && b <= 31) || // RFC1918
      (a === 192 && b === 168) // RFC1918
    );
  }
  if (host.includes(":")) {
    // An IPv6 literal (brackets stripped by the caller), in any spelling.
    const n = expandV6(host);
    if (!n) return true; // unreadable - not one to vouch for
    if (n.slice(0, 7).every((v) => v === 0) && n[7] <= 1) return true; // :: and ::1
    if ((n[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((n[0] & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
    // v4-mapped, NAT64, 6to4 and Teredo all carry an IPv4 a translator reaches:
    // judge THAT address with the v4 rule.
    const v4 = embeddedV4(n);
    return v4 !== null && isInternalHost(v4);
  }
  return false;
}

/** The eight hextets of an IPv6 literal, or null when it does not read as one. */
function expandV6(host: string): number[] | null {
  const bare = host.split("%")[0];
  const dotted = /^(.*):(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(bare);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    return expandV6(
      `${dotted[1]}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`,
    );
  }
  const halves = bare.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups =
    halves.length === 2
      ? [
          ...head,
          ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"),
          ...tail,
        ]
      : head;
  if (groups.length !== 8) return null;
  const n = groups.map((g) =>
    /^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN,
  );
  return n.some(Number.isNaN) ? null : n;
}

/** The IPv4 an IPv6 address stands for, when its prefix says it does. */
function embeddedV4(n: number[]): string | null {
  const v4 = (hi: number, lo: number) =>
    `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const zeroTo = (k: number) => n.slice(0, k).every((v) => v === 0);
  if (zeroTo(5) && n[5] === 0xffff) return v4(n[6], n[7]); // ::ffff:a.b.c.d
  if (n[0] === 0x64 && n[1] === 0xff9b && (n[2] === 0 || n[2] === 1))
    return v4(n[6], n[7]); // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (n[0] === 0x2002) return v4(n[1], n[2]); // 6to4
  if (n[0] === 0x2001 && n[1] === 0) return v4(n[6] ^ 0xffff, n[7] ^ 0xffff); // Teredo, client address inverted
  return null;
}
