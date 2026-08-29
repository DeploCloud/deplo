import "server-only";

import { networkInterfaces } from "node:os";
import {
  uniqueNamesGenerator,
  adjectives,
  animals,
} from "unique-names-generator";
import { hash6 } from "./routing";
import type { CertProvider, DomainEntrypoint } from "../types";
import { publicBaseUrl } from "../public-url";

/**
 * Default domains via nip.io - a public wildcard DNS where a hostname whose final
 * label before `.nip.io` is the server's IPv4 in 8-char HEXADECIMAL (`1.2.3.4` →
 * `01020304`) resolves to that IP with zero configuration.
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** True for a syntactically valid dotted-quad IPv4 string. */
export function isIpv4(s: string): boolean {
  const m = IPV4_RE.exec(s.trim());
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/** True for a loopback (127.0.0.0/8) address. */
export function isLoopbackIp(ip: string): boolean {
  return ip.startsWith("127.");
}

/** True for RFC1918 / link-local IPv4 ranges (not internet-routable). */
function isPrivateIpv4(ip: string): boolean {
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true; // link-local
  const m = /^172\.(\d{1,3})\./.exec(ip);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/** Every non-internal IPv4 across all network interfaces (loopback excluded). */
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

/** First non-internal IPv4 on a network interface, preferring a public one. */
function detectNicIpv4(): string | null {
  const addrs = allNicIpv4();
  if (addrs.length === 0) return null;
  // Prefer a publicly-routable address on multi-homed hosts; fall back to the
  // first private one (still better than loopback for LAN access).
  return addrs.find((a) => !isPrivateIpv4(a)) ?? addrs[0];
}

const warned = new Set<string>();
function warnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[deplo] ${msg}`);
}

/**
 * Public IPv4 of this Deplo instance, resolved in order of trust: 1.
 * `DEPLO_SERVER_IP` (must be a literal IPv4) 2. the first non-internal IPv4 on a
 * network interface 4.
 */
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
      // A hostname-valued DEPLO_PUBLIC_URL (e.g. https://deplo.example.com)
      // cannot be encoded as the trailing hex label of a nip.io host - fall
      // through to NIC detection rather than generating a host with no A record.
    } catch {
      /* not a URL - fall through */
    }
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

/**
 * The addresses that identify the CONTROL-PLANE HOST - the single server in the
 * fleet that also runs Deplo itself ("agent 0"; CONTEXT.md: "the host running
 * Deplo is an agent too"). , never "may this caller do X".
 */
export function deploHostSelfAddresses(): Set<string> {
  const addrs = new Set<string>();
  const add = (v?: string | null) => {
    const s = v?.trim().toLowerCase();
    if (s) addrs.add(s);
  };
  add(process.env.DEPLO_SERVER_IP);
  // Both the address this instance was INSTALLED with and the one it answers on now:
  // an operator who moved the panel and registered its host under the new name would
  // otherwise stop being recognised as their own host, and the settings that read
  for (const pub of [process.env.DEPLO_PUBLIC_URL?.trim(), publicBaseUrl()]) {
    if (!pub) continue;
    try {
      add(new URL(pub).hostname);
    } catch {
      /* not a URL - ignore */
    }
  }
  for (const nic of allNicIpv4()) add(nic);
  return addrs;
}

/**
 * Whether `server` is the host running Deplo - i.e. one of its operator-declared
 * addresses matches this instance's own {@link deploHostSelfAddresses}.
 */
export function isDeploHostServer(
  server: { ip?: string; host?: string },
  self: Set<string> = deploHostSelfAddresses(),
): boolean {
  if (self.size === 0) return false;
  const ip = server.ip?.trim().toLowerCase();
  const host = server.host?.trim().toLowerCase();
  return (!!ip && self.has(ip)) || (!!host && self.has(host));
}

/**
 * Name of the Traefik ACME cert resolver baked into every router's
 * `tls.certresolver` label.
 */
export function certResolver(): string {
  return process.env.DEPLO_CERT_RESOLVER?.trim() || "letsencrypt";
}

/**
 * Per-team cap on `letsencrypt`-backed domains. Left uncapped, one team
 * registering hundreds of `letsencrypt` subdomains would exhaust that shared
 * budget and stall certificate issuance for EVERY other team.
 */
export const LETSENCRYPT_DOMAINS_PER_TEAM_CAP = 50;

/**
 * Guard the shared ACME account: throw when adding one more `letsencrypt` domain
 * would push a team past {@link LETSENCRYPT_DOMAINS_PER_TEAM_CAP}.
 */
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

/**
 * Name of the Traefik DNS-01 cert resolver used when a domain picks the
 * `cloudflare` certificate provider.
 */
export function cloudflareCertResolver(): string {
  return process.env.DEPLO_CLOUDFLARE_CERT_RESOLVER?.trim() || "cloudflare";
}

/**
 * The router TLS triplet for a domain's certificate-provider choice - the one
 * place that maps the user-facing {@link CertProvider} enum onto the concrete
 * Traefik resolver/entrypoint a router needs.
 */
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

/**
 * URL scheme a domain is served on - `http` for the `none` certificate provider
 * (its router terminates no TLS, riding the `web` entrypoint), `https` for every
 * real provider.
 */
export function domainScheme(domain: {
  certProvider?: CertProvider;
  proxied?: boolean | null;
}): "http" | "https" {
  // A proxied host is reached AT the proxy, which terminates TLS there - the
  // origin router behind it can still be plain http.
  return domain.proxied || domainTlsConfig(domain).tls ? "https" : "http";
}

/**
 * Whether a blueprint's auto domains should be born WITH a TLS certificate. The
 * check is anchored on the app's OWN hosts: a stray `https://hub.docker.com` in a
 * compose comment never opts an app into certificate issuance.
 */
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

/**
 * The IPv4 to use for a given server's domains. The server's recorded IP is
 * authoritative when it is a usable, non-loopback IPv4; otherwise fall back to the
 * instance host (a never-set or stored-loopback IP resolves live).
 */
export function resolveServerIp(server?: { ip?: string }): string {
  if (server?.ip && isIpv4(server.ip) && !isLoopbackIp(server.ip)) {
    return server.ip;
  }
  return instanceHost();
}

/**
 * `1.2.3.4` → `01020304`: the 8-char, zero-padded hexadecimal of an IPv4, the form
 * nip.io accepts as the routing label.
 */
export function ipToHex(ip: string): string {
  return ip
    .trim()
    .split(".")
    .map((o) => Number(o).toString(16).padStart(2, "0"))
    .join("");
}

/** `01020304` → `1.2.3.4`: inverse of {@link ipToHex}. Null for anything that
 * is not exactly 8 hex digits decoding to a valid IPv4. */
export function hexToIp(hex: string): string | null {
  if (!/^[0-9a-f]{8}$/i.test(hex)) return null;
  const ip = [0, 2, 4, 6]
    .map((i) => parseInt(hex.slice(i, i + 2), 16))
    .join(".");
  return isIpv4(ip) ? ip : null;
}

// The hex IP is the final label before `.nip.io`, hyphen-joined to the words
// (`…-<adjective>-<animal>-<hexip>.nip.io`).
const NIP_HEXIP_RE = /-([0-9a-f]{8})\.nip\.io$/i;
// Same hex group, NOT end-anchored, for rewriting a host embedded mid-string
// inside a free-text env value (`https://app-…-<hexip>.nip.io/path`).
const NIP_HEXIP_EMBEDDED_RE = /-([0-9a-f]{8})\.nip\.io/gi;

/** The IPv4 embedded (as hex) in an `<…>-<hexip>.nip.io` hostname, or null. */
export function nipEmbeddedIp(name: string): string | null {
  const m = NIP_HEXIP_RE.exec(name.trim());
  return m ? hexToIp(m[1]) : null;
}

/** Replace the embedded IP of a nip.io hostname (no-op for other names). */
export function rehostNip(name: string, ip: string): string {
  return name.replace(NIP_HEXIP_RE, `-${ipToHex(ip)}.nip.io`);
}

/**
 * Rewrite every `…-<fromHex>.nip.io` occurrence inside a free-text string (e.g. an
 * env value like `https://app-…-<hexip>.nip.io/path`) to `<toIp>`, leaving the
 * words and any surrounding text intact.
 */
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

/** The subset of a template's CreateAppInput whose nip.io hosts are baked
 * against the master IP and must follow the project to its target server. */
export interface BlueprintHosts {
  autoDomain?: string | null;
  extraDomains?:
    | { service: string; port: number; host: string; path?: string | null }[]
    | null;
  env?: { key: string; value: string }[];
}

/**
 * Re-host a template's generated nip.io hosts from `fromIp` (the master IP the
 * /new page baked them against) onto `toIp` (the IP of the server the project
 * actually targets). Pure: returns a NEW object, never mutates its input.
 */
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

/**
 * A random `adjective-animal` pair (e.g. `charming-otter`), the two human-readable
 * words baked between a domain's app prefix and its hex IP.
 */
export function randomWords(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: "-",
    length: 2,
  });
}

