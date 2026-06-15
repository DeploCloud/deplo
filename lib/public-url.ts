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

export function resolvePublicBaseUrl(h: Headers): string {
  const configured = process.env.DEPLO_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const proto = sanitizeProto(h.get("x-forwarded-proto"));
  const rawHost = h.get("x-forwarded-host") ?? h.get("host") ?? "";
  if (HOST_RE.test(rawHost)) return `${proto}://${rawHost}`;
  return "https://your-deplo-host";
}

function sanitizeProto(value: string | null): "https" | "http" {
  return value === "http" ? "http" : "https";
}
