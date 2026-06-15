import "server-only";

/**
 * Default domains via sslip.io — a public wildcard DNS where
 * `anything.<ip>.sslip.io` resolves to `<ip>` with zero configuration. Every
 * deployment gets a working HTTP(S) hostname immediately, no DNS records
 * required, routed by Traefik on the host's IP.
 */

/** Public IP/host of this Deplo instance. */
export function instanceHost(): string {
  const fromEnv = process.env.DEPLO_SERVER_IP?.trim();
  if (fromEnv) return fromEnv;
  const pub = process.env.DEPLO_PUBLIC_URL?.trim();
  if (pub) {
    try {
      return new URL(pub).hostname;
    } catch {
      /* fall through */
    }
  }
  return "127.0.0.1";
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
