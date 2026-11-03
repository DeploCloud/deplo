import { cvss3Tenths } from "./cvss";
import type { OsvQuery } from "./ecosystem";
import { rangesOf, type AffectedRange } from "./versions";

const OSV_API = "https://api.osv.dev/v1";
const BATCH = 1000;

export type Severity = "critical" | "high" | "medium" | "low";

export interface OsvHit {
  id: string;
  modified: string;
}

// One affected package of one OSV record: what security_findings are built from.
export interface OsvAffectedRow {
  vulnId: string;
  ecosystem: string;
  name: string;
  // Every release line it covers; fixedFor picks the installed one's fix.
  ranges: AffectedRange[];
  cve: string | null;
  severity: Severity | null;
  cvssTenths: number | null;
  // It needs the package set up a certain way: a conditional critical is listed as high.
  conditional: boolean;
  summary: string;
  modified: string;
}

interface OsvSeverity {
  type?: string;
  score?: string;
}

export interface OsvRecord {
  id: string;
  modified?: string;
  withdrawn?: string;
  aliases?: string[];
  upstream?: string[];
  summary?: string;
  severity?: OsvSeverity[];
  database_specific?: { severity?: unknown };
  affected?: {
    package?: { ecosystem?: string; name?: string };
    severity?: OsvSeverity[];
    ranges?: { type?: string; events?: Record<string, string>[] }[];
  }[];
}

export class OsvUnavailableError extends Error {}

async function osvFetch(path: string, init: RequestInit, timeoutMs: number) {
  let res: Response;
  try {
    res = await fetch(`${OSV_API}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new OsvUnavailableError(
      `OSV.dev did not answer: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return res;
}

// The vulnerabilities OSV lists for each query, in the queries' order.
export async function osvQueryBatch(queries: OsvQuery[]): Promise<OsvHit[][]> {
  const out: OsvHit[][] = queries.map(() => []);
  for (let start = 0; start < queries.length; start += BATCH) {
    let pending = queries
      .slice(start, start + BATCH)
      .map((q, i) => ({ q, at: start + i, token: "" }));
    while (pending.length) {
      const res = await osvFetch(
        "/querybatch",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            queries: pending.map(({ q, token }) => ({
              package: { ecosystem: q.ecosystem, name: q.name },
              version: q.version,
              ...(token ? { page_token: token } : {}),
            })),
          }),
        },
        30_000,
      );
      if (!res.ok)
        throw new OsvUnavailableError(`OSV.dev answered HTTP ${res.status}`);
      const body = (await res.json()) as {
        results?: { vulns?: OsvHit[]; next_page_token?: string }[];
      };
      const results = body.results ?? [];
      const next: typeof pending = [];
      pending.forEach((p, i) => {
        const r = results[i];
        for (const v of r?.vulns ?? []) out[p.at].push(v);
        if (r?.next_page_token) next.push({ ...p, token: r.next_page_token });
      });
      pending = next;
    }
  }
  return out;
}

export async function osvVuln(id: string): Promise<OsvRecord | null> {
  const res = await osvFetch(
    `/vulns/${encodeURIComponent(id)}`,
    { method: "GET" },
    10_000,
  );
  if (res.status === 404) return null;
  if (!res.ok)
    throw new OsvUnavailableError(`OSV.dev answered HTTP ${res.status}`);
  return (await res.json()) as OsvRecord;
}

export function severityOfTenths(tenths: number): Severity | null {
  if (tenths >= 90) return "critical";
  if (tenths >= 70) return "high";
  if (tenths >= 40) return "medium";
  return tenths > 0 ? "low" : null;
}

