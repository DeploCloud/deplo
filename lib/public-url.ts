import "server-only";

// https://deplo.build/docs/operations/panel-address-and-certificates

import { headers } from "next/headers";

/**
 * Resolve the canonical public base URL of this Deplo instance. We never
 * interpolate them raw into shell-bound or copy-and-run strings (the install
 * command).
 */
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
export const PUBLIC_URL_PLACEHOLDER = "https://your-deplo-host";

/**
 * The address stored in `instance_settings`, cached in memory. Set at boot
 * (instrumentation) and again whenever the address or its scheme is written, so it
 * is never staler than the row it mirrors.
 */
let storedBaseUrl: string | null = null;

export function setStoredPublicBaseUrl(url: string | null): void {
  storedBaseUrl = url ? url.replace(/\/+$/, "") : null;
}

/**
 * This instance's address without touching the database: the stored one, else the
 * one it was installed with.
 */
export function publicBaseUrl(): string | null {
  if (storedBaseUrl) return storedBaseUrl;
  const configured = process.env.DEPLO_PUBLIC_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

/**
 * Whether a cookie this instance writes may be marked `Secure`.
 */
export function cookiesAreSecure(): boolean {
  return (publicBaseUrl() ?? "").startsWith("https://");
}

/**
 * Whether THIS request arrived over https, and so whether a cookie it writes may
 * carry `Secure`. `x-forwarded-proto` wins, because a proxy is the only thing that
 * knows.
 */
export async function requestIsHttps(): Promise<boolean> {
  let h: Headers;
  try {
    h = await headers();
  } catch {
    return cookiesAreSecure();
  }
  const forwarded = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (forwarded) return forwarded === "https";
  const base = publicBaseUrl();
  if (!base?.startsWith("https://")) return false;
  try {
    return new URL(base).host === h.get("host");
  } catch {
    return false;
  }
}

/**
 * The WebAuthn relying party this instance registers passkeys for, or null when it
 * cannot have any. A passkey is welded to ONE rpID and the browser refuses the
 * ceremony outright - before any request is sent - from any other origin.
 */
export function passkeyRelyingParty(): { rpId: string; origin: string } | null {
  const base = publicBaseUrl();
  if (!base) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !isLoopbackHost(url.host)) return null;
  // `origin` and not `base`: the plugin compares it against the origin signed
  // into clientDataJSON, which never carries a path or a trailing slash.
  return { rpId: url.hostname, origin: url.origin };
}

export function resolvePublicBaseUrl(h: Headers): string {
  return publicBaseUrl() ?? requestOrigin(h) ?? PUBLIC_URL_PLACEHOLDER;
}

/** The origin this request came in on, or null when the host is not one. */
export function requestOrigin(h: Headers): string | null {
  const rawHost = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  if (!HOST_RE.test(rawHost)) return null;
  return `${sanitizeProto(h.get("x-forwarded-proto"), rawHost)}://${rawHost}`;
}

/**
 * Base URL for the GitHub App manifest. Require an explicit, externally-reachable
 * DEPLO_PUBLIC_URL; otherwise return the placeholder so the caller can surface a
 * clear "set DEPLO_PUBLIC_URL" error.
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
