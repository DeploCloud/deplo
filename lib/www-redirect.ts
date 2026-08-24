/**
 * The `www` / non-`www` pair of a hostname — the one place that knows which two
 * hostnames are "the same site" and which of them a browser should end up on.
 *
 * Pure and dependency-free on purpose: the data layer writes the redirect with
 * it, and the domain dialogs (client components) spell the two hostnames out in
 * their own labels with the SAME rules, so the option a user reads is exactly
 * the row the server will write.
 *
 * Deplo models the redirect as a second Domain row, not as a hidden flag: the
 * counterpart hostname has its own DNS record, its own certificate and its own
 * verification state, and pretending otherwise is what makes a `www` redirect
 * fail silently on every other platform (an unresolvable `www` host dragged into
 * the SAME router poisons the certificate order for the host that DOES work).
 * See {@link WwwRedirect} for the three states a user can pick.
 */

/**
 * Which hostname of a `www`/non-`www` pair serves the app, expressed relative to
 * the domain being edited:
 *
 *  - `none`           — nothing is paired; only this hostname is routed.
 *  - `toThis`         — the counterpart redirects HERE (this domain serves the
 *                       app). Adding `example.com` and picking this is the
 *                       classic "redirect www to non-www".
 *  - `toCounterpart`  — this hostname redirects to its counterpart, which serves
 *                       the app instead ("redirect non-www to www" when the
 *                       domain being edited is the bare host).
 *
 * The state is DERIVED from the rows themselves ({@link deriveWwwRedirect}),
 * never stored twice: the only stored fact is a domain's `redirectTo`.
 */
export type WwwRedirect = "none" | "toThis" | "toCounterpart";

/** Two-label public suffixes common enough to be worth knowing, so
 * `example.co.uk` reads as an apex (its `www.` variant is meaningful) while
 * `api.example.com` does not. Not the full Public Suffix List — this only
 * decides whether an ADVANCED option is offered, never whether a domain works,
 * so an unlisted suffix costs the user one manually-added domain, not a
 * failure. */
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

/** Hosts whose `www.` variant is never meaningful: the zero-config wildcard-DNS
 * services Deplo generates its own hostnames on. `www.<anything>.nip.io` would
 * resolve (nip.io answers any label) but points at the same IP for a name nobody
 * asked for. */
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
 *
 *   `www.example.com`  → `example.com`
 *   `example.com`      → `www.example.com`
 *   `example.co.uk`    → `www.example.co.uk`
 *   `api.example.com`  → null   (already a subdomain — `www.api.…` is nobody's site)
 *   `x-y-7f000001.nip.io` → null   (a generated zero-config host)
 *
 * Deliberately conservative in the non-`www` direction and permissive in the
 * `www` one: stripping a leading `www.` is unambiguous, while ADDING one to an
 * arbitrary subdomain would offer an option that means nothing.
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
 * The {@link WwwRedirect} state a domain is currently in, read off the app's
 * rows. `domains` is every domain of the SAME app (the edited row may be in it;
 * it is matched by name, so passing it is harmless).
 *
 * Derived, never stored: a user who deletes the counterpart row by hand, or adds
 * one themselves, gets the truthful state on the next read instead of a stored
 * flag that quietly disagrees with the routing.
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
