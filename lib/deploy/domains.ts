import "server-only";

import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { friendlyWords } from "../friendly-words";
import { hash6 } from "./routing";
import type { CertProvider, DomainEntrypoint } from "../types/domain";
import { publicBaseUrl } from "../public-url";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// True for a syntactically valid dotted-quad IPv4 string.
export function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s.trim());
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

// True for a loopback (127.0.0.0/8) address.
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
      // family is "IPv4" on Node 18+ but was the number 4 on older runtimes.
      const fam = String(a.family);
      if ((fam === "IPv4" || fam === "4") && !a.internal && isIpv4(a.address)) {
        addrs.push(a.address);
      }
    }
  }
  return addrs;
}

// The address a container on this instance reaches its own host on: the default route's gateway.
export function sameMachineHost(): string {
  // Outside a container the default gateway is the ROUTER, not this box, and calling
  // that "us" would make a server row for the router read as agent 0.
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
      // Little-endian hex, the way the kernel writes it.
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

// Public IPv4 of this Deplo instance: DEPLO_SERVER_IP first, then the first non-internal NIC address.
export function instanceHost(): string {
  const fromEnv = process.env.DEPLO_SERVER_IP?.trim();
  if (fromEnv) {
    if (isIpv4(fromEnv)) return fromEnv;
    warnOnce(
      "bad-server-ip",
      `DEPLO_SERVER_IP="${fromEnv}" is not a valid IPv4 and was ignored. nip.io domains require a literal IPv4 address.`,
    );
  }

  const pub = process.env.DEPLO_PUBLIC_URL?.trim();
  if (pub) {
    try {
      const host = new URL(pub).hostname;
      if (isIpv4(host)) return host;
      // The panel's nip.io host CARRIES this server's IP, so reading it back beats NIC
      // detection on a multi-homed box; a hostname falls through instead, since it
      // cannot be encoded as a nip.io label and would mint a host with no A record.
      const embedded = nipEmbeddedIp(host);
      if (embedded) return embedded;
    } catch {}
  }

  const nic = detectNicIpv4();
  if (nic) return nic;

  warnOnce(
    "loopback-fallback",
    "Could not determine this server's public IP; falling back to 127.0.0.1. " +
      "Generated nip.io URLs will only work on this machine. " +
      "Set DEPLO_SERVER_IP=<public-IPv4> and restart.",
  );
  return "127.0.0.1";
}

// The addresses that identify the control-plane host - the fleet server that also runs Deplo ("agent 0").
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
  // Both the address this instance was INSTALLED with and the one it answers on now,
  // so an operator who moved the panel still recognises their own host.
  for (const pub of [process.env.DEPLO_PUBLIC_URL?.trim(), publicBaseUrl()]) {
    if (!pub) continue;
    try {
      add(new URL(pub).hostname);
    } catch {}
  }
  for (const nic of allNicIpv4()) add(nic);
  // Without the container gateway, the one address that reaches a panel on the same
  // machine read as a stranger and Deplo asked for a second agent on its own box.
  const gateway = sameMachineHost();
  if (gateway !== "127.0.0.1") add(gateway);
  return addrs;
}

// Whether `server` is the host running Deplo: one of its addresses matches this instance's own.
export function isDeploHostServer(
  server: { ip?: string; host?: string },
  self: ReadonlySet<string> = deploHostSelfAddresses(),
): boolean {
  if (self.size === 0) return false;
  const ip = server.ip?.trim().toLowerCase();
  const host = server.host?.trim().toLowerCase();
  return (!!ip && self.has(ip)) || (!!host && self.has(host));
}

// Whether a host compiles for an app whose own build server could not; `null` means the Deplo host.
export function isBuildFallbackServer(
  server: { buildFallback: boolean | null; ip?: string; host?: string },
  self: ReadonlySet<string> = deploHostSelfAddresses(),
): boolean {
  return server.buildFallback ?? isDeploHostServer(server, self);
}

// Name of the Traefik ACME cert resolver baked into every router's `tls.certresolver` label.
export function certResolver(): string {
  return process.env.DEPLO_CERT_RESOLVER?.trim() || "letsencrypt";
}

// Per-team cap on `letsencrypt` domains: uncapped, one team could exhaust the shared ACME budget.
export const LETSENCRYPT_DOMAINS_PER_TEAM_CAP = 50;

// Throw when one more `letsencrypt` domain would push a team past the cap.
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

// Name of the Traefik DNS-01 cert resolver used by the `cloudflare` certificate provider.
export function cloudflareCertResolver(): string {
  return process.env.DEPLO_CLOUDFLARE_CERT_RESOLVER?.trim() || "cloudflare";
}

