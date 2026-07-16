import "server-only";

import { networkInterfaces } from "node:os";
import {
  uniqueNamesGenerator,
  adjectives,
  animals,
} from "unique-names-generator";
import type { CertProvider, DomainEntrypoint } from "../types";

/**
 * Default domains via nip.io — a public wildcard DNS where a hostname whose
 * final label before `.nip.io` is the server's IPv4 in 8-char HEXADECIMAL
 * (`1.2.3.4` → `01020304`) resolves to that IP with zero configuration. Every
 * deployment gets a working HTTP(S) hostname immediately, no DNS records
 * required, routed by Traefik on the host's IP.
 *
 * The generated shape is `<label>-<adjective>-<animal>-<hexip>.nip.io`: a
 * app/slug prefix, two human-readable random words (so two apps on one
 * server never collide on a bare slug), then the hex IP that does the routing.
 * nip.io's hex form requires the hex octet-quad to be the label IMMEDIATELY
 * before `.nip.io`, which is exactly where it sits here.
 *
 * Because the IP is embedded literally into both the generated hostname and the
 * Traefik `Host()` router rule, it MUST be the server's real, publicly
 * reachable IPv4 — never a loopback address and never a bare hostname (nip.io
 * only resolves a hostname whose trailing label is a valid IPv4 / hex IPv4).
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

/** First non-internal IPv4 on a network interface, preferring a public one. */
function detectNicIpv4(): string | null {
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
 * Public IPv4 of this Deplo instance, resolved in order of trust:
 *   1. `DEPLO_SERVER_IP` (must be a literal IPv4)
 *   2. the IPv4 host of `DEPLO_PUBLIC_URL` (a hostname-valued URL is skipped —
 *      it can't seed a nip.io domain)
 *   3. the first non-internal IPv4 on a network interface
 *   4. `127.0.0.1` as a last resort (with a warning — generated URLs will only
 *      work on this machine)
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
      // cannot be encoded as the trailing hex label of a nip.io host — fall
      // through to NIC detection rather than generating a host with no A record.
    } catch {
      /* not a URL — fall through */
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
 * Name of the Traefik ACME cert resolver baked into every router's
 * `tls.certresolver` label.
 *
 * nip.io domains CANNOT be validated by a DNS-01 resolver (nip.io's
 * nameservers are not under our control, so the `_acme-challenge` TXT record
 * can never be published) — they require an HTTP-01 resolver. When Deplo runs
 * behind a Traefik whose default resolver uses DNS-01 (e.g. Cloudflare for a
 * real domain), point Deplo at a dedicated HTTP-01 resolver via this env var so
 * `<…>-<hexip>.nip.io` certs actually issue instead of falling back to
 * Traefik's self-signed default cert (the "certificate invalid" browser error).
 *
 * Defaults to `letsencrypt` to stay byte-identical to the long-standing label
 * output where no override is set.
 */
export function certResolver(): string {
  return process.env.DEPLO_CERT_RESOLVER?.trim() || "letsencrypt";
}

/**
 * Name of the Traefik DNS-01 cert resolver used when a domain picks the
 * `cloudflare` certificate provider. A real domain whose DNS lives on
 * Cloudflare validates via DNS-01 (a `_acme-challenge` TXT record) rather than
 * HTTP-01 — the proxy must define a resolver by this name with the Cloudflare
 * DNS provider configured. Overridable so an operator can name it whatever their
 * Traefik static config uses; defaults to `cloudflare`.
 */
export function cloudflareCertResolver(): string {
  return process.env.DEPLO_CLOUDFLARE_CERT_RESOLVER?.trim() || "cloudflare";
}

/**
 * The router TLS triplet for a domain's certificate-provider choice — the one
 * place that maps the user-facing {@link CertProvider} enum onto the concrete
 * Traefik resolver/entrypoint a router needs. `entrypoint` is the host's own
 * choice (defaulting to `websecure`), but a `none` provider forces plain HTTP on
 * `web` regardless. Absent fields default to the long-standing HTTPS behaviour
 * (letsencrypt over websecure), so domains created before these fields existed
 * route exactly as they always did.
 */
export function domainTlsConfig(domain: {
  entrypoint?: DomainEntrypoint;
  certProvider?: CertProvider;
}): { entrypoint: string; tls: boolean; certResolver: string } {
  const provider = domain.certProvider ?? "letsencrypt";
  if (provider === "none") {
    return { entrypoint: "web", tls: false, certResolver: "" };
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
 * URL scheme a domain is served on — `http` for the `none` certificate provider
 * (its router terminates no TLS, riding the `web` entrypoint), `https` for every
 * real provider. Same absent-field back-compat reading as {@link domainTlsConfig},
 * so a pre-field row keeps its long-standing `https`.
 */
export function domainScheme(domain: {
  certProvider?: CertProvider;
}): "http" | "https" {
  return domainTlsConfig(domain).tls ? "https" : "http";
}

/**
 * Whether a blueprint's auto domains should be born WITH a TLS certificate.
 *
 * No certificate is ever registered by default — a fresh app's nip.io host is
 * served plain-HTTP. The one exception is a template/compose that itself
 * expects HTTPS: it baked an `https://<one of its own hosts>` URL into an env
 * value, its compose text, or a materialised config file (e.g. AppFlowy's
 * `APPFLOWY_BASE_URL=https://${domain}`) — serving that app over plain HTTP
 * would break it, so its domains get `letsencrypt`. The check is anchored on
 * the app's OWN hosts: a stray `https://hub.docker.com` in a compose comment
 * never opts an app into certificate issuance.
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
 * authoritative when it is a usable, non-loopback IPv4; otherwise fall back to
 * the instance host (a never-set or stored-loopback IP resolves live). Uniform
 * across every server, the host running Deplo included.
 */
export function resolveServerIp(server?: { ip?: string }): string {
  if (server?.ip && isIpv4(server.ip) && !isLoopbackIp(server.ip)) {
    return server.ip;
  }
  return instanceHost();
}

/**
 * `1.2.3.4` → `01020304`: the 8-char, zero-padded hexadecimal of an IPv4, the
 * form nip.io accepts as the routing label. Each octet becomes two hex digits
 * so the result is always exactly 8 chars (a leading-zero octet like `.4.`
 * stays `04`, never `4`), which keeps {@link nipEmbeddedIp} able to find it by
 * fixed width. Assumes a syntactically valid dotted-quad (callers pass
 * {@link instanceHost}/{@link resolveServerIp} output, both validated).
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
  const ip = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(".");
  return isIpv4(ip) ? ip : null;
}

// The hex IP is the final label before `.nip.io`, hyphen-joined to the words
// (`…-<adjective>-<animal>-<hexip>.nip.io`). It's matched by fixed width (8 hex
// digits) anchored on the `-` separator + `.nip.io` suffix, so the random words
// (which are `[a-z]+`, never 8 hex digits hanging off the trailing `-`) can't be
// mistaken for it.
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
 * Rewrite every `…-<fromHex>.nip.io` occurrence inside a free-text string (e.g.
 * an env value like `https://app-…-<hexip>.nip.io/path`) to `<toIp>`, leaving
 * the words and any surrounding text intact. Unlike {@link rehostNip} this is
 * not anchored to the end of the string — env values embed the host mid-text.
 * Only the exact `fromIp` (matched as its hex) is touched, so it's a no-op when
 * the value carries no such host (or a different IP).
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
  extraDomains?: { service: string; port: number; host: string }[] | null;
  env?: { key: string; value: string }[];
}

/**
 * Re-host a template's generated nip.io hosts from `fromIp` (the master IP the
 * /new page baked them against) onto `toIp` (the IP of the server the project
 * actually targets). Rewrites the primary autoDomain, every `extraDomains[].host`,
 * and any env value that embedded a `…-<fromIp-hex>.nip.io` host — leaving
 * non-nip.io hosts, hosts on a different IP, and all other env text untouched.
 * Only the hex IP label is swapped; the words in the host are preserved (the host
 * stays the same project's host, just routed at the new server). Pure: returns a
 * NEW object, never mutates its input. A no-op (returns input as-is fields) when
 * `fromIp === toIp`, so callers can call it unconditionally.
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
    autoDomain: input.autoDomain ? rehostHost(input.autoDomain) : input.autoDomain,
    extraDomains: input.extraDomains?.length
      ? input.extraDomains.map((e) => ({ ...e, host: rehostHost(e.host) }))
      : input.extraDomains,
    env: input.env?.length
      ? input.env.map((e) => ({ ...e, value: rehostEmbeddedNip(e.value, fromIp, toIp) }))
      : input.env,
  };
}

/** A random `adjective-animal` pair (e.g. `charming-otter`), the two
 * human-readable words baked between a domain's app prefix and its hex IP.
 * Fresh on every call (no seed): each generated domain gets its own words, and
 * the result IS the stored hostname, so nothing is ever recomputed. */
export function randomWords(): string {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, animals],
    separator: "-",
    length: 2,
  });
}

/**
 * A nip.io hostname that resolves to `ip` with no DNS setup:
 * `<label>-<adjective>-<animal>-<hexip>.nip.io`. `words` is the random
 * `adjective-animal` pair (caller-supplied so it can be generated once and
 * persisted — the stored hostname is the source of truth, never recomputed).
 * The hex IP is the trailing label, exactly where nip.io expects the address.
 */
export function nipDomain(
  label: string,
  words: string,
  ip = instanceHost(),
): string {
  const clean = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  return `${clean(label)}-${clean(words)}-${ipToHex(ip)}.nip.io`;
}

/** Production domain for a project slug, with freshly-generated words. */
export function productionDomain(slug: string, ip = instanceHost()): string {
  return nipDomain(slug, randomWords(), ip);
}

/**
 * Unique preview domain for a deployment: `<slug>-<token>-<adj>-<animal>-<hexip>
 * .nip.io`. The per-deploy `token` keeps two previews of the same project
 * distinct even though the words are freshly random each deploy (a preview host
 * is ephemeral and never persisted, so regenerating is fine).
 */
export function previewDomain(
  slug: string,
  token: string,
  ip = instanceHost(),
): string {
  return nipDomain(`${slug}-${token}`, randomWords(), ip);
}
