import "server-only";

import { networkInterfaces } from "node:os";
import type { CertProvider, DomainEntrypoint } from "../types";

/**
 * Default domains via sslip.io — a public wildcard DNS where
 * `anything.<ip>.sslip.io` resolves to `<ip>` with zero configuration. Every
 * deployment gets a working HTTP(S) hostname immediately, no DNS records
 * required, routed by Traefik on the host's IP.
 *
 * Because the IP is embedded literally into both the generated hostname and the
 * Traefik `Host()` router rule, it MUST be the server's real, publicly
 * reachable IPv4 — never a loopback address and never a bare hostname (sslip.io
 * only resolves `<label>.<IPv4>.sslip.io`).
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
 *      it can't seed an sslip.io domain)
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
      `DEPLO_SERVER_IP="${fromEnv}" is not a valid IPv4 and was ignored. sslip.io domains require a literal IPv4 address.`,
    );
  }

  const pub = process.env.DEPLO_PUBLIC_URL?.trim();
  if (pub) {
    try {
      const host = new URL(pub).hostname;
      if (isIpv4(host)) return host;
      // A hostname-valued DEPLO_PUBLIC_URL (e.g. https://deplo.example.com)
      // cannot be embedded into <label>.<host>.sslip.io — fall through to NIC
      // detection rather than generating a hostname with no A record.
    } catch {
      /* not a URL — fall through */
    }
  }

  const nic = detectNicIpv4();
  if (nic) return nic;

  warnOnce(
    "loopback-fallback",
    "Could not determine this server's public IP; falling back to 127.0.0.1. " +
      "Generated sslip.io URLs will only work on this machine. " +
      "Set DEPLO_SERVER_IP=<public-IPv4> and restart.",
  );
  return "127.0.0.1";
}

/**
 * Name of the Traefik ACME cert resolver baked into every router's
 * `tls.certresolver` label.
 *
 * sslip.io domains CANNOT be validated by a DNS-01 resolver (sslip.io's
 * nameservers are not under our control, so the `_acme-challenge` TXT record
 * can never be published) — they require an HTTP-01 resolver. When Deplo runs
 * behind a Traefik whose default resolver uses DNS-01 (e.g. Cloudflare for a
 * real domain), point Deplo at a dedicated HTTP-01 resolver via this env var so
 * `<label>.<ip>.sslip.io` certs actually issue instead of falling back to
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
 * The IPv4 to use for a given server's domains. A remote server's recorded IP
 * is authoritative; for the localhost master we prefer a usable recorded IP but
 * never a stored loopback (an early install may have persisted "127.0.0.1"),
 * resolving the host live in that case.
 */
export function resolveServerIp(server?: {
  type?: string;
  ip?: string;
}): string {
  if (server?.type && server.type !== "localhost") {
    return server.ip && isIpv4(server.ip) ? server.ip : instanceHost();
  }
  if (server?.ip && isIpv4(server.ip) && !isLoopbackIp(server.ip)) {
    return server.ip;
  }
  return instanceHost();
}

const SSLIP_IP_RE = /\.(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\.sslip\.io$/i;

/** The IPv4 embedded in an `<label>.<ip>.sslip.io` hostname, or null. */
export function sslipEmbeddedIp(name: string): string | null {
  const m = SSLIP_IP_RE.exec(name);
  return m && isIpv4(m[1]) ? m[1] : null;
}

/** Replace the embedded IPv4 of an sslip.io hostname (no-op for other names). */
export function rehostSslip(name: string, ip: string): string {
  return name.replace(SSLIP_IP_RE, `.${ip}.sslip.io`);
}

/**
 * Rewrite every `*.<fromIp>.sslip.io` occurrence inside a free-text string (e.g.
 * an env value like `https://app.<ip>.sslip.io/path`) to `<toIp>`, leaving the
 * label and any surrounding text intact. Unlike {@link rehostSslip} this is not
 * anchored to the end of the string — env values embed the host mid-text. Only
 * the exact `fromIp` is touched, so it's a no-op when the value carries no such
 * host (or a different IP). `fromIp` is escaped for the regex (literal dots).
 */
export function rehostEmbeddedSslip(
  value: string,
  fromIp: string,
  toIp: string,
): string {
  const esc = fromIp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return value.replace(
    new RegExp(`\\.${esc}\\.sslip\\.io`, "gi"),
    `.${toIp}.sslip.io`,
  );
}

/** The subset of a template's CreateProjectInput whose sslip.io hosts are baked
 * against the master IP and must follow the project to its target server. */
export interface BlueprintHosts {
  autoDomain?: string | null;
  exposes?: { service: string; port: number; host?: string }[] | null;
  env?: { key: string; value: string }[];
}

/**
 * Re-host a template's generated sslip.io hosts from `fromIp` (the master IP the
 * /new page baked them against) onto `toIp` (the IP of the server the project
 * actually targets). Rewrites the primary autoDomain, every `exposes[].host`, and
 * any env value that embedded a `*.<fromIp>.sslip.io` host — leaving non-sslip
 * hosts, hosts on a different IP, and all other env text untouched. Pure: returns
 * a NEW object, never mutates its input. A no-op (returns input as-is fields)
 * when `fromIp === toIp`, so callers can call it unconditionally.
 */
export function rehostBlueprintHosts<T extends BlueprintHosts>(
  input: T,
  fromIp: string,
  toIp: string,
): T {
  if (fromIp === toIp) return input;
  const rehostHost = (host: string): string =>
    sslipEmbeddedIp(host) === fromIp ? rehostSslip(host, toIp) : host;
  return {
    ...input,
    autoDomain: input.autoDomain ? rehostHost(input.autoDomain) : input.autoDomain,
    exposes: input.exposes?.length
      ? input.exposes.map((e) => (e.host ? { ...e, host: rehostHost(e.host) } : e))
      : input.exposes,
    env: input.env?.length
      ? input.env.map((e) => ({ ...e, value: rehostEmbeddedSslip(e.value, fromIp, toIp) }))
      : input.env,
  };
}

/** An sslip.io hostname that resolves to `ip` with no DNS setup. */
export function sslipDomain(label: string, ip = instanceHost()): string {
  const clean = label
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${clean}.${ip}.sslip.io`;
}

/** Production domain for a project slug. */
export function productionDomain(slug: string, ip = instanceHost()): string {
  return sslipDomain(slug, ip);
}

/** Unique preview domain for a deployment. */
export function previewDomain(
  slug: string,
  token: string,
  ip = instanceHost(),
): string {
  return sslipDomain(`${slug}-${token}`, ip);
}
