import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusterMembers } from "../../db/schema/control-plane/clusters";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  answerRecordSet,
  checkAnswerRecords,
  type AnswerRecordSet,
} from "../../deploy/answer-dns";
import { resolvesToCloudflare } from "../../deploy/cloudflare";
import { messageOf } from "../../utils";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import { lookupHostAddresses, resolveAtSource } from "../domains/dns-resolve";
import { withKeyedLock } from "../keyed-mutex";
import { serverAddresses } from "../servers/addresses";
import { oneMemberPerAddress } from "../../clusters/shared-addresses";
import { getServerById } from "../servers/roster";

// https://deplo.build/docs/operations/clusters/addresses - ADR-0048 step 3: DNS lists every healthy server.

// The last problem said per domain, so a sync every minute says it once and again only when it changes.
const said = new Map<string, string>();

/** The records a domain of this cluster that answers on every server must hold now. */
export async function clusterAnswerRecordSet(
  clusterId: string,
): Promise<AnswerRecordSet> {
  const members = await getDb()
    .select({
      serverId: clusterMembers.serverId,
      emptying: clusterMembers.emptyingSince,
      lease: clusterMembers.leaseState,
    })
    .from(clusterMembers)
    .where(eq(clusterMembers.clusterId, clusterId))
    .orderBy(asc(clusterMembers.joinedAt), asc(clusterMembers.serverId));
  const servers = await Promise.all(
    members.map(async (m) => {
      const server = await getServerById(m.serverId);
      const addresses = await serverAddresses(server);
      return {
        name: m.serverId,
        id: m.serverId,
        // The leader's word first: it hears a stopped server before Deplo's own status does.
        online: server?.status === "online" && m.lease === "ok",
        emptying: Boolean(m.emptying),
        v4: addresses.v4,
        v6: addresses.v6,
        known: addresses.v6Known,
      };
    }),
  );
  // One address names one member, the one that joined first (ADR-0050).
  return answerRecordSet(oneMemberPerAddress(servers).members);
}

type AnswerDomain = {
  id: string;
  name: string;
  appId: string;
  teamId: string;
  status: string;
  ssl: boolean;
  zoneId: string | null;
};

async function answeringDomains(clusterId: string): Promise<AnswerDomain[]> {
  const rows = await getDb()
    .select({
      tunnel: domainsTable.tunnel,
      id: domainsTable.id,
      name: domainsTable.name,
      appId: domainsTable.appId,
      teamId: appsTable.teamId,
      status: domainsTable.status,
      ssl: domainsTable.ssl,
      zoneId: domainsTable.dnsZoneId,
    })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(
      and(
        eq(appsTable.clusterId, clusterId),
        eq(domainsTable.answersEverywhere, true),
      ),
    );
  // A domain on the App's tunnel follows by its connector, never by these records.
  return rows.filter((r) => r.tunnel !== true);
}

/**
 * A verdict shows on the domain, and only ever adds a route: a domain that served keeps it whatever the check says,
 * so a lookup that failed or misread never takes it off every server. Only a domain served for the first time reroutes.
 */
async function recordVerdict(
  d: AnswerDomain,
  status: "valid" | "misconfigured" | "pending",
  changed: Set<string>,
): Promise<void> {
  if (status === d.status) return;
  const served = d.ssl || status === "valid";
  await getDb()
    .update(domainsTable)
    .set({ status, ssl: served })
    .where(eq(domainsTable.id, d.id));
  if (served && !d.ssl) changed.add(d.appId);
}

/** Without a provider: whether the records a person wrote are the set, so the domain says when they must change. */
async function checkByHand(
  d: AnswerDomain,
  set: AnswerRecordSet,
  changed: Set<string>,
): Promise<string | null> {
  const found = await resolveAtSource(d.name);
  if (!found) return null;
  const check = checkAnswerRecords(found, set);
  await recordVerdict(d, check.status, changed);
  if (check.missing.length === 0 && check.extra.length === 0) return null;
  const parts = [
    check.missing.length > 0 ? `add ${check.missing.join(", ")}` : "",
    check.extra.length > 0 ? `remove ${check.extra.join(", ")}` : "",
  ].filter(Boolean);
  return `${d.name} must list every server of its cluster that answers: ${parts.join(" and ")}`;
}

/**
 * Whether resolved addresses are the cluster's: every one a member's, at least one. A member away has no IPv6 Deplo
 * knows of while the zone still answers it, so IPv6 is then not judged; null when nothing is left to judge.
 */
export function nativeStatus(
  resolved: string[],
  members: { addresses: Set<string>; v6Known: boolean },
): "valid" | "misconfigured" | "pending" | null {
  if (resolved.length === 0) return "pending";
  const judged = members.v6Known
    ? resolved
    : resolved.filter((a) => !a.includes(":"));
  if (judged.length === 0) return null;
  return judged.every((a) => members.addresses.has(a))
    ? "valid"
    : "misconfigured";
}

