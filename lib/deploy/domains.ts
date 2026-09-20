import "server-only";

import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { friendlyWord } from "../friendly-words";
import {
  WILDCARD_DOMAIN,
  WILDCARD_SUFFIXES,
  wildcardSuffixGroup,
} from "../wildcard-dns";
import { hash6 } from "./routing";
import type { CertProvider, DomainEntrypoint } from "../types/domain";
import { publicBaseUrl } from "../public-url";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s.trim());
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

export function isLoopbackIp(ip: string): boolean {
  return ip.startsWith("127.");
}

function isPrivateIpv4(ip: string): boolean {
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  const m = /^172\.(\d{1,3})\./.exec(ip);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

function allNicIpv4(): string[] {
  const addrs: string[] = [];
  const nets = networkInterfaces();
  for (const key of Object.keys(nets)) {
    for (const a of nets[key] ?? []) {
      const fam = String(a.family);
      if ((fam === "IPv4" || fam === "4") && !a.internal && isIpv4(a.address)) {
        addrs.push(a.address);
      }
    }
  }
  return addrs;
}

export function sameMachineHost(): string {
  try {
    readFileSync("/.dockerenv");
  } catch {
    return "127.0.0.1";
  }
  try {
    const lines = readFileSync("/proc/net/route", "utf8").split("\n").slice(1);
    for (const line of lines) {
      const [, dest, gw, , , , , mask] = line.split(/\s+/);
      if (dest !== "00000000" || mask !== "00000000" || !gw) continue;
      const n = parseInt(gw, 16);
      const ip = [
        n & 255,
        (n >> 8) & 255,
        (n >> 16) & 255,
        (n >> 24) & 255,
      ].join(".");
      if (isIpv4(ip) && ip !== "0.0.0.0") return ip;
    }
  } catch {}
  return "127.0.0.1";
}

function detectNicIpv4(): string | null {
  const addrs = allNicIpv4();
  if (addrs.length === 0) return null;
  return addrs.find((a) => !isPrivateIpv4(a)) ?? addrs[0];
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[deplo] ${msg}`);
}

export function instanceHost(): string {
  const fromEnv = process.env.DEPLO_SERVER_IP?.trim();
  if (fromEnv) {
    if (isIpv4(fromEnv)) return fromEnv;
    warnOnce(
      "bad-server-ip",
      `DEPLO_SERVER_IP="${fromEnv}" is not a valid IPv4 and was ignored. Generated domains require a literal IPv4 address.`,
    );
  }

  const pub = process.env.DEPLO_PUBLIC_URL?.trim();
  if (pub) {
    try {
      const host = new URL(pub).hostname;
      if (isIpv4(host)) return host;
      const embedded = wildcardEmbeddedIp(host);
      if (embedded) return embedded;
    } catch {}
  }

  const nic = detectNicIpv4();
  if (nic) return nic;

  warnOnce(
    "loopback-fallback",
    "Could not determine this server's public IP; falling back to 127.0.0.1. " +
      "Generated URLs will only work on this machine. " +
      "Set DEPLO_SERVER_IP=<public-IPv4> and restart.",
  );
  return "127.0.0.1";
}

export function deploHostSelfAddresses(): Set<string> {
  const now = Date.now();
  const key = `${process.env.DEPLO_SERVER_IP}|${process.env.DEPLO_PUBLIC_URL}|${publicBaseUrl()}`;
  if (
    !selfAddresses ||
    selfAddresses.key !== key ||
    now - selfAddresses.at > SELF_ADDRESSES_TTL_MS
  )
    selfAddresses = { at: now, key, value: computeSelfAddresses() };
  return selfAddresses.value;
}

const SELF_ADDRESSES_TTL_MS = 30_000;
let selfAddresses: { at: number; key: string; value: Set<string> } | null =
  null;

function computeSelfAddresses(): Set<string> {
  const addrs = new Set<string>();
  const add = (v?: string | null) => {
    const s = v?.trim().toLowerCase();
    if (s) addrs.add(s);
  };
  add(process.env.DEPLO_SERVER_IP);
  for (const pub of [process.env.DEPLO_PUBLIC_URL?.trim(), publicBaseUrl()]) {
    if (!pub) continue;
    try {
      add(new URL(pub).hostname);
    } catch {}
  }
  for (const nic of allNicIpv4()) add(nic);
  const gateway = sameMachineHost();
  if (gateway !== "127.0.0.1") add(gateway);
  return addrs;
}

export function isDeploHostServer(
  server: { ip?: string; host?: string },
  self: ReadonlySet<string> = deploHostSelfAddresses(),
): boolean {
  if (self.size === 0) return false;
  const ip = server.ip?.trim().toLowerCase();
  const host = server.host?.trim().toLowerCase();
  return (!!ip && self.has(ip)) || (!!host && self.has(host));
}

export function isBuildFallbackServer(
  server: { buildFallback: boolean | null; ip?: string; host?: string },
  self: ReadonlySet<string> = deploHostSelfAddresses(),
): boolean {
  return server.buildFallback ?? isDeploHostServer(server, self);
}

export function certResolver(): string {
  return process.env.DEPLO_CERT_RESOLVER?.trim() || "letsencrypt";
}

export const LETSENCRYPT_DOMAINS_PER_TEAM_CAP = 50;

export function assertLetsencryptQuota(
  currentCount: number,
  provider: CertProvider | undefined,
): void {
  if ((provider ?? "none") !== "letsencrypt") return;
  if (currentCount >= LETSENCRYPT_DOMAINS_PER_TEAM_CAP) {
    throw new Error(
      `This team has reached its limit of ${LETSENCRYPT_DOMAINS_PER_TEAM_CAP} Let's Encrypt domains. ` +
        "Remove a certificate-backed domain, or add the domain with no certificate, before adding another.",
    );
  }
}

