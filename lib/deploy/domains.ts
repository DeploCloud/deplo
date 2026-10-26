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
import { canonicalHost, canonicalIpv6 } from "../host-address";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s.trim());
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

export function isIpv6(s: string): boolean {
  return s.includes(":") && canonicalIpv6(s.trim()) !== null;
}

// The only addresses a generated name can embed: an IPv4, or an IPv6 the internet routes (2000::/3).
export function isWildcardIp(s: string): boolean {
  if (isIpv4(s)) return true;
  const v6 = isIpv6(s) ? canonicalIpv6(s.trim())! : "";
  return /^[23][0-9a-f]{3}:/.test(v6);
}

export function isLoopbackIp(ip: string): boolean {
  return ip.startsWith("127.") || canonicalHost(ip) === "::1";
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

// Global IPv6 only: a link-local fe80:: is on every machine and says nothing about which one this is.
function allNicIpv6(): string[] {
  const addrs: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (!a.internal && "scopeid" in a && a.scopeid === 0)
        addrs.push(a.address);
  return addrs;
}

let containerForTest: boolean | undefined;

/** Whether this process runs in a container, where 127.0.0.1 is its own and not the host's. */
export function runsInContainer(): boolean {
  if (containerForTest !== undefined) return containerForTest;
  try {
    readFileSync("/.dockerenv");
    return true;
  } catch {
    return false;
  }
}

export function __setRunsInContainerForTest(inside?: boolean): void {
  containerForTest = inside;
}

export function sameMachineHost(): string {
  if (!runsInContainer()) return "127.0.0.1";
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
    if (isWildcardIp(fromEnv)) return canonicalHost(fromEnv);
    warnOnce(
      "bad-server-ip",
      `DEPLO_SERVER_IP="${fromEnv}" is not a public IPv4 or IPv6 and was ignored.`,
    );
  }

  const pub = process.env.DEPLO_PUBLIC_URL?.trim();
  if (pub) {
    try {
      const host = new URL(pub).hostname.replace(/^\[(.*)\]$/, "$1");
      if (isWildcardIp(host)) return canonicalHost(host);
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
      "Set DEPLO_SERVER_IP=<public IP> and restart.",
  );
  return "127.0.0.1";
}

// The Deplo host's address of each kind, as the installer measured them from the host itself.
export function instanceAddresses(): { v4: string | null; v6: string | null } {
  const pick = (raw: string | undefined, ok: (s: string) => boolean) => {
    const s = raw?.trim() ?? "";
    return s && ok(s) && isWildcardIp(s) ? canonicalHost(s) : null;
  };
  const primary = instanceHost();
  return {
    v4:
      pick(process.env.DEPLO_SERVER_IPV4, isIpv4) ??
      (isIpv4(primary) && !isLoopbackIp(primary) ? primary : null),
    v6:
      pick(process.env.DEPLO_SERVER_IPV6, isIpv6) ??
      (isIpv6(primary) ? primary : null),
  };
}

export function deploHostSelfAddresses(): Set<string> {
  return cachedSelf(true);
}

/** Only what the Deplo host's machine is, never a name the panel answers on: a domain can move away. */
export function deploHostMachineAddresses(): Set<string> {
  return cachedSelf(false);
}

const SELF_ADDRESSES_TTL_MS = 30_000;
const selfAddresses = new Map<
  boolean,
  { at: number; key: string; value: Set<string> }
>();

function cachedSelf(withNames: boolean): Set<string> {
  const now = Date.now();
  const key = `${process.env.DEPLO_SERVER_IP}|${process.env.DEPLO_SERVER_IPV4}|${process.env.DEPLO_SERVER_IPV6}|${process.env.DEPLO_PUBLIC_URL}|${publicBaseUrl()}`;
  const hit = selfAddresses.get(withNames);
  if (hit && hit.key === key && now - hit.at <= SELF_ADDRESSES_TTL_MS)
    return hit.value;
  const value = computeSelfAddresses(withNames);
  selfAddresses.set(withNames, { at: now, key, value });
  return value;
}

function computeSelfAddresses(withNames: boolean): Set<string> {
  const addrs = new Set<string>();
  const add = (v?: string | null) => {
    const s = canonicalHost(v);
    if (s) addrs.add(s);
  };
  add(process.env.DEPLO_SERVER_IP);
  add(process.env.DEPLO_SERVER_IPV4);
  add(process.env.DEPLO_SERVER_IPV6);
  const names = withNames
    ? [process.env.DEPLO_PUBLIC_URL?.trim(), publicBaseUrl()]
    : [];
  for (const pub of names) {
    if (!pub) continue;
    try {
      add(new URL(pub).hostname);
    } catch {}
  }
  for (const nic of allNicIpv4()) add(nic);
  for (const nic of allNicIpv6()) add(nic);
  const gateway = sameMachineHost();
  if (gateway !== "127.0.0.1") add(gateway);
  return addrs;
}

export function isDeploHostServer(
  server: { ip?: string; host?: string },
  self: ReadonlySet<string> = deploHostSelfAddresses(),
): boolean {
  if (self.size === 0) return false;
  const ip = canonicalHost(server.ip);
  const host = canonicalHost(server.host);
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

// Nobody can install a certificate for a temporary address, so one on a public machine always asks for a real one.
// A private machine's stays as asked: nothing outside can validate it, so "custom" falls back to plain HTTP.
export function temporaryAddressTls(
  name: string,
  tls: { certProvider: CertProvider; entrypoint: DomainEntrypoint },
): { certProvider: CertProvider; entrypoint: DomainEntrypoint } {
  const ip = wildcardEmbeddedIp(name);
  if (ip == null) return tls;
  if (!isPrivateIpv4(ip) && !isLoopbackIp(ip))
    return { certProvider: "letsencrypt", entrypoint: "websecure" };
  return tls.certProvider === "custom" || tls.certProvider === "cloudflare"
    ? { certProvider: "none", entrypoint: "web" }
    : tls;
}

export function domainTlsConfig(domain: {
  name?: string;
  entrypoint?: DomainEntrypoint;
  certProvider?: CertProvider;
}): { entrypoint: string; tls: boolean; certResolver: string } {
  // A row written before temporaryAddressTls existed: "custom" there only ever served a self-signed certificate.
  if (
    domain.certProvider === "custom" &&
    domain.name &&
    wildcardEmbeddedIp(domain.name) != null
  )
    return { entrypoint: "websecure", tls: true, certResolver: certResolver() };
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

// deplo.site reads the FIRST eight hex groups of a label, so `v6-` keeps a word like `cafe` out of the address.
// KEEP IN SYNC with `ip_label` in install.sh.
export function ipLabel(ip: string): string {
  const v6 = isIpv6(ip) ? canonicalIpv6(ip.trim())! : null;
  if (!v6) return ipToHex(ip);
  // A label cannot end in `-`, so an address that would compress at either end is spelled out whole.
  const groups = v6.startsWith("::") || v6.endsWith("::") ? expandIpv6(v6) : v6;
  return `v6-${groups.replace(/:/g, "-")}`;
}

function expandIpv6(v6: string): string {
  const [head, tail] = v6.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  return [...h, ...Array(8 - h.length - t.length).fill("0"), ...t].join(":");
}

function labelToIp(hex: string | undefined, v6: string | undefined) {
  if (hex) return hexToIp(hex);
  const ip = canonicalIpv6((v6 ?? "").replace(/-/g, ":"));
  return ip && isWildcardIp(ip) ? ip : null;
}

const SUFFIX_GROUP = wildcardSuffixGroup();
const IP_LABEL = "(?:([0-9a-f]{8})|v6-([0-9a-f-]+))";
const WILDCARD_HEXIP_RE = new RegExp(`-${IP_LABEL}\\.${SUFFIX_GROUP}$`, "i");
const WILDCARD_HEXIP_EMBEDDED_RE = new RegExp(
  `-${IP_LABEL}\\.${SUFFIX_GROUP}`,
  "gi",
);

export function wildcardEmbeddedIp(name: string): string | null {
  const m = WILDCARD_HEXIP_RE.exec(name.trim());
  return m ? labelToIp(m[1], m[2]) : null;
}

export function panelFallbackHost(ip = instanceHost()): string {
  return `deplo-${ipLabel(ip)}.${WILDCARD_DOMAIN}`;
}

// A host minted before deplo.site keeps answering, so the panel still owns its old address.
export function isPanelFallbackHost(
  name: string,
  ip = instanceHost(),
): boolean {
  const host = name.trim().toLowerCase();
  const label = ipLabel(ip);
  return WILDCARD_SUFFIXES.some((s) => host === `deplo-${label}.${s}`);
}

// Keeps the zone the host was minted in: an existing .nip.io name only changes its IP.
export function rehostWildcard(name: string, ip: string): string {
  return name.replace(
    WILDCARD_HEXIP_RE,
    (whole, hex: string, v6: string, suffix: string) =>
      labelToIp(hex, v6) ? `-${ipLabel(ip)}.${suffix}` : whole,
  );
}

export function rehostEmbeddedWildcard(
  value: string,
  fromIp: string,
  toIp: string,
): string {
  const from = canonicalHost(fromIp);
  return value.replace(
    WILDCARD_HEXIP_EMBEDDED_RE,
    (whole, hex: string, v6: string, suffix: string) =>
      labelToIp(hex, v6) === from ? `-${ipLabel(toIp)}.${suffix}` : whole,
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
  toIp: string | null,
): T {
  if (fromIp === toIp) return input;
  const minted = (host: string) =>
    wildcardEmbeddedIp(host) === canonicalHost(fromIp);
  // A target with no known address cannot have a generated name; keeping this one would route to the wrong machine.
  if (toIp === null)
    return {
      ...input,
      autoDomain:
        input.autoDomain && minted(input.autoDomain) ? null : input.autoDomain,
      extraDomains: input.extraDomains
        ? input.extraDomains.filter((e) => !minted(e.host))
        : input.extraDomains,
    };
  const rehostHost = (host: string): string =>
    minted(host) ? rehostWildcard(host, toIp) : host;
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
  const addr = ipLabel(ip);
  // An IPv6 label is long; the words give way first so the whole name stays one 63-character label.
  const said = clean(words)
    .slice(0, Math.max(1, 59 - addr.length))
    .replace(/-+$/, "");
  const tail = `${said}-${addr}`;
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
