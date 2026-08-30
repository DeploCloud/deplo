/**
 * The `www` / non-`www` pair of a hostname - the one place that knows which two
 * hostnames are "the same site" and which of them a browser should end up on.
 */

/**
 * Which hostname of a `www`/non-`www` pair serves the app, expressed relative to
 * the domain being edited: - `none`, nothing is paired; only this hostname is
 * routed.
 */
export type WwwRedirect = "none" | "toThis" | "toCounterpart";

/**
 * Two-label public suffixes common enough to be worth knowing, so `example.co.uk`
 * reads as an apex (its `www.` variant is meaningful) while `api.example.com` does
 * not.
 */
const TWO_LABEL_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "me.uk",
  "ac.uk",
  "gov.uk",
  "ltd.uk",
  "plc.uk",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "co.kr",
  "or.kr",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "com.br",
  "net.br",
  "org.br",
  "com.mx",
  "com.ar",
  "com.co",
  "com.pe",
  "com.uy",
  "com.ve",
  "com.ec",
  "com.tr",
  "com.cn",
  "com.tw",
  "com.hk",
  "com.sg",
  "com.my",
  "com.ph",
  "com.pl",
  "com.ua",
  "com.ru",
  "com.es",
  "com.pt",
  "com.gr",
  "co.nz",
  "net.nz",
  "org.nz",
  "co.za",
  "co.in",
  "co.il",
  "co.th",
  "co.id",
  "co.at",
]);

/**
 * Hosts whose `www.` variant is never meaningful: the zero-config wildcard-DNS
 * services Deplo generates its own hostnames on.
 */
const WILDCARD_DNS_SUFFIXES = [".nip.io", ".sslip.io", ".localhost"];

/** Normalise a hostname the way the domain layer stores one: trimmed, lowercase,
 * no scheme, no trailing dot or slash. */
function clean(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[./]+$/, "");
}

/**
 * The other half of a hostname's `www` pair, or null when the hostname has no
 * meaningful one.
 */
export function wwwCounterpart(host: string): string | null {
  const h = clean(host);
  if (!h || h.includes("/") || h.includes(" ")) return null;
  // An IP literal has no www variant.
  if (/^[0-9.]+$/.test(h)) return null;
  if (h.startsWith("www.")) {
    const bare = h.slice(4);
    return bare.split(".").length >= 2 && !isWildcardDnsHost(bare)
      ? bare
      : null;
  }
  if (isWildcardDnsHost(h)) return null;
  const labels = h.split(".");
  const apex =
    labels.length === 2 ||
    (labels.length === 3 && TWO_LABEL_SUFFIXES.has(labels.slice(-2).join(".")));
  return apex ? `www.${h}` : null;
}

function isWildcardDnsHost(host: string): boolean {
  return WILDCARD_DNS_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * The {@link WwwRedirect} state a domain is currently in, read off the app's rows.
 */
export function deriveWwwRedirect(
  host: string,
  domains: { name: string; redirectTo?: string | null }[],
): WwwRedirect {
  const h = clean(host);
  const counterpart = wwwCounterpart(h);
  if (!counterpart) return "none";
  const self = domains.find((d) => clean(d.name) === h);
  if (self && clean(self.redirectTo ?? "") === counterpart)
    return "toCounterpart";
  const other = domains.find((d) => clean(d.name) === counterpart);
  if (other && clean(other.redirectTo ?? "") === h) return "toThis";
  return "none";
}
