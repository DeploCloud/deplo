import "server-only";

import { and, eq, inArray, notInArray, or } from "drizzle-orm";

import { assertUser } from "../../auth/current-user";
import * as cloudflare from "../../cloudflare/tunnel-api";
import { getDb } from "../../db/client";
import {
  memberships,
  membershipCapabilities,
} from "../../db/schema/control-plane/access-control";
import {
  dnsProviders,
  dnsProviderTeams,
  dnsProviderTunnels,
  domainDnsRecords,
} from "../../db/schema/control-plane/dns-providers";
import { domains } from "../../db/schema/control-plane/domains";
import { zoneCovers } from "../../dns-zone";
import { nowIso } from "../../ids";
import { requireActiveTeamId } from "../../membership";
import { loadAppGraph } from "../app-graph-load";
import { appServerAddresses } from "../domains/dns-check";
import {
  ensureServerTunnel,
  loadProviderSecret,
  syncTunnelIngress,
  type ProviderSecret,
} from "./tunnels";

export interface AutoDnsZone {
  zoneName: string;
  provider: "cloudflare";
}

/** The zones this person may create records in for `teamId`: their own, and ones shared with the team. */
async function usableZones(
  teamId: string,
  userId: string,
): Promise<(AutoDnsZone & { id: string; mine: boolean })[]> {
  const rows = await getDb()
    .select({
      id: dnsProviders.id,
      zoneName: dnsProviders.zoneName,
      provider: dnsProviders.provider,
      ownerId: dnsProviders.userId,
    })
    .from(dnsProviders)
    .innerJoin(
      dnsProviderTeams,
      eq(dnsProviderTeams.providerId, dnsProviders.id),
    )
    .where(
      and(
        eq(dnsProviderTeams.teamId, teamId),
        or(eq(dnsProviders.userId, userId), eq(dnsProviders.shared, true)),
      ),
    );
  if (rows.length === 0) return [];
  // The owner's token only works where the owner still manages domains.
  const owners = await getDb()
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(
      membershipCapabilities,
      eq(membershipCapabilities.membershipId, memberships.id),
    )
    .where(
      and(
        eq(memberships.teamId, teamId),
        inArray(
          memberships.userId,
          rows.map((r) => r.ownerId),
        ),
        eq(membershipCapabilities.capability, "manage_domains"),
      ),
    );
  const active = new Set(owners.map((o) => o.userId));
  return rows
    .filter((r) => active.has(r.ownerId))
    .map((r) => ({
      id: r.id,
      zoneName: r.zoneName,
      provider: r.provider as "cloudflare",
      mine: r.ownerId === userId,
    }));
}

/** What the Domains page offers: the zones whose names get their DNS made for them. */
export async function autoDnsZones(): Promise<AutoDnsZone[]> {
  const teamId = await requireActiveTeamId();
  const user = await assertUser();
  const zones = await usableZones(teamId, user.id);
  return [...new Set(zones.map((z) => z.zoneName))]
    .sort()
    .map((zoneName) => ({ zoneName, provider: "cloudflare" as const }));
}

export async function providerForHostname(
  hostname: string,
  teamId: string,
  userId: string,
): Promise<{ id: string; zoneName: string } | null> {
  const zones = (await usableZones(teamId, userId)).filter((z) =>
    zoneCovers(z.zoneName, hostname),
  );
  zones.sort(
    (a, b) =>
      b.zoneName.length - a.zoneName.length || Number(b.mine) - Number(a.mine),
  );
  return zones[0] ?? null;
}

export interface ProvisionedDns {
  providerId: string;
  zoneId: string;
  recordId: string | null;
  tunnelRowId: string | null;
  // Deplo made the record and may delete it; a record that already pointed here is left alone.
  created: boolean;
}

const RECORD_COMMENT = "Deplo app";

/**
 * Creates the record for `hostname` when one of the person's zones covers it: an address record,
 * or a CNAME to the server's tunnel. Null when no zone covers it. Throws when it should and cannot.
 */
