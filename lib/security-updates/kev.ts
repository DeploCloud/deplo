const KEV_FEED =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

// CISA's known-exploited CVE ids; throws when the feed cannot be read, so the old list stays.
export async function fetchKevCves(): Promise<string[]> {
  const res = await fetch(KEV_FEED, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`CISA KEV feed answered HTTP ${res.status}`);
  const body = (await res.json()) as { vulnerabilities?: { cveID?: string }[] };
  const ids = (body.vulnerabilities ?? [])
    .map((v) => v.cveID ?? "")
    .filter((id) => id.startsWith("CVE-"));
  if (ids.length === 0) throw new Error("CISA KEV feed is empty");
  return ids;
}