/**
 * A nip.io hostname that resolves to `ip` with no DNS setup:
 * `<label>-<adjective>-<animal>-<hexip>.nip.io`.
 */
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
  // A DNS label stops at 63 characters, and an app name plus a compose service
  // name reaches that - the host would simply not resolve. The words and the IP
  // carry the uniqueness, so the readable half is the one that gives way.
  const head = clean(label)
    .slice(0, Math.max(1, 62 - tail.length))
    .replace(/-+$/, "");
  return `${head}-${tail}.nip.io`;
}

/** Production domain for a project slug, with freshly-generated words. */
export function productionDomain(slug: string, ip = instanceHost()): string {
  return nipDomain(slug, randomWords(), ip);
}

/**
 * The hostname a pull request preview answers on, and the certificate provider its
 * router must be rendered with. The slug is part of the host, so two apps sharing
 * one base never collide.
 */
export function previewHost(opts: {
  appId: string;
  slug: string;
  prNumber: number;
  /** e.g. `preview.example.com`. Empty/absent ⇒ the nip.io default. */
  baseDomain?: string | null;
  /**
   * Serve previews over HTTPS.
   */
  https?: boolean;
  ip?: string;
}): { host: string; certProvider: CertProvider } {
  const label = `${opts.slug}-pr-${opts.prNumber}`;
  const base = (opts.baseDomain ?? "").trim().replace(/^\.+|\.+$/g, "");
  if (base) {
    return {
      host: `${label}.${base}`.toLowerCase(),
      // Plain HTTP on a domain you own is a legitimate choice; on nip.io it is
      // the only one.
      certProvider: opts.https === false ? "none" : "letsencrypt",
    };
  }
  return {
    host: nipDomain(label, hash6(`${opts.appId}:${opts.prNumber}`), opts.ip),
    certProvider: "none",
  };
}

/**
 * Whether a string is usable as the base of a preview hostname. Deliberately
 * strict: it is concatenated into a Traefik `Host()` rule, so anything that is
 * not a plain dotted hostname is refused rather than escaped.
 */
export function isValidPreviewBaseDomain(base: string): boolean {
  const clean = base
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
  if (!clean || clean.length > 200) return false;
  // At least one dot (a bare TLD is never what anyone means), and each label is
  // alphanumeric with inner dashes.
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    clean,
  );
}
