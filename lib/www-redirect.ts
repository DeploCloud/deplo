// Which hostname of a `www`/non-`www` pair serves the app, relative to the domain being edited.
export type WwwRedirect = "none" | "toThis" | "toCounterpart";

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

const WILDCARD_DNS_SUFFIXES = [".nip.io", ".sslip.io", ".localhost"];

function clean(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[./]+$/, "");
}

// The other half of a hostname's `www` pair, or null when it has no meaningful one.
export function wwwCounterpart(host: string): string | null {
  const h = clean(host);
  if (!h || h.includes("/") || h.includes(" ")) return null;
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

// A host on public wildcard DNS: it resolves without a record, and no public CA issues for it.
export function isWildcardDnsHost(host: string): boolean {
  return WILDCARD_DNS_SUFFIXES.some((s) => host.endsWith(s));
}

// The WwwRedirect state a domain is currently in, read off the app's rows.
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
