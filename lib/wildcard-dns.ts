// Wildcard DNS: <anything>-<ipv4 in hex>.<zone> resolves to that IP, nothing to set up.
// Deplo mints only the first; the others still answer, so names minted before it keep working.
export const WILDCARD_DOMAIN = "deplo.site";
export const LEGACY_WILDCARD_DOMAINS = ["nip.io", "sslip.io"] as const;

export const WILDCARD_SUFFIXES: readonly string[] = [
  WILDCARD_DOMAIN,
  ...LEGACY_WILDCARD_DOMAINS,
];

export function wildcardSuffixGroup(): string {
  return `(${WILDCARD_SUFFIXES.map((s) => s.replace(/\./g, "\\.")).join("|")})`;
}
