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
 * suite stays hermetic (a real lookup would hit the network — and answer
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
 * The same guard for a destination that is a bare HOST rather than a URL — an SMTP
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
    // one, and a throw used to fall through to "allowed" — an internal literal
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
    // NAT64 (`64:ff9b::<v4>`) carries an embedded IPv4 that a NAT64 gateway
    // translates back — read it out and judge the address it really reaches.
    const nat64 = /^64:ff9b:(?::|.*:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(
      canon,
    );
    if (nat64) {
      const a = parseInt(nat64[1], 16);
      const b = parseInt(nat64[2], 16);
      const v4 = `${(a >> 8) & 0xff}.${a & 0xff}.${(b >> 8) & 0xff}.${b & 0xff}`;
      if (isInternalHost(v4)) refuse();
    }
    return;
  }
  // A canonical dotted-quad is its own answer (isInternalHost already ran).
  if (isIP(host) === 4) return;
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(host);
  } catch {
    return; // unresolvable today — the dial fails too, see the docblock
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
    // An IPv6 literal (brackets stripped by the caller).
    return (
      host === "::" ||
      host === "::1" || // loopback
      /^fe[89ab]/.test(host) || // link-local fe80::/10
      /^f[cd]/.test(host) || // ULA fc00::/7 (covers fd00::/8)
      host.startsWith("::ffff:") // v4-mapped — must not dodge the v4 checks
    );
  }
  return false;
}
