import "server-only";

import { randomBytes } from "node:crypto";

import { and, eq } from "drizzle-orm";

import * as cloudflare from "../../cloudflare/tunnel-api";
import { decryptSecretOrThrow } from "../../crypto";
import { getDb } from "../../db/client";
import {
  dnsProviders,
  dnsProviderTunnels,
  domainDnsRecords,
} from "../../db/schema/control-plane/dns-providers";
import { domains } from "../../db/schema/control-plane/domains";
import { servers } from "../../db/schema/control-plane/servers";
import {
  appTunnelIngress,
  appTunnelService,
  hasTunnelConnector,
  withTunnelConnector,
} from "../../deploy/panel-tunnel-stack";
import { newId, nowIso } from "../../ids";

const NO_PROXY =
  "Deplo did not install the proxy on this server, so it cannot run a Cloudflare Tunnel there.";

export interface ProviderSecret {
  id: string;
  zoneId: string;
  accountId: string;
  token: string;
}

export async function loadProviderSecret(
  providerId: string,
): Promise<ProviderSecret | null> {
  const [row] = await getDb()
    .select({
      id: dnsProviders.id,
      zoneId: dnsProviders.zoneId,
      accountId: dnsProviders.accountId,
      apiTokenEnc: dnsProviders.apiTokenEnc,
    })
    .from(dnsProviders)
    .where(eq(dnsProviders.id, providerId));
  if (!row) return null;
  return {
    id: row.id,
    zoneId: row.zoneId,
    accountId: row.accountId,
    token: decryptSecretOrThrow(row.apiTokenEnc, "the Cloudflare API token"),
  };
}

/** Every hostname Deplo serves through this tunnel, plus `extra` while one is being added. */
async function tunnelHostnames(
  tunnelRowId: string,
  extra: string[] = [],
  without: string[] = [],
): Promise<string[]> {
  const rows = await getDb()
    .select({ domainId: domains.id, name: domains.name })
    .from(domainDnsRecords)
    .innerJoin(domains, eq(domains.id, domainDnsRecords.domainId))
    .where(eq(domainDnsRecords.tunnelId, tunnelRowId));
  return [
    ...rows.filter((r) => !without.includes(r.domainId)).map((r) => r.name),
    ...extra,
  ];
}

export async function syncTunnelIngress(
  provider: ProviderSecret,
  tunnel: { id: string; tunnelId: string },
  opts: { extra?: string[]; without?: string[] } = {},
): Promise<void> {
  await cloudflare.setTunnelIngress(
    provider.token,
    provider.accountId,
    tunnel.tunnelId,
    appTunnelIngress(
      await tunnelHostnames(tunnel.id, opts.extra, opts.without),
    ),
  );
}

/**
 * The provider's tunnel on this server, created on first use, with `hostname` in its ingress and
 * its connector running beside the server's proxy. The connector is put back if the stack lost it.
 */
