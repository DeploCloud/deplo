import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { challengeName } from "../../deploy/dns-challenge";
import { nowIso } from "../../ids";
import { authoritativeCname } from "../domains/authoritative-dns";

// A name outside the zone gets its certificate over DNS once its `_acme-challenge` CNAME points into the zone
// (ADR-0049 phase 3): https://deplo.build/docs/operations/clusters/dns-zone

type Lookup = (name: string) => Promise<string[]>;

// Asked where it is written: a resolver keeps a "no such record" from before Deplo wrote it for up to the zone's
// negative TTL, 30 minutes at Cloudflare, and memos waited that long for its certificate (22 Nov 2026).
const lookupCname: Lookup = async (name) => {
  const got = await authoritativeCname(name);
  if (got === null)
    throw Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
  if (got.length === 0)
    throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
  return got;
};

let lookup = lookupCname;
export function __setCnameLookupForTest(fn: Lookup | null): void {
  lookup = fn ?? lookupCname;
}

/** Whether the CNAME points where it should: true, false, or null when DNS gave no answer either way. */
export async function acmeCnameSeen(
  name: string,
  target: string,
): Promise<boolean | null> {
  const want = challengeName(target).toLowerCase();
  try {
    const got = await lookup(challengeName(name));
    return got.some((g) => g.toLowerCase().replace(/\.$/, "") === want);
  } catch (e) {
    const code = (e as { code?: string }).code;
    return code === "ENODATA" || code === "ENOTFOUND" ? false : null;
  }
}

/** Looks each outside name's CNAME up again and keeps when it was seen; an unanswered lookup changes nothing. */
export async function refreshAcmeCnames(
  domains: {
    domainId: string;
    name: string;
    target: string;
    inside: boolean;
    acmeCnameSeenAt: string | null;
  }[],
): Promise<void> {
  for (const d of domains) {
    if (d.inside) continue;
    const seen = await acmeCnameSeen(d.name, d.target);
    if (seen === null || seen === (d.acmeCnameSeenAt != null)) continue;
    d.acmeCnameSeenAt = seen ? nowIso() : null;
    await getDb()
      .update(domainsTable)
      .set({ acmeCnameSeenAt: d.acmeCnameSeenAt })
      .where(eq(domainsTable.id, d.domainId));
  }
}
