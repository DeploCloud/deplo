import "server-only";

import { and, eq } from "drizzle-orm";

import * as cloudflare from "../../cloudflare/tunnel-api";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusterMembers } from "../../db/schema/control-plane/clusters";
import { domainDnsRecords } from "../../db/schema/control-plane/dns-providers";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import {
  ANSWER_RECORD_TTL,
  answerRecordChange,
  answerRecordSet,
  checkAnswerRecords,
  type AnswerRecordSet,
} from "../../deploy/answer-dns";
import { messageOf } from "../../utils";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import { loadProviderSecret } from "../dns-providers/tunnels";
import {
  lookupHostAddresses,
  resolveHostIpv4,
  resolveHostIpv6,
} from "../domains/dns-resolve";
import { withKeyedLock } from "../keyed-mutex";
import { serverAddresses } from "../servers/addresses";
import { getServerById } from "../servers/roster";

// https://deplo.build/docs/operations/clusters/addresses - ADR-0048 step 3: DNS lists every healthy server.

export const ANSWER_RECORD_COMMENT = "Deplo app";

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
    .where(eq(clusterMembers.clusterId, clusterId));
  const servers = await Promise.all(
    members.map(async (m) => {
      const server = await getServerById(m.serverId);
      const addresses = await serverAddresses(server);
      return {
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
  return answerRecordSet(servers);
}

type AnswerDomain = {
  id: string;
  name: string;
  appId: string;
  teamId: string;
  status: string;
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

/** At a connected provider: the name's records become exactly the set; a record Deplo did not write stops it. */
async function syncAtProvider(
  d: AnswerDomain,
  row: { providerId: string; zoneId: string },
  set: AnswerRecordSet,
): Promise<string | null> {
  const provider = await loadProviderSecret(row.providerId);
  if (!provider) return "its DNS provider is no longer connected";
  const existing = await cloudflare.dnsRecords(
    provider.token,
    row.zoneId,
    d.name,
  );
  const change = answerRecordChange(
    existing.map((r) => ({
      id: r.id,
      type: r.type,
      content: r.content,
      ours: r.comment === ANSWER_RECORD_COMMENT,
    })),
    set,
  );
  if (change.foreign)
    return `${d.name} has a ${change.foreign.type} record Deplo did not write (${change.foreign.content}). Delete it at the provider.`;
  for (const c of change.create)
    await cloudflare.createDnsRecord(provider.token, row.zoneId, {
      type: c.type,
      name: d.name,
      content: c.content,
      proxied: false,
      ttl: ANSWER_RECORD_TTL,
      comment: ANSWER_RECORD_COMMENT,
    });
  for (const id of change.remove)
    await cloudflare.deleteDnsRecord(provider.token, row.zoneId, id);
  return null;
}

/** Without a provider: whether the records a person wrote are the set, so the domain says when they must change. */
async function checkByHand(
  d: AnswerDomain,
  set: AnswerRecordSet,
  changed: Set<string>,
): Promise<string | null> {
  const [a, aaaa] = await Promise.all([
    resolveHostIpv4(d.name),
    resolveHostIpv6(d.name),
  ]);
  const check = checkAnswerRecords({ a, aaaa }, set);
  const status = check.status;
  if (status !== d.status) {
    await getDb()
      .update(domainsTable)
      .set({ status, ssl: status === "valid" })
      .where(eq(domainsTable.id, d.id));
    changed.add(d.appId);
  }
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
  if (status !== d.status) {
    await getDb()
      .update(domainsTable)
      .set({ status, ssl: status === "valid" })
      .where(eq(domainsTable.id, d.id));
    changed.add(d.appId);
  }
  if (status === "valid") return null;
  return native.target === d.name
    ? `${d.name} does not reach the cluster yet: delegate ${native.zone} to it where the domain was bought`
    : `${d.name} does not point at the cluster yet: add the CNAME record ${d.name} → ${native.target}`;
}

/**
 * Puts every domain of the cluster that answers on every server on the cluster's healthy servers: written at its
 * connected provider, or checked against what a person wrote. Called when a server joins, leaves, stops or is back.
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
      const [row] = await getDb()
        .select({
          providerId: domainDnsRecords.providerId,
          zoneId: domainDnsRecords.zoneId,
        })
        .from(domainDnsRecords)
        .where(eq(domainDnsRecords.domainId, d.id));
      let problem: string | null;
      try {
        problem = row
          ? await syncAtProvider(d, row, set)
          : await checkByHand(d, set, changed);
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
  // A domain routed or not by its status: its App is routed again, outside the lock, as that may sync the DNS.
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
    const [a, aaaa, members] = await Promise.all([
      resolveHostIpv4(name),
      resolveHostIpv6(name),
      clusterMemberAddresses(clusterId),
    ]);
    return nativeStatus([...a, ...aaaa], members) ?? "pending";
  }
  const [set, a, aaaa] = await Promise.all([
    clusterAnswerRecordSet(clusterId),
    resolveHostIpv4(name),
    resolveHostIpv6(name),
  ]);
  return checkAnswerRecords({ a, aaaa }, set).status;
}

/** Fire-and-forget for a change of the cluster; what called it never waits on, or fails with, DNS. */
export function syncClusterAnswerDnsSoon(clusterId: string): void {
  void syncClusterAnswerDns(clusterId).catch((e) =>
    console.warn(`[answer-dns] ${clusterId}: ${messageOf(e)}`),
  );
  // The cluster's own zone names the same servers, so the same changes move it.
  void import("./dns-zone").then((m) => m.syncClusterZoneSoon(clusterId));
}
