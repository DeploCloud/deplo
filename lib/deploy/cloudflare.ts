import type { CertProvider, DomainStatus } from "../types/domain";

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

export function isCloudflareIp(ip: string): boolean {
  if (ip.includes(":")) {
    const v6 = ipv6ToBigInt(ip);
    return v6 !== null && CLOUDFLARE_IPV6_RANGES.some((c) => inV6Cidr(v6, c));
  }
  const v4 = ipv4ToInt(ip);
  return v4 !== null && CLOUDFLARE_IPV4_RANGES.some((c) => inV4Cidr(v4, c));
}

export type DomainDnsClass = "valid" | "cloudflare" | "misconfigured";

export interface DnsAnswers {
  a: string[];
  aaaa: string[];
}

// v6Known: `v6` is every IPv6 the server has, so an AAAA outside it is somebody else's.
export interface DnsTargets {
  v4: string[];
  v6: string[];
  v6Known: boolean;
}

export interface StrayRecord {
  type: "A" | "AAAA";
  address: string;
}

export interface DnsVerdict {
  status: DomainDnsClass;
  stray: StrayRecord | null;
}

// Let's Encrypt checks over IPv6 whenever an AAAA exists, so a right A beside a wrong AAAA still fails.
export function classifyDnsRecords(
  answers: DnsAnswers,
  targets: DnsTargets,
): DnsVerdict {
  const hit =
    answers.a.some((ip) => targets.v4.includes(ip)) ||
    answers.aaaa.some((ip) => targets.v6.includes(ip));
  const strayAaaa = targets.v6Known
    ? answers.aaaa.find((ip) => !targets.v6.includes(ip) && !isCloudflareIp(ip))
    : undefined;
  const strayA =
    targets.v4.length > 0 && !answers.a.some((ip) => targets.v4.includes(ip))
      ? answers.a.find((ip) => !isCloudflareIp(ip))
      : undefined;
  const stray: StrayRecord | null = strayAaaa
    ? { type: "AAAA", address: strayAaaa }
    : strayA
      ? { type: "A", address: strayA }
      : null;
  if (hit && !stray) return { status: "valid", stray: null };
  if (!hit && [...answers.a, ...answers.aaaa].some(isCloudflareIp))
    return { status: "cloudflare", stray: null };
  return { status: "misconfigured", stray };
}

export interface DomainReach {
  status: DomainStatus;
  proxied?: boolean | null;
}

export function isProxiedDomain(d: DomainReach): boolean {
  return d.status === "cloudflare" || d.proxied === true;
}

export function isRoutableDomain(d: DomainReach): boolean {
  return d.status === "valid" || isProxiedDomain(d);
}

export function certProviderForDns<T extends CertProvider | undefined>(
  status: DomainStatus,
  current: T,
): T | "cloudflare" {
  return status === "cloudflare" && current === "none" ? "cloudflare" : current;
}
