import type { CertProvider, DomainStatus } from "../types/domain";

/** Cloudflare's published proxy IPv4 ranges. */
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

/** Cloudflare's published proxy IPv6 ranges. */
export const CLOUDFLARE_IPV6_RANGES = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

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
  return n >>> 0;
}

function inV4Cidr(ipInt: number, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const baseInt = ipv4ToInt(cidr.slice(0, slash));
  const bits = Number(cidr.slice(slash + 1));
  if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0;
}

// IPv4-mapped tails are not needed for Cloudflare's ranges, so they are treated as invalid.
function ipv6ToBigInt(ip: string): bigint | null {
  const raw = ip.trim();
  if (!raw.includes(":")) return null;
  const halves = raw.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail =
    halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null;
  const groups =
    halves.length === 2
      ? [...head, ...Array(missing).fill("0"), ...tail]
      : head;
  // BigInt(...) calls, not `0n` literals: that syntax needs ES2020 and this project targets ES2017.
  let n = BigInt(0);
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << BigInt(16)) | BigInt(parseInt(g, 16));
  }
  return n;
}

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

/** Whether `ip` belongs to one of Cloudflare's published proxy ranges. */
export function isCloudflareIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ipv6ToBigInt(ip);
    return v6 !== null && CLOUDFLARE_IPV6_RANGES.some((c) => inV6Cidr(v6, c));
  }
  const v4 = ipv4ToInt(ip);
  return v4 !== null && CLOUDFLARE_IPV4_RANGES.some((c) => inV4Cidr(v4, c));
}

// `cloudflare` is plausible but unverified, never confirmed: the domain may just as well be forwarded to somebody else's server.
/** The three outcomes of classifying a domain's resolved A records against the server it should point at. */
export type DomainDnsClass = "valid" | "cloudflare" | "misconfigured";

/** Classify a domain's resolved A records against the `target` server IP it must point at. */
export function classifyDomainDns(
  resolvedIps: string[],
  target: string,
): DomainDnsClass {
  if (resolvedIps.includes(target)) return "valid";
  if (resolvedIps.some(isCloudflareIp)) return "cloudflare";
  return "misconfigured";
}

/** The settled DNS status plus the user's own "something else answers for this hostname" declaration. */
export interface DomainReach {
  status: DomainStatus;
  proxied?: boolean | null;
}

/** Whether something answers for the hostname in FRONT of this server - detected or declared. */
export function isProxiedDomain(d: DomainReach): boolean {
  return d.status === "cloudflare" || d.proxied === true;
}

/** Whether a domain gets a Traefik router at all: DNS points straight here, or a proxy answers for it. */
export function isRoutableDomain(d: DomainReach): boolean {
  return d.status === "valid" || isProxiedDomain(d);
}

/** The ONE place the "proxied ⇒ Cloudflare issues the certificate" rule lives. */
export function certProviderForDns<T extends CertProvider | undefined>(
  status: DomainStatus,
  current: T,
): T | "cloudflare" {
  return status === "cloudflare" && current === "none" ? "cloudflare" : current;
}
