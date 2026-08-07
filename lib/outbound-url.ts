import "server-only";

import { lookup } from "node:dns/promises";

/**
 * The SSRF guard for every user-supplied URL Deplo dials itself: an S3 endpoint,
 * a Discord/Slack/generic webhook.
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
  if (url.protocol !== "https:" && !(opts?.allowHttp && url.protocol === "http:"))
    throw new Error(`${label} must be an ${opts?.allowHttp ? "http(s)" : "https"} URL`);
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
  const host = raw.trim().toLowerCase();
  const refuse = () => {
    throw new Error(`${label} must not point at a private or internal address`);
  };
  if (isInternalHost(host)) refuse();
  // A literal is its own answer; only a NAME has to be resolved.
  if (/^[\d.]+$/.test(host) || host.includes(":")) return;
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
