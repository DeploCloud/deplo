import "server-only";

// https://deplo.build/docs/operations/panel-address-and-certificates

import { headers } from "next/headers";

// A strict allowlist: a request-derived host ends up in copy-and-run strings (the install
// command), so it is never interpolated raw.
const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
export const PUBLIC_URL_PLACEHOLDER = "https://your-deplo-host";

// On globalThis, not a module-level let: instrumentation, RSC and route handlers are separate module registries.
const BASE_URL_KEY = Symbol.for("deplo.public-url.stored");
const g = globalThis as unknown as { [BASE_URL_KEY]?: string | null };

export function setStoredPublicBaseUrl(url: string | null): void {
  g[BASE_URL_KEY] = url ? url.replace(/\/+$/, "") : null;
}

// publicBaseUrl - the stored address, else the one this instance was installed with.
export function publicBaseUrl(): string | null {
  const stored = g[BASE_URL_KEY];
  if (stored) return stored;
  const configured = process.env.DEPLO_PUBLIC_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : null;
}

export function cookiesAreSecure(): boolean {
  return (publicBaseUrl() ?? "").startsWith("https://");
}

// requestIsHttps - x-forwarded-proto wins, because a proxy is the only thing that knows.
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

// passkeyRelyingParty - a passkey is welded to ONE rpID and the browser refuses any other origin.
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
  // `origin`, not `base`: the plugin compares it against the origin signed into clientDataJSON.
  return { rpId: url.hostname, origin: url.origin };
}

export function resolvePublicBaseUrl(h: Headers): string {
  return publicBaseUrl() ?? requestOrigin(h) ?? PUBLIC_URL_PLACEHOLDER;
}

// requestOrigin - the origin this request came in on, or null when the host is not one.
export function requestOrigin(h: Headers): string | null {
  const rawHost = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  if (!HOST_RE.test(rawHost)) return null;
  return `${sanitizeProto(h.get("x-forwarded-proto"), rawHost)}://${rawHost}`;
}

// resolveManifestBaseUrl - needs an explicit externally-reachable DEPLO_PUBLIC_URL, else the placeholder.
export function resolveManifestBaseUrl(): string {
  const configured = process.env.DEPLO_PUBLIC_URL?.trim();
  if (!configured) return PUBLIC_URL_PLACEHOLDER;
  const base = configured.replace(/\/+$/, "");
  return isLoopback(base) ? PUBLIC_URL_PLACEHOLDER : base;
}

function sanitizeProto(value: string | null, host: string): "https" | "http" {
  if (value === "http" || value === "https") return value;
  return isLoopbackHost(host) ? "http" : "https";
}

function isLoopbackHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return (
    name === "localhost" ||
    name === "::1" ||
    name === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(name)
  );
}

function isLoopback(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).host);
  } catch {
    return false;
  }
}
