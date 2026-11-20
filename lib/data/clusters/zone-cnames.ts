import "server-only";

import { promises as dnsp } from "node:dns";
import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { challengeName } from "../../deploy/dns-challenge";
import { nowIso } from "../../ids";

// A name outside the zone gets its certificate over DNS once its `_acme-challenge` CNAME points into the zone
// (ADR-0049 phase 3): https://deplo.build/docs/operations/clusters/dns-zone

type Lookup = (name: string) => Promise<string[]>;

const lookupCname: Lookup = (name) =>
  Promise.race([
    dnsp.resolveCname(name),
    new Promise<string[]>((_, reject) =>
      setTimeout(() => reject(new Error("ETIMEOUT")), 3000),
    ),
  ]);

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
