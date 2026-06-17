import "server-only";

/**
 * Resolve the canonical public base URL of this Deplo instance.
 *
 * Security: the Host / X-Forwarded-Host request headers are client-controlled.
 * We never interpolate them raw into shell-bound or copy-and-run strings (the
 * install command). Prefer the operator-configured DEPLO_PUBLIC_URL; otherwise
 * accept the request host only if it matches a strict hostname[:port] shape,
 * rejecting anything with shell metacharacters. Falls back to a safe placeholder.
 */
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
export const PUBLIC_URL_PLACEHOLDER = "https://your-deplo-host";

export function resolvePublicBaseUrl(h: Headers): string {
  const configured = process.env.DEPLO_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const rawHost = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  if (HOST_RE.test(rawHost)) {
    return `${sanitizeProto(h.get("x-forwarded-proto"), rawHost)}://${rawHost}`;
  }
  return PUBLIC_URL_PLACEHOLDER;
}

/**
 * Base URL for the GitHub App manifest. Unlike resolvePublicBaseUrl, this NEVER
 * falls back to a request header: the value is baked permanently into the App's
 * redirect/callback/setup URLs at creation time on GitHub's side, so a wrong
 * guess (e.g. `https://localhost:3000` from a dev request Host) silently breaks
 * every future install with no way to fix it short of editing the App on GitHub.
 * Require an explicit, externally-reachable DEPLO_PUBLIC_URL; otherwise return
 * the placeholder so the caller can surface a clear "set DEPLO_PUBLIC_URL" error.
 */
export function resolveManifestBaseUrl(): string {
  const configured = process.env.DEPLO_PUBLIC_URL?.trim();
  if (!configured) return PUBLIC_URL_PLACEHOLDER;
  const base = configured.replace(/\/+$/, "");
  return isLoopback(base) ? PUBLIC_URL_PLACEHOLDER : base;
}

/**
 * Pick the scheme for a request-derived host. Honour an explicit
 * x-forwarded-proto, but default loopback hosts to http (there is no TLS on
 * localhost) and everything else to https.
 */
function sanitizeProto(value: string | null, host: string): "https" | "http" {
  if (value === "http" || value === "https") return value;
  return isLoopbackHost(host) ? "http" : "https";
}

/** True for localhost / 127.x / ::1 hosts (optionally with a :port). */
function isLoopbackHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return (
    name === "localhost" ||
    name === "::1" ||
    name === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(name)
  );
}

/** True when a full URL points at a loopback host. */
function isLoopback(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).host);
  } catch {
    return false;
  }
}