export async function ensureServerTunnel(
  provider: ProviderSecret,
  serverId: string,
  hostname: string,
): Promise<{ id: string; tunnelId: string; created: boolean }> {
  const { fetchHostInfo, withTraefikStackLock, applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");
  return withTraefikStackLock(serverId, async () => {
    const [row] = await getDb()
      .select({
        id: dnsProviderTunnels.id,
        tunnelId: dnsProviderTunnels.tunnelId,
      })
      .from(dnsProviderTunnels)
      .where(
        and(
          eq(dnsProviderTunnels.providerId, provider.id),
          eq(dnsProviderTunnels.serverId, serverId),
        ),
      );
    const yaml = (await fetchHostInfo(serverId)).traefikComposeYaml;
    if (!yaml) throw new Error(NO_PROXY);

    let tunnel = row ?? null;
    let created = false;
    if (!tunnel) {
      const [server] = await getDb()
        .select({ name: servers.name })
        .from(servers)
        .where(eq(servers.id, serverId));
      const tunnelId = await cloudflare.createTunnel(
        provider.token,
        provider.accountId,
        tunnelName(server?.name ?? serverId),
      );
      tunnel = { id: newId("dnst"), tunnelId };
      created = true;
    }

    try {
      await syncTunnelIngress(provider, tunnel, { extra: [hostname] });
      const service = appTunnelService(provider.id);
      if (created || !hasTunnelConnector(yaml, service)) {
        const connector = await cloudflare.tunnelToken(
          provider.token,
          provider.accountId,
          tunnel.tunnelId,
        );
        const res = await applyTraefikConfig(serverId, {
          composeYaml: withTunnelConnector(yaml, service, connector),
        });
        if (!res.ok)
          throw new Error(
            res.error || "The proxy on this server refused the change",
          );
      }
      if (created)
        await getDb().insert(dnsProviderTunnels).values({
          id: tunnel.id,
          providerId: provider.id,
          serverId,
          tunnelId: tunnel.tunnelId,
          createdAt: nowIso(),
        });
    } catch (e) {
      if (created)
        await cloudflare
          .deleteTunnel(provider.token, provider.accountId, tunnel.tunnelId)
          .catch(() => {});
      throw e;
    }
    return { ...tunnel, created };
  });
}

/** Tears down every tunnel of a provider that is being disconnected; best effort, says what it left. */
export async function retireProviderTunnels(
  providerId: string,
): Promise<string | null> {
  const tunnels = await getDb()
    .select({
      id: dnsProviderTunnels.id,
      serverId: dnsProviderTunnels.serverId,
      tunnelId: dnsProviderTunnels.tunnelId,
    })
    .from(dnsProviderTunnels)
    .where(eq(dnsProviderTunnels.providerId, providerId));
  if (tunnels.length === 0) return null;
  const provider = await loadProviderSecret(providerId).catch(() => null);
  const problems: string[] = [];
  const { fetchHostInfo, withTraefikStackLock, applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");

  for (const t of tunnels) {
    try {
      await withTraefikStackLock(t.serverId, async () => {
        const yaml = (await fetchHostInfo(t.serverId)).traefikComposeYaml;
        const service = appTunnelService(providerId);
        if (yaml && hasTunnelConnector(yaml, service)) {
          const res = await applyTraefikConfig(t.serverId, {
            composeYaml: withTunnelConnector(yaml, service, null),
          });
          if (!res.ok) throw new Error(res.error || "the proxy refused it");
        }
      });
    } catch (e) {
      problems.push(`a server still runs its connector: ${messageOf(e)}`);
    }
    if (!provider) continue;
    try {
      const records = await getDb()
        .select({
          zoneId: domainDnsRecords.zoneId,
          recordId: domainDnsRecords.recordId,
        })
        .from(domainDnsRecords)
        .where(
          and(
            eq(domainDnsRecords.tunnelId, t.id),
            eq(domainDnsRecords.created, true),
          ),
        );
      for (const r of records)
        await cloudflare.deleteDnsRecord(provider.token, r.zoneId, r.recordId);
      await cloudflare.deleteTunnel(
        provider.token,
        provider.accountId,
        t.tunnelId,
      );
    } catch (e) {
      problems.push(`Cloudflare still has a tunnel: ${messageOf(e)}`);
    }
  }
  if (!provider) problems.push("Deplo could not open the saved API token");
  return problems.length > 0
    ? `${problems.join("; ")}. Delete it there.`
    : null;
}

/**
 * Puts back every tunnel connector a server's proxy stack lost, e.g. to a Deplo update that
 * rewrote it. Returns how many it restored; a server that does not answer is tried next time.
 */
export async function restoreTunnelConnectors(): Promise<number> {
  const rows = await getDb()
    .select({
      providerId: dnsProviderTunnels.providerId,
      serverId: dnsProviderTunnels.serverId,
      tunnelId: dnsProviderTunnels.tunnelId,
    })
    .from(dnsProviderTunnels);
  if (rows.length === 0) return 0;
  const { fetchHostInfo, withTraefikStackLock, applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");
  let restored = 0;
  const byServer = new Map<string, typeof rows>();
  for (const r of rows)
    byServer.set(r.serverId, [...(byServer.get(r.serverId) ?? []), r]);

  for (const [serverId, tunnels] of byServer) {
    try {
      await withTraefikStackLock(serverId, async () => {
        const original = (await fetchHostInfo(serverId)).traefikComposeYaml;
        if (!original) return;
        let yaml = original;
        let added = 0;
        for (const t of tunnels) {
          const service = appTunnelService(t.providerId);
          if (hasTunnelConnector(yaml, service)) continue;
          const provider = await loadProviderSecret(t.providerId);
          if (!provider) continue;
          const connector = await cloudflare.tunnelToken(
            provider.token,
            provider.accountId,
            t.tunnelId,
          );
          yaml = withTunnelConnector(yaml, service, connector);
          added++;
        }
        if (added === 0) return;
        const res = await applyTraefikConfig(serverId, { composeYaml: yaml });
        if (!res.ok)
          throw new Error(res.error || "the proxy refused the change");
        restored += added;
      });
    } catch (e) {
      console.error(
        `[deplo] could not restore a Cloudflare Tunnel connector on ${serverId}: ${messageOf(e)}`,
      );
    }
  }
  return restored;
}

function tunnelName(server: string): string {
  const slug = server
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return `deplo-${slug || "server"}-${randomBytes(3).toString("hex")}`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
