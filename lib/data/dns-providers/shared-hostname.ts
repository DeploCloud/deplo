import "server-only";

import { and, asc, eq, ne, sql } from "drizzle-orm";

import { TUNNEL_TARGET_SUFFIX } from "../../cloudflare/tunnel-api";
import { getDb } from "../../db/client";
import {
  appTunnels,
  dnsProviderTunnels,
  domainDnsRecords,
} from "../../db/schema/control-plane/dns-providers";
import { domains } from "../../db/schema/control-plane/domains";
import { servers } from "../../db/schema/control-plane/servers";

// Several Apps may answer on one hostname, each on a path of it, but the hostname has one DNS record and so one
// tunnel. It goes where the App on the whole host runs (else the oldest); the other paths are served from there.

/** The domain a hostname's DNS follows: the one on the whole host, else the oldest. */
export async function hostnameOwner(
  name: string,
): Promise<{ id: string; appId: string } | null> {
  const [row] = await getDb()
    .select({ id: domains.id, appId: domains.appId })
    .from(domains)
    .where(eq(domains.name, name))
    .orderBy(
      sql`case when coalesce(${domains.pathPrefix}, '') = '' then 0 else 1 end`,
      asc(domains.createdAt),
      asc(domains.id),
    )
    .limit(1);
  return row ?? null;
}

/** Another App's domain on this hostname that already holds its record: a new path rides on it. */
export async function recordOfAnotherApp(
  name: string,
  appId: string,
): Promise<{
  providerId: string;
  zoneId: string;
  recordId: string;
  tunnelId: string | null;
} | null> {
  const [row] = await getDb()
    .select({
      providerId: domainDnsRecords.providerId,
      zoneId: domainDnsRecords.zoneId,
      recordId: domainDnsRecords.recordId,
      tunnelId: domainDnsRecords.tunnelId,
    })
    .from(domainDnsRecords)
    .innerJoin(domains, eq(domains.id, domainDnsRecords.domainId))
    .where(and(eq(domains.name, name), ne(domains.appId, appId)))
    .limit(1);
  return row ?? null;
}

/** What a record Deplo may replace points at: a server of this Deplo, or one of its tunnels. */
export async function deploRecordTargets(): Promise<Set<string>> {
  const [hosts, serverTunnels, ownTunnels] = await Promise.all([
    getDb().select({ ip: servers.ip, host: servers.host }).from(servers),
    getDb()
      .select({ tunnelId: dnsProviderTunnels.tunnelId })
      .from(dnsProviderTunnels),
    getDb().select({ tunnelId: appTunnels.tunnelId }).from(appTunnels),
  ]);
  return new Set(
    [
      ...hosts.flatMap((h) => [h.ip, h.host]),
      ...[...serverTunnels, ...ownTunnels].map(
        (t) => `${t.tunnelId}${TUNNEL_TARGET_SUFFIX}`,
      ),
    ]
      .filter(Boolean)
      .map((v) => v!.toLowerCase()),
  );
}

/**
 * After the owner's record moved: every other domain on its hostname holds the same record and is served the same
 * way. Returns the server tunnels they pointed at before, whose ingress drops the name, and the Apps whose routes
 * changed. A record one of them made and still holds stays theirs to delete.
 */
export async function alignSharedRecords(
  ownerId: string,
): Promise<{ oldTunnels: string[]; rerouteApps: string[] }> {
  const [owner] = await getDb()
    .select({
      name: domains.name,
      tunnel: domains.tunnel,
      proxied: domains.proxied,
      ssl: domains.ssl,
      status: domains.status,
      certProvider: domains.certProvider,
      providerId: domainDnsRecords.providerId,
      zoneId: domainDnsRecords.zoneId,
      recordId: domainDnsRecords.recordId,
      tunnelId: domainDnsRecords.tunnelId,
    })
    .from(domains)
    .innerJoin(domainDnsRecords, eq(domainDnsRecords.domainId, domains.id))
    .where(eq(domains.id, ownerId));
  if (!owner) return { oldTunnels: [], rerouteApps: [] };
  const others = await getDb()
    .select({
      id: domains.id,
      appId: domains.appId,
      tunnel: domains.tunnel,
      recordId: domainDnsRecords.recordId,
      tunnelId: domainDnsRecords.tunnelId,
      created: domainDnsRecords.created,
    })
    .from(domains)
    .leftJoin(domainDnsRecords, eq(domainDnsRecords.domainId, domains.id))
    .where(and(eq(domains.name, owner.name), ne(domains.id, ownerId)));
  const oldTunnels = new Set<string>();
  const rerouteApps = new Set<string>();
  for (const d of others) {
    if (d.recordId !== null) {
      if (d.tunnelId && d.tunnelId !== owner.tunnelId)
        oldTunnels.add(d.tunnelId);
      await getDb()
        .update(domainDnsRecords)
        .set({
          providerId: owner.providerId,
          zoneId: owner.zoneId,
          recordId: owner.recordId,
          tunnelId: owner.tunnelId,
          created: d.recordId === owner.recordId ? d.created : false,
        })
        .where(eq(domainDnsRecords.domainId, d.id));
    }
    if ((d.tunnel === true) === (owner.tunnel === true)) continue;
    await getDb()
      .update(domains)
      .set(
        owner.tunnel
          ? {
              tunnel: true,
              proxied: true,
              ssl: true,
              certProvider: "cloudflare",
              entrypoint: null,
            }
          : {
              tunnel: null,
              proxied: owner.proxied,
              ssl: owner.ssl,
              status: owner.status,
              certProvider: owner.certProvider,
              entrypoint: null,
            },
      )
      .where(eq(domains.id, d.id));
    rerouteApps.add(d.appId);
  }
  return { oldTunnels: [...oldTunnels], rerouteApps: [...rerouteApps] };
}
