import "server-only";

import { eq, or, sql } from "drizzle-orm";

import * as cloudflare from "../../cloudflare/tunnel-api";
import { getDb } from "../../db/client";
import { clusterDnsZones } from "../../db/schema/control-plane/clusters";
import { delegationRecords } from "../../deploy/cluster-zone";
import { challengeName } from "../../deploy/dns-challenge";
import { messageOf } from "../../utils";
import {
  loadProviderSecret,
  type ProviderSecret,
} from "../dns-providers/tunnels";

// A cluster's zone under a domain connected for automatic DNS: Deplo keeps its records in Cloudflare (ADR-0049).
// https://deplo.build/docs/operations/clusters/dns-zone#dns-at-cloudflare

export const ZONE_RECORD_COMMENT = "Deplo cluster zone";
const APP_RECORD_COMMENT = "Deplo app";
const DELEGATION_TTL = 3600;
const ROUTING = ["A", "AAAA", "CNAME"];

/** The first of cluster, cluster-2, ... under the connected zone that no record and no cluster's zone uses. */
export async function freeZoneName(
  provider: ProviderSecret,
  parent: string,
): Promise<string> {
  const records = await cloudflare.zoneDnsRecords(
    provider.token,
    provider.zoneId,
  );
  for (let i = 1; i <= 20; i++) {
    const name = `${i === 1 ? "cluster" : `cluster-${i}`}.${parent}`;
    if (records.some((r) => r.name === name || r.name.endsWith(`.${name}`)))
      continue;
    const [clash] = await getDb()
      .select({ id: clusterDnsZones.id })
      .from(clusterDnsZones)
      .where(
        or(
          eq(clusterDnsZones.name, name),
          sql`${name} like '%.' || ${clusterDnsZones.name}`,
          sql`${clusterDnsZones.name} like '%.' || ${name}`,
        ),
      )
      .limit(1);
    if (!clash) return name;
  }
  throw new Error(
    `Every name from cluster to cluster-20 under ${parent} is already used. Add the cluster's DNS zone in its settings with a name of your own.`,
  );
}

const nsNames = (zone: string) => [1, 2, 3, 4].map((i) => `ns${i}.${zone}`);

/**
 * Makes the zone's NS and glue in Cloudflare exactly what the name servers are now. A set with no server leaves them
 * as they are: the cluster is out of sight, not gone. Returns what it could not do, in the person's words.
 */
export async function syncZoneDelegation(
  zone: { name: string; providerId: string | null },
  nameServers: { v4: string[]; v6: string[] }[],
): Promise<string | null> {
  if (!zone.providerId || nameServers.length === 0) return null;
  const provider = await loadProviderSecret(zone.providerId).catch(() => null);
  if (!provider)
    return `The Cloudflare connection that held ${zone.name}'s records is gone: add them by hand, as its records list them.`;
  const want = delegationRecords(zone.name, nameServers);
  try {
    for (const name of [zone.name, ...nsNames(zone.name)]) {
      const existing = await cloudflare.dnsRecords(
        provider.token,
        provider.zoneId,
        name,
      );
      const ours = existing.filter((r) => r.comment === ZONE_RECORD_COMMENT);
      const foreign = existing.find(
        (r) =>
          r.comment !== ZONE_RECORD_COMMENT &&
          ["NS", ...ROUTING].includes(r.type),
      );
      if (foreign)
        return `${name} has a ${foreign.type} record in Cloudflare that Deplo did not write (${foreign.content}). Delete it there.`;
      const here = want.filter((w) => w.name === name);
      for (const w of here)
        if (!ours.some((r) => r.type === w.type && r.content === w.value))
          await cloudflare.createDnsRecord(provider.token, provider.zoneId, {
            type: w.type,
            name,
            content: w.value,
            ...(w.type === "NS" ? {} : { proxied: false }),
            ttl: DELEGATION_TTL,
            comment: ZONE_RECORD_COMMENT,
          });
      for (const r of ours)
        if (!here.some((w) => w.type === r.type && w.value === r.content))
          await cloudflare.deleteDnsRecord(
            provider.token,
            provider.zoneId,
            r.id,
          );
    }
  } catch (e) {
    return `Deplo could not update ${zone.name}'s records in Cloudflare: ${messageOf(e)}`;
  }
  return null;
}

