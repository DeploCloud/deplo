import { createHash } from "node:crypto";

export type LogoKind = "app" | "database";

/** The hash a logo's URL carries, so the browser keeps it until the image itself changes. */
export function logoVersion(logo: string): string {
  return createHash("sha256").update(logo).digest("base64url").slice(0, 16);
}

/** What a page hands the browser for a logo: an uploaded image as a cached URL, any other value as it is. */
export function logoSrc(
  kind: LogoKind,
  id: string,
  logo: string | null | undefined,
): string | null {
  if (!logo) return null;
  if (!logo.startsWith("data:")) return logo;
  return `/api/logo/${kind}/${encodeURIComponent(id)}?v=${logoVersion(logo)}`;
}

/** The same rows with every logo turned into what the browser should load. */
export function withLogoSrc<T extends { id: string; logo?: string | null }>(
  kind: LogoKind,
  rows: readonly T[],
): T[] {
  return rows.map((r) => ({ ...r, logo: logoSrc(kind, r.id, r.logo) }));
}