export async function provisionDomainDns(input: {
  appId: string;
  hostname: string;
  teamId: string;
  userId: string;
  tunnel: boolean;
}): Promise<ProvisionedDns | null> {
  const match = await providerForHostname(
    input.hostname,
    input.teamId,
    input.userId,
  );
  if (!match) {
    if (input.tunnel)
      throw new Error(
        `${input.hostname} is not in a domain connected for automatic DNS, so it cannot use a Cloudflare Tunnel`,
      );
    return null;
  }
  const provider = await loadProviderSecret(match.id);
  if (!provider) return null;

  if (!input.tunnel) {
    const targets = await appServerAddresses(input.appId);
    const pointed = await cloudflare.pointAtAddress(
      provider.token,
      provider.zoneId,
      input.hostname,
      { v4: targets.v4[0] ?? null, v6: targets.v6[0] ?? null },
      RECORD_COMMENT,
    );
    return {
      providerId: provider.id,
      zoneId: provider.zoneId,
      recordId: pointed?.id ?? null,
      tunnelRowId: null,
      created: pointed?.created ?? false,
    };
  }

  const app = await loadAppGraph(input.appId);
  if (!app?.serverId)
    throw new Error("This app has no server yet, so it cannot use a tunnel");
  const tunnel = await ensureServerTunnel(
    provider,
    app.serverId,
    input.hostname,
  );
  try {
    const pointed = await cloudflare.pointAtTunnel(
      provider.token,
      provider.zoneId,
      input.hostname,
      tunnel.tunnelId,
      () => false,
      RECORD_COMMENT,
    );
    return {
      providerId: provider.id,
      zoneId: provider.zoneId,
      recordId: pointed.id,
      tunnelRowId: tunnel.id,
      created: pointed.created,
    };
  } catch (e) {
    await syncTunnelIngress(provider, tunnel).catch(() => {});
    throw e;
  }
}

export async function rememberDomainDns(
  domainId: string,
  dns: ProvisionedDns,
): Promise<void> {
  if (!dns.recordId) return;
  await getDb()
    .insert(domainDnsRecords)
    .values({
      domainId,
      providerId: dns.providerId,
      zoneId: dns.zoneId,
      recordId: dns.recordId,
      tunnelId: dns.tunnelRowId,
      created: dns.created,
      createdAt: nowIso(),
    })
    .onConflictDoNothing();
}

/** Takes back a record made by `provisionDomainDns` when the domain it was for was never saved. */
export async function undoProvision(dns: ProvisionedDns): Promise<void> {
  const provider = await loadProviderSecret(dns.providerId).catch(() => null);
  if (!provider) return;
  if (dns.created && dns.recordId)
    await cloudflare
      .deleteDnsRecord(provider.token, dns.zoneId, dns.recordId)
      .catch(() => {});
  if (dns.tunnelRowId) await resyncTunnel(provider, dns.tunnelRowId);
}

type HeldRecord = {
  domainId: string;
  providerId: string;
  zoneId: string;
  recordId: string;
  tunnelId: string | null;
  created: boolean;
  name: string;
};

/**
 * Lets go of the records these domains hold, before the domains go: forgets them, and returns
 * what `deleteReleasedDns` must clean up once they are gone. `names` overrides a renamed domain's old name.
 */
export async function takeDomainDns(
  domainIds: string[],
  names: Record<string, string> = {},
): Promise<HeldRecord[]> {
  if (domainIds.length === 0) return [];
  const rows = await getDb()
    .select({
      domainId: domainDnsRecords.domainId,
      providerId: domainDnsRecords.providerId,
      zoneId: domainDnsRecords.zoneId,
      recordId: domainDnsRecords.recordId,
      tunnelId: domainDnsRecords.tunnelId,
      created: domainDnsRecords.created,
      name: domains.name,
    })
    .from(domainDnsRecords)
    .innerJoin(domains, eq(domains.id, domainDnsRecords.domainId))
    .where(inArray(domainDnsRecords.domainId, domainIds));
  if (rows.length === 0) return [];
  await getDb()
    .delete(domainDnsRecords)
    .where(
      inArray(
        domainDnsRecords.domainId,
        rows.map((r) => r.domainId),
      ),
    );
  return rows.map((r) => ({ ...r, name: names[r.domainId] ?? r.name }));
}

