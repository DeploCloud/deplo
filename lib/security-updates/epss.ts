import "server-only";

import { inArray, isNotNull, and } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  epssScores,
  osvAffected,
  securityFindings,
} from "../db/schema/control-plane/security-updates";

const EPSS_API = "https://api.first.org/data/v1/epss";
const PER_CALL = 100;

export interface Epss {
  scoreBp: number;
  percentileBp: number;
}

// FIRST's scores for these CVE ids; only the ids leave Deplo. Throws when FIRST cannot be read.
export async function fetchEpss(cves: string[]): Promise<Map<string, Epss>> {
  const out = new Map<string, Epss>();
  for (let i = 0; i < cves.length; i += PER_CALL) {
    const part = cves.slice(i, i + PER_CALL);
    const res = await fetch(
      `${EPSS_API}?cve=${part.join(",")}&limit=${part.length}`,
      { cache: "no-store", signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`FIRST EPSS answered HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { cve?: string; epss?: string; percentile?: string }[];
    };
    for (const d of body.data ?? []) {
      const score = Number(d.epss);
      const pct = Number(d.percentile);
      if (!d.cve || !Number.isFinite(score) || !Number.isFinite(pct)) continue;
      out.set(d.cve, {
        scoreBp: Math.round(score * 10_000),
        percentileBp: Math.round(pct * 10_000),
      });
    }
  }
  return out;
}

// Score every CVE behind today's findings; run with the daily known-exploited refresh.
export async function refreshEpss(now: Date): Promise<number> {
  const db = getDb();
  const rows = await db
    .selectDistinct({ cve: osvAffected.cve })
    .from(osvAffected)
    .where(
      and(
        isNotNull(osvAffected.cve),
        inArray(
          osvAffected.vulnId,
          db
            .selectDistinct({ id: securityFindings.vulnId })
            .from(securityFindings),
        ),
      ),
    );
  const cves = rows.flatMap((r) => (r.cve ? [r.cve] : []));
  if (cves.length === 0) return 0;
  const scores = await fetchEpss(cves);
  const fetchedAt = now.toISOString();
  for (const [cveId, s] of scores)
    await db
      .insert(epssScores)
      .values({ cveId, ...s, fetchedAt })
      .onConflictDoUpdate({
        target: epssScores.cveId,
        set: { ...s, fetchedAt },
      });
  return scores.size;
}