export function cloudflareCertResolver(): string {
  return process.env.DEPLO_CLOUDFLARE_CERT_RESOLVER?.trim() || "cloudflare";
}

export function domainTlsConfig(domain: {
  entrypoint?: DomainEntrypoint;
  certProvider?: CertProvider;
}): { entrypoint: string; tls: boolean; certResolver: string } {
  const provider = domain.certProvider ?? "letsencrypt";
  if (provider === "none") {
    return { entrypoint: "web", tls: false, certResolver: "" };
  }
  if (provider === "custom") {
    return {
      entrypoint: domain.entrypoint ?? "websecure",
      tls: true,
      certResolver: "",
    };
  }
  const resolver =
    provider === "cloudflare" ? cloudflareCertResolver() : certResolver();
  return {
    entrypoint: domain.entrypoint ?? "websecure",
    tls: true,
    certResolver: resolver,
  };
}

export function domainScheme(domain: {
  certProvider?: CertProvider;
  proxied?: boolean | null;
}): "http" | "https" {
  return domain.proxied || domainTlsConfig(domain).tls ? "https" : "http";
}

export function blueprintWantsTls(
  hosts: (string | null | undefined)[],
  texts: (string | null | undefined)[],
): boolean {
  const haystack = texts.filter(Boolean).join("\n").toLowerCase();
  return hosts.some((h) => {
    const host = h
      ?.trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    return !!host && haystack.includes(`https://${host}`);
  });
}

export function resolveServerIp(server?: { ip?: string }): string {
  if (server?.ip && isIpv4(server.ip) && !isLoopbackIp(server.ip)) {
    return server.ip;
  }
  return instanceHost();
}

export function ipToHex(ip: string): string {
  return ip
    .trim()
    .split(".")
    .map((o) => Number(o).toString(16).padStart(2, "0"))
    .join("");
}

export function hexToIp(hex: string): string | null {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null;
  const ip = [0, 2, 4, 6]
    .map((i) => parseInt(hex.slice(i, i + 2), 16))
    .join(".");
  return isIpv4(ip) ? ip : null;
}

const SUFFIX_GROUP = wildcardSuffixGroup();
const WILDCARD_HEXIP_RE = new RegExp(`-([0-9a-f]{8})\\.${SUFFIX_GROUP}$`, "i");
const WILDCARD_HEXIP_EMBEDDED_RE = new RegExp(
  `-([0-9a-f]{8})\\.${SUFFIX_GROUP}`,
  "gi",
);