/** All the records of these apps' domains, taken before the apps are deleted. */
export async function takeAppDns(appIds: string[]): Promise<HeldRecord[]> {
  if (appIds.length === 0) return [];
  const ids = await getDb()
    .select({ id: domains.id })
    .from(domains)
    .where(inArray(domains.appId, appIds));
  return takeDomainDns(ids.map((d) => d.id));
}

/**
 * Deletes, in Cloudflare, only records Deplo created. One still answering for a domain that stays
 * is handed to that domain instead. Tunnels drop the names. Best effort: returns what it could not do.
 */
export async function deleteReleasedDns(
  held: HeldRecord[],
): Promise<string | null> {
  const problems: string[] = [];
  const providers = new Map<string, ProviderSecret | null>();
  const tunnels = new Map<string, string>();
  for (const r of held) {
    try {
      if (!providers.has(r.providerId))
        providers.set(r.providerId, await loadProviderSecret(r.providerId));
      const provider = providers.get(r.providerId);
      if (!provider) continue;
      if (r.tunnelId) tunnels.set(r.tunnelId, r.providerId);
      if (!r.created) continue;
      const [heir] = await getDb()
        .select({ id: domains.id })
        .from(domains)
        .where(
          and(
            eq(domains.name, r.name),
            notInArray(
              domains.id,
              held.map((h) => h.domainId),
            ),
          ),
        )
        .limit(1);
      if (heir) {
        await getDb()
          .insert(domainDnsRecords)
          .values({ ...r, domainId: heir.id, createdAt: nowIso() })
          .onConflictDoUpdate({
            target: domainDnsRecords.domainId,
            set: { created: true, recordId: r.recordId },
          });
        continue;
      }
      await cloudflare.deleteDnsRecord(provider.token, r.zoneId, r.recordId);
    } catch (e) {
      problems.push(
        `Cloudflare still has the DNS record for ${r.name}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  for (const [tunnelId, providerId] of tunnels) {
    const provider = providers.get(providerId);
    if (provider) await resyncTunnel(provider, tunnelId);
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

/** After a rename: the old name's record is let go of, and the new one takes its place. */
export async function swapDomainDns(
  domainId: string,
  oldName: string,
  next: ProvisionedDns | null,
): Promise<string | null> {
  const held = await takeDomainDns([domainId], { [domainId]: oldName });
  if (next) await rememberDomainDns(domainId, next);
  const warning = await deleteReleasedDns(held);
  if (next?.tunnelRowId) {
    const provider = await loadProviderSecret(next.providerId).catch(
      () => null,
    );
    if (provider) await resyncTunnel(provider, next.tunnelRowId);
  }
  return warning;
}

async function resyncTunnel(
  provider: ProviderSecret,
  tunnelRowId: string,
): Promise<void> {
  const [t] = await getDb()
    .select({
      id: dnsProviderTunnels.id,
      tunnelId: dnsProviderTunnels.tunnelId,
    })
    .from(dnsProviderTunnels)
    .where(eq(dnsProviderTunnels.id, tunnelRowId));
  if (t) await syncTunnelIngress(provider, t).catch(() => {});
}

/** Which of these domains have a record Deplo manages. */
export async function managedDnsDomainIds(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await getDb()
    .select({ id: domainDnsRecords.domainId })
    .from(domainDnsRecords)
    .where(inArray(domainDnsRecords.domainId, ids));
  return new Set(rows.map((r) => r.id));
}