/** Answered by the cluster's own zone (ADR-0049): nothing to write, only whether the name reaches the zone yet. */
async function checkNative(
  d: AnswerDomain,
  clusterId: string,
  native: { zone: string; target: string },
  changed: Set<string>,
): Promise<string | null> {
  const { clusterMemberAddresses } = await import("./dns-zone");
  const [found, members] = await Promise.all([
    lookupHostAddresses(d.name),
    clusterMemberAddresses(clusterId),
  ]);
  // A name server that just stopped can make the lookup fail: that says nothing about the delegation.
  if (found === null) return null;
  const status = nativeStatus(found, members);
  if (status === null) return null;
  await recordVerdict(d, status, changed);
  if (status === "valid") return null;
  // Cloudflare proxies a new record by default, and then answers in the cluster's place (ADR-0049).
  if (resolvesToCloudflare(found))
    return `${d.name} reaches Cloudflare, not the cluster: in Cloudflare, set its record to DNS only (grey cloud)`;
  return native.target === d.name
    ? `${d.name} does not reach the cluster yet: delegate ${native.zone} to it where the domain was bought`
    : `${d.name} does not point at the cluster yet: add the CNAME record ${d.name} → ${native.target}`;
}

/**
 * Checks every domain of the cluster that answers on every server: through the cluster's zone, or against the records
 * a person wrote. Called when a server joins, leaves, stops or is back. Under a domain connected for automatic DNS the
 * zone answers (ADR-0049), so Deplo writes no record per server anywhere.
 */
export async function syncClusterAnswerDns(
  clusterId: string,
  reroute: (appId: string) => Promise<unknown> = async (id) =>
    (await import("../../deploy/build/reroute")).rerouteApp(id),
): Promise<void> {
  if (await instanceFrozen()) return;
  const changed = new Set<string>();
  await withKeyedLock(`answer-dns:${clusterId}`, async () => {
    const domains = await answeringDomains(clusterId);
    if (domains.length === 0) return;
    const set = await clusterAnswerRecordSet(clusterId);
    // A set with no server is a cluster Deplo cannot see: the records stay as they are rather than go empty.
    if (set.a.length === 0 && set.aaaa.length === 0) return;
    const { domainNativeZone } = await import("./zone-domains");
    for (const d of domains) {
      const native = await domainNativeZone(clusterId, d);
      if (native) {
        let problem: string | null;
        try {
          problem = await checkNative(d, clusterId, native, changed);
        } catch (e) {
          problem = `Deplo could not check the DNS of ${d.name}: ${messageOf(e)}`;
        }
        if (!problem) said.delete(d.id);
        else if (said.get(d.id) !== problem) {
          said.set(d.id, problem);
          await recordActivity("domain", problem, "Deplo", d.appId, d.teamId);
        }
        continue;
      }
      let problem: string | null;
      try {
        problem = await checkByHand(d, set, changed);
      } catch (e) {
        problem = `Deplo could not update the DNS records of ${d.name}: ${messageOf(e)}`;
      }
      if (!problem) said.delete(d.id);
      else if (said.get(d.id) !== problem) {
        said.set(d.id, problem);
        await recordActivity("domain", problem, "Deplo", d.appId, d.teamId);
      }
    }
  });
  // A domain served for the first time: its App is routed again, outside the lock, as that may sync the DNS.
  for (const appId of changed) {
    if (await instanceFrozen()) return;
    await reroute(appId).catch((e) =>
      console.warn(`[answer-dns] reroute ${appId}: ${messageOf(e)}`),
    );
  }
}

/** A domain that answers on every server is verified against the whole set, not against one server. */
export async function answerDomainStatus(
  name: string,
  clusterId: string,
): Promise<"valid" | "misconfigured" | "pending"> {
  const [row] = await getDb()
    .select({ zoneId: domainsTable.dnsZoneId })
    .from(domainsTable)
    .where(eq(domainsTable.name, name))
    .limit(1);
  const { clusterMemberAddresses } = await import("./dns-zone");
  const { domainNativeZone } = await import("./zone-domains");
  if (
    await domainNativeZone(clusterId, { name, zoneId: row?.zoneId ?? null })
  ) {
    // Asked of the domain's own name servers, then of the zone's, never a cache (decision D, 22 Nov 2026).
    const [found, members] = await Promise.all([
      resolveAtSource(name),
      clusterMemberAddresses(clusterId),
    ]);
    if (!found) return "pending";
    return nativeStatus([...found.a, ...found.aaaa], members) ?? "pending";
  }
  const [set, found] = await Promise.all([
    clusterAnswerRecordSet(clusterId),
    resolveAtSource(name),
  ]);
  if (!found) return "pending";
  return checkAnswerRecords(found, set).status;
}

/** Fire-and-forget for a change of the cluster; what called it never waits on, or fails with, DNS. */
export function syncClusterAnswerDnsSoon(clusterId: string): void {
  void syncClusterAnswerDns(clusterId).catch((e) =>
    console.warn(`[answer-dns] ${clusterId}: ${messageOf(e)}`),
  );
  // The cluster's own zone names the same servers, so the same changes move it.
  void import("./dns-zone").then((m) => m.syncClusterZoneSoon(clusterId));
}