function maxCvssTenths(lists: (OsvSeverity[] | undefined)[]): number | null {
  let best: number | null = null;
  for (const s of lists.flat()) {
    if (s?.type !== "CVSS_V3" || !s.score) continue;
    const t = cvss3Tenths(s.score);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

// AC:H, in CVSS 3 or 4: the flaw needs conditions the attacker does not control. CVSS 4's AT:P
// alone does not count: it often names something as common as glibc.
export function vectorConditional(vector: string): boolean | null {
  if (!/^CVSS:(3\.[01]|4\.0)\//.test(vector)) return null;
  const m = Object.fromEntries(vector.split("/").map((p) => p.split(":")));
  return m.AC ? m.AC === "H" : null;
}

// Conditional only when every vector the record carries says so; null when it carries none.
function recordConditional(lists: (OsvSeverity[] | undefined)[]) {
  const said = lists
    .flat()
    .flatMap((s) => (s?.score ? [vectorConditional(s.score)] : []))
    .filter((c): c is boolean => c !== null);
  return said.length ? said.every(Boolean) : null;
}

export interface RecordSeverity {
  severity: Severity | null;
  cvssTenths: number | null;
  conditional: boolean | null;
}

const TEXT_SEVERITY: Record<string, Severity> = {
  critical: "critical",
  high: "high",
  moderate: "medium",
  medium: "medium",
  low: "low",
};

// The severity and score of one record, from the best source it carries.
export function recordSeverity(rec: OsvRecord): RecordSeverity {
  const lists = [rec.severity, ...(rec.affected ?? []).map((a) => a.severity)];
  const conditional = recordConditional(lists);
  const cvssTenths = maxCvssTenths(lists);
  if (cvssTenths !== null)
    return { severity: severityOfTenths(cvssTenths), cvssTenths, conditional };
  const text = (s: string) => ({
    severity: TEXT_SEVERITY[s.toLowerCase()],
    cvssTenths: null,
    conditional,
  });
  const ghsa = rec.database_specific?.severity;
  if (typeof ghsa === "string" && TEXT_SEVERITY[ghsa.toLowerCase()])
    return text(ghsa);
  const ubuntu = rec.severity?.find((s) => s.type === "Ubuntu")?.score;
  if (ubuntu && TEXT_SEVERITY[ubuntu.toLowerCase()]) return text(ubuntu);
  return { severity: null, cvssTenths: null, conditional };
}

export function recordCve(rec: OsvRecord): string | null {
  return (
    [rec.id, ...(rec.aliases ?? []), ...(rec.upstream ?? [])].find((a) =>
      a.startsWith("CVE-"),
    ) ?? null
  );
}

// One row per affected package; `fallback` is the severity of the record's CVE when it has none.
export function osvAffectedRows(
  rec: OsvRecord,
  fallback: RecordSeverity = {
    severity: null,
    cvssTenths: null,
    conditional: null,
  },
): OsvAffectedRow[] {
  if (rec.withdrawn) return [];
  const own = recordSeverity(rec);
  const sev = own.severity ? own : fallback;
  const conditional = own.conditional ?? fallback.conditional ?? false;
  const rows = new Map<string, OsvAffectedRow>();
  for (const a of rec.affected ?? []) {
    const ecosystem = a.package?.ecosystem;
    const name = a.package?.name;
    if (!ecosystem || !name) continue;
    const ranges = (a.ranges ?? [])
      .filter((r) => r.type !== "GIT")
      .flatMap((r) => rangesOf(r.events ?? []));
    // One package named twice (one entry per release line) keeps every line.
    const known = rows.get(`${ecosystem}\0${name}`);
    if (known) {
      known.ranges.push(...ranges);
      continue;
    }
    rows.set(`${ecosystem}\0${name}`, {
      vulnId: rec.id,
      ecosystem,
      name,
      ranges,
      cve: recordCve(rec),
      severity: sev.severity,
      cvssTenths: sev.cvssTenths,
      conditional,
      summary: (rec.summary ?? "").slice(0, 300),
      modified: rec.modified ?? "",
    });
  }
  return [...rows.values()];
}

// The affected row a query's ecosystem matches: OSV may qualify it further ("Ubuntu:24.04:LTS").
export function affectedFor<T extends { ecosystem: string; name: string }>(
  rows: T[],
  ecosystem: string,
  name: string,
): T | undefined {
  return (
    rows.find((r) => r.ecosystem === ecosystem && r.name === name) ??
    rows.find((r) => r.name === name && r.ecosystem.startsWith(`${ecosystem}:`))
  );
}