// The router TLS triplet for a domain's certificate-provider choice.
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

// URL scheme a domain is served on - `http` only for the `none` certificate provider.
export function domainScheme(domain: {
  certProvider?: CertProvider;
  proxied?: boolean | null;
}): "http" | "https" {
  return domain.proxied || domainTlsConfig(domain).tls ? "https" : "http";
}

// Whether a blueprint's auto domains are born with a TLS certificate, anchored on the app's own hosts.
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

// The IPv4 to use for a server's domains: its recorded IP when usable, else the instance host.
export function resolveServerIp(server?: { ip?: string }): string {
  if (server?.ip && isIpv4(server.ip) && !isLoopbackIp(server.ip)) {
    return server.ip;
  }
  return instanceHost();
}

// `1.2.3.4` to `01020304`: the 8-char hexadecimal of an IPv4, the form nip.io accepts.
export function ipToHex(ip: string): string {
  return ip
    .trim()
    .split(".")
    .map((o) => Number(o).toString(16).padStart(2, "0"))
    .join("");
}

// `01020304` back to `1.2.3.4`: inverse of ipToHex, null for anything else.
export function hexToIp(hex: string): string | null {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null;
  const ip = [0, 2, 4, 6]
    .map((i) => parseInt(hex.slice(i, i + 2), 16))
    .join(".");
  return isIpv4(ip) ? ip : null;
}

const NIP_HEXIP_RE = /-([0-9a-f]{8})\.nip\.io$/i;
const NIP_HEXIP_EMBEDDED_RE = /-([0-9a-f]{8})\.nip\.io/gi;

// The IPv4 embedded (as hex) in a `<hexip>.nip.io` hostname, or null.
export function nipEmbeddedIp(name: string): string | null {
  const m = NIP_HEXIP_RE.exec(name.trim());
  return m ? hexToIp(m[1]) : null;
}

// The address the panel answers on when nobody gave it a domain.
export function panelFallbackHost(ip = instanceHost()): string {
  return `deplo-${ipToHex(ip)}.nip.io`;
}

// Replace the embedded IP of a nip.io hostname (no-op for other names).
export function rehostNip(name: string, ip: string): string {
  return name.replace(NIP_HEXIP_RE, `-${ipToHex(ip)}.nip.io`);
}

// Rewrite every embedded `<hexip>.nip.io` host inside a free-text string onto `toIp`.
export function rehostEmbeddedNip(
  value: string,
  fromIp: string,
  toIp: string,
): string {
  const fromHex = ipToHex(fromIp);
  const toHex = ipToHex(toIp);
  return value.replace(NIP_HEXIP_EMBEDDED_RE, (whole, hex: string) =>
    hex.toLowerCase() === fromHex ? `-${toHex}.nip.io` : whole,
  );
}

// The subset of a template's CreateAppInput whose nip.io hosts must follow the project to its target server.
export interface BlueprintHosts {
  autoDomain?: string | null;
  extraDomains?:
    | { service: string; port: number; host: string; path?: string | null }[]
    | null;
  env?: { key: string; value: string }[];
}

// Re-host a template's generated nip.io hosts from `fromIp` onto `toIp`. Returns a NEW object.
export function rehostBlueprintHosts<T extends BlueprintHosts>(
  input: T,
  fromIp: string,
  toIp: string,
): T {
  if (fromIp === toIp) return input;
  const rehostHost = (host: string): string =>
    nipEmbeddedIp(host) === fromIp ? rehostNip(host, toIp) : host;
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
          value: rehostEmbeddedNip(e.value, fromIp, toIp),
        }))
      : input.env,
  };
}

// A random `adjective-animal` pair baked between a domain's app prefix and its hex IP.
export function randomWords(): string {
  return friendlyWords();
}

// A nip.io hostname that resolves to `ip` with no DNS setup.
export function nipDomain(
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
  // A DNS label stops at 63 characters, so the readable half is what gives way.
  const head = clean(label)
    .slice(0, Math.max(1, 62 - tail.length))
    .replace(/-+$/, "");
  return `${head}-${tail}.nip.io`;
}

// Production domain for a project slug, with freshly-generated words.
export function productionDomain(slug: string, ip = instanceHost()): string {
  return nipDomain(slug, randomWords(), ip);
}

// The hostname a pull request preview answers on, and the certificate provider for its router.
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
    host: nipDomain(label, hash6(`${opts.appId}:${opts.prNumber}`), opts.ip),
    certProvider: "none",
  };
}

// Whether a string can base a preview hostname: it lands in a Traefik `Host()` rule, so it is refused rather than escaped.
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