export function wildcardEmbeddedIp(name: string): string | null {
  const m = WILDCARD_HEXIP_RE.exec(name.trim());
  return m ? hexToIp(m[1]) : null;
}

export function panelFallbackHost(ip = instanceHost()): string {
  return `deplo-${ipToHex(ip)}.${WILDCARD_DOMAIN}`;
}

// A host minted before deplo.site keeps answering, so the panel still owns its old address.
export function isPanelFallbackHost(
  name: string,
  ip = instanceHost(),
): boolean {
  const host = name.trim().toLowerCase();
  const hex = ipToHex(ip);
  return WILDCARD_SUFFIXES.some((s) => host === `deplo-${hex}.${s}`);
}

// Keeps the zone the host was minted in: an existing .nip.io name only changes its IP.
export function rehostWildcard(name: string, ip: string): string {
  return name.replace(
    WILDCARD_HEXIP_RE,
    (_whole, _hex: string, suffix: string) => `-${ipToHex(ip)}.${suffix}`,
  );
}

export function rehostEmbeddedWildcard(
  value: string,
  fromIp: string,
  toIp: string,
): string {
  const fromHex = ipToHex(fromIp);
  const toHex = ipToHex(toIp);
  return value.replace(
    WILDCARD_HEXIP_EMBEDDED_RE,
    (whole, hex: string, suffix: string) =>
      hex.toLowerCase() === fromHex ? `-${toHex}.${suffix}` : whole,
  );
}

export interface BlueprintHosts {
  autoDomain?: string | null;
  extraDomains?:
    | { service: string; port: number; host: string; path?: string | null }[]
    | null;
  env?: { key: string; value: string }[];
}

export function rehostBlueprintHosts<T extends BlueprintHosts>(
  input: T,
  fromIp: string,
  toIp: string,
): T {
  if (fromIp === toIp) return input;
  const rehostHost = (host: string): string =>
    wildcardEmbeddedIp(host) === fromIp ? rehostWildcard(host, toIp) : host;
  return {
    ...input,
    autoDomain: input.autoDomain
      ? rehostHost(input.autoDomain)
      : input.autoDomain,
    extraDomains: input.extraDomains?.length
      ? input.extraDomains.map((e) => ({ ...e, host: rehostHost(e.host) }))
      : input.extraDomains,
    env: input.env?.length
      ? input.env.map((e) => ({
          ...e,
          value: rehostEmbeddedWildcard(e.value, fromIp, toIp),
        }))
      : input.env,
  };
}

export function randomWord(): string {
  return friendlyWord();
}

export function wildcardDomain(
  label: string,
  words: string,
  ip = instanceHost(),
): string {
  const clean = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/^-+|-+$/g, "");
  const tail = `${clean(words)}-${ipToHex(ip)}`;
  const head = clean(label)
    .slice(0, Math.max(1, 62 - tail.length))
    .replace(/-+$/, "");
  return `${head}-${tail}.${WILDCARD_DOMAIN}`;
}

export function productionDomain(slug: string, ip = instanceHost()): string {
  return wildcardDomain(slug, randomWord(), ip);
}

export function previewHost(opts: {
  appId: string;
  slug: string;
  prNumber: number;
  baseDomain?: string | null;
  https?: boolean;
  ip?: string;
}): { host: string; certProvider: CertProvider } {
  const label = `${opts.slug}-pr-${opts.prNumber}`;
  const base = (opts.baseDomain ?? "").trim().replace(/^\.+|\.+$/g, "");
  if (base) {
    return {
      host: `${label}.${base}`.toLowerCase(),
      certProvider: opts.https === false ? "none" : "letsencrypt",
    };
  }
  return {
    host: wildcardDomain(
      label,
      hash6(`${opts.appId}:${opts.prNumber}`),
      opts.ip,
    ),
    certProvider: "none",
  };
}

export function isValidPreviewBaseDomain(base: string): boolean {
  const clean = base
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  if (!clean || clean.length > 200) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    clean,
  );
}