/** Takes the zone's NS and glue back out of Cloudflare, when the zone leaves its cluster. */
export async function dropZoneDelegation(zone: {
  name: string;
  providerId: string | null;
}): Promise<void> {
  if (!zone.providerId) return;
  const provider = await loadProviderSecret(zone.providerId).catch(() => null);
  if (!provider) return;
  for (const name of [zone.name, ...nsNames(zone.name)])
    for (const r of await cloudflare.dnsRecords(
      provider.token,
      provider.zoneId,
      name,
    ))
      if (r.comment === ZONE_RECORD_COMMENT)
        await cloudflare.deleteDnsRecord(provider.token, provider.zoneId, r.id);
}

export type ZoneCnames = { recordId: string; acmeRecordId: string | null };

/**
 * Points a domain at its name in the zone, DNS only: the CNAME, and the `_acme-challenge` one so its certificate is
 * checked through the zone. Replaces only what Deplo wrote there (`replace`, or its comment); refuses anyone else's.
 */
export async function pointDomainAtZone(
  provider: ProviderSecret,
  name: string,
  target: string,
  replace: string[] = [],
): Promise<ZoneCnames> {
  const existing = await cloudflare.dnsRecords(
    provider.token,
    provider.zoneId,
    name,
  );
  const routing = existing.filter((r) => ROUTING.includes(r.type));
  const ours = (r: cloudflare.DnsRecord) =>
    replace.includes(r.id) || r.comment === APP_RECORD_COMMENT;
  const kept = routing.find(
    (r) => r.type === "CNAME" && r.content === target && r.proxied !== true,
  );
  const foreign = routing.find((r) => r !== kept && !ours(r));
  if (foreign)
    throw new Error(
      `${name} already has a ${foreign.type} record in Cloudflare (${foreign.content}). Delete it there, or pick another name.`,
    );
  const gone = routing.filter((r) => r !== kept);
  for (const r of gone)
    await cloudflare.deleteDnsRecord(provider.token, provider.zoneId, r.id);
  let recordId = kept?.id;
  try {
    recordId ??= await cloudflare.createDnsRecord(
      provider.token,
      provider.zoneId,
      {
        type: "CNAME",
        name,
        content: target,
        proxied: false,
        ttl: 1,
        comment: APP_RECORD_COMMENT,
      },
    );
  } catch (e) {
    await cloudflare.restoreDnsRecords(provider.token, provider.zoneId, gone);
    throw e;
  }
  return {
    recordId,
    acmeRecordId: await pointAcmeAtZone(provider, name, target),
  };
}

/** The `_acme-challenge` CNAME, unless something of someone else's is there: then HTTP checks, as before. */
async function pointAcmeAtZone(
  provider: ProviderSecret,
  name: string,
  target: string,
): Promise<string | null> {
  const at = challengeName(name);
  const want = challengeName(target);
  const existing = await cloudflare.dnsRecords(
    provider.token,
    provider.zoneId,
    at,
  );
  const kept = existing.find((r) => r.type === "CNAME" && r.content === want);
  if (kept) return kept.id;
  if (existing.some((r) => r.comment !== APP_RECORD_COMMENT)) return null;
  for (const r of existing)
    await cloudflare.deleteDnsRecord(provider.token, provider.zoneId, r.id);
  return cloudflare.createDnsRecord(provider.token, provider.zoneId, {
    type: "CNAME",
    name: at,
    content: want,
    proxied: false,
    ttl: 1,
    comment: APP_RECORD_COMMENT,
  });
}
