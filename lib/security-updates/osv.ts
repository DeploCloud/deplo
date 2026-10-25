import { cvss3Tenths } from "./cvss";
import type { OsvQuery } from "./ecosystem";

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
  fixedVersion: string | null;
  cve: string | null;
  severity: Severity | null;
  cvssTenths: number | null;
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

const TEXT_SEVERITY: Record<string, Severity> = {
  critical: "critical",
  high: "high",
  moderate: "medium",
  medium: "medium",
  low: "low",
};

// The severity and score of one record, from the best source it carries.
export function recordSeverity(rec: OsvRecord): {
  severity: Severity | null;
  cvssTenths: number | null;
} {
  const cvssTenths = maxCvssTenths([
    rec.severity,
    ...(rec.affected ?? []).map((a) => a.severity),
  ]);
  if (cvssTenths !== null)
    return { severity: severityOfTenths(cvssTenths), cvssTenths };
  const ghsa = rec.database_specific?.severity;
  if (typeof ghsa === "string" && TEXT_SEVERITY[ghsa.toLowerCase()])
    return { severity: TEXT_SEVERITY[ghsa.toLowerCase()], cvssTenths: null };
  const ubuntu = rec.severity?.find((s) => s.type === "Ubuntu")?.score;
  if (ubuntu && TEXT_SEVERITY[ubuntu.toLowerCase()])
    return { severity: TEXT_SEVERITY[ubuntu.toLowerCase()], cvssTenths: null };
  return { severity: null, cvssTenths: null };
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
  fallback: { severity: Severity | null; cvssTenths: number | null } = {
    severity: null,
    cvssTenths: null,
  },
): OsvAffectedRow[] {
  if (rec.withdrawn) return [];
  const own = recordSeverity(rec);
  const sev = own.severity ? own : fallback;
  const seen = new Set<string>();
  const rows: OsvAffectedRow[] = [];
  for (const a of rec.affected ?? []) {
    const ecosystem = a.package?.ecosystem;
    const name = a.package?.name;
    if (!ecosystem || !name || seen.has(`${ecosystem}\0${name}`)) continue;
    seen.add(`${ecosystem}\0${name}`);
    // ponytail: first fixed event wins; per-ecosystem version order when one record spans release lines.
    const fixed =
      (a.ranges ?? [])
        .filter((r) => r.type !== "GIT")
        .flatMap((r) => r.events ?? [])
        .find((e) => e.fixed)?.fixed ?? null;
    rows.push({
      vulnId: rec.id,
      ecosystem,
      name,
      fixedVersion: fixed,
      cve: recordCve(rec),
      severity: sev.severity,
      cvssTenths: sev.cvssTenths,
      summary: (rec.summary ?? "").slice(0, 300),
      modified: rec.modified ?? "",
    });
  }
  return rows;
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
