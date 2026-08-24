import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The SSRF guard for every user-supplied URL Deplo dials itself: an S3 endpoint,
 * a Discord/Slack/generic webhook, a git connection's base URL.
 *
 * The list is exhaustive on purpose - a dialer that is not on it is a hole, and
 * the git base URL was exactly that for as long as it was missing: the control
 * plane proved the token against it, listed repositories through it and
 * registered a webhook on it, while surfacing the provider's own response body
 * in its error message. That last part is what made it worse than the usual
 * blind case. Before adding an outbound `fetch` anywhere, put its address
 * through here first.
 *
 * THE ONE EXEMPTION, named so the list stays honest: `probePanel` in
 * `lib/data/instance-settings.ts` dials the panel's OWN address to prove a new
 * one answers before the old one is given up. That address is legitimately
 * private on plenty of installs, so this guard would refuse the very operator it
 * exists for. It is instance-admin gated at the dialer instead - the same
 * trade `allowPrivateEndpoint` makes for an S3 endpoint and a git base URL.
 * Anything else that is not on this list is a hole, not a second exemption.
 *
 * A LEAF module on purpose. It used to live in `lib/data/s3.ts`, which records
 * activity - and once the activity log started raising alerts, every alert
 * channel importing the guard closed a require cycle
 * (activity -> dispatch -> channels -> s3 -> activity). Nothing here imports
 * anything but node's resolver, so there is no cycle left to reason about.
 * `lib/data/s3.ts` re-exports it, so its own callers and tests are unchanged.
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
 * Guard a user-supplied outbound URL (S3 endpoint, notification webhook)
 * against SSRF: the control plane dials the webhooks itself and the agents dial
 * the endpoint, so it must be http(s) and must never aim INSIDE the deployment.
 * Literal loopback, RFC1918, CGNAT, link-local (incl. the cloud metadata IP
 * 169.254.169.254) and IPv6 loopback/link-local/ULA hosts are rejected.
 * (WHATWG URL canonicalizes octal/hex/decimal IPv4 forms, so `0177.0.0.1` lands
 * on the dotted-decimal checks below.)
 *
 * A HOSTNAME is resolved and every address it answers with runs through the same
 * check — otherwise the guard only stopped the naive spelling of the attack, and
 * `http://internal.example.com/` walked straight past it into the control
 * plane's own network. That is also why the callers dial with
 * `redirect: "manual"`: a 302 is the other way out of a checked URL.
 *
 * The ceiling this does NOT reach is a rebinding race — the name is resolved
 * here and again by the dial, and only pinning the address through to the socket
 * closes that. A name that fails to resolve is left alone: the dial will fail
 * too, and refusing to SAVE a webhook because DNS blipped is a worse trade.
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
 * The same guard for a destination that is a bare HOST rather than a URL — an
 * SMTP server, which nodemailer dials by `host` + `port` and which therefore
 * never goes near {@link assertSafeOutboundUrl}. Same rules, same message, so
 * the one notification channel that is not a URL is not the one exception.
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
  // loopback, an expanded v4-mapped address) sails past it. Canonicalize through
  // WHATWG URL — which compresses IPv6 — and re-check the result before trusting.
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
  // A canonical dotted-quad is its own answer (isInternalHost already ran). A
  // NON-canonical numeric IPv4 (`2130706433`, `127.1`, `0177.0.0.1`,
  // `2852039166` = 169.254.169.254) is NOT a literal isInternalHost can read, so
  // it falls through to dnsLookup and is judged on the address
  // getaddrinfo(inet_aton) canonicalizes it to.
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
