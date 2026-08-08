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

/**
 * The address stored in `instance_settings`, cached in memory.
 *
 * It exists because two consumers need this answer SYNCHRONOUSLY and cannot
 * await a database read: Better Auth decides `useSecureCookies` and its
 * `baseURL` when the auth instance is built. Get it wrong in the http direction
 * and the session cookie keeps its `__Secure-` prefix, which a browser will not
 * send over http - the panel would be reachable and impossible to log into,
 * which is the exact situation turning HTTPS off is meant to rescue.
 *
 * Set at boot (instrumentation) and again whenever the address or its scheme is
 * written, so it is never staler than the row it mirrors.
 */
let storedBaseUrl: string | null = null;

export function setStoredPublicBaseUrl(url: string | null): void {
  storedBaseUrl = url ? url.replace(/\/+$/, "") : null;
}

/**
 * This instance's address without touching the database: the stored one, else
 * the one it was installed with. Null when neither is known.
 *
 * The stored value wins for the same reason it wins in `instancePublicBaseUrl`:
 * an operator set it in the UI, on purpose, after this instance moved.
 */
export function publicBaseUrl(): string | null {
  if (storedBaseUrl) return storedBaseUrl;
  const configured = process.env.DEPLO_PUBLIC_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

/**
 * Whether a cookie this instance writes may be marked `Secure`.
 *
 * ONE predicate for every cookie deplo sets, because a browser drops a `Secure`
 * cookie on an http page silently: get it wrong for the session cookie and
 * nobody can log in; get it wrong for `deplo_team` and everyone is logged in
 * with no active team, which resolves nothing. Both look like the panel being
 * broken and neither says why.
 *
 * It reads the EFFECTIVE address, so it follows an operator who moved the panel
 * to http from the panel itself, rather than the env var the box booted with.
 */
export function cookiesAreSecure(): boolean {
  return (publicBaseUrl() ?? "").startsWith("https://");
}

export function resolvePublicBaseUrl(h: Headers): string {
  const configured = publicBaseUrl();
  if (configured) return configured;

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
