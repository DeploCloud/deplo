import "server-only";

import { eq } from "drizzle-orm";

import * as cloudflare from "../../cloudflare/tunnel-api";
import { getDb } from "../../db/client";
import { domainDnsRecords } from "../../db/schema/control-plane/dns-providers";
import {
  alignSharedRecords,
  deploRecordTargets,
  hostnameOwner,
} from "../dns-providers/shared-hostname";
import {
  ensureServerTunnel,
  loadProviderSecret,
  resyncServerTunnel,
  syncTunnelIngress,
} from "../dns-providers/tunnels";
import { appServerAddresses } from "./dns-check";

const RECORD_COMMENT = "Deplo app";

export type RecordSwitch = {
  domainId: string;
  tunnel: boolean;
  proxied: boolean;
  tunnelChanged: boolean;
  oldTunnelId: string | null;
};

type Switchable = {
  id: string;
  appId: string;
  name: string;
  tunnel?: boolean;
  proxied?: boolean;
};

/**
 * Points the record Deplo holds for a domain of an App off a cluster the way asked: the server's tunnel, or its
 * address with Cloudflare's proxy on or off. Null when nothing changes, or Deplo holds no record to change.
 */
export async function switchDomainRecord(
  dom: Switchable,
  serverId: string | null | undefined,
  want: { tunnel: boolean; proxied: boolean },
): Promise<RecordSwitch | null> {
  const wasTunnel = dom.tunnel === true;
  const proxied = want.tunnel || want.proxied;
  const tunnelChanged = want.tunnel !== wasTunnel;
  if (!tunnelChanged && proxied === (wasTunnel || dom.proxied === true))
    return null;
  const [held] = await getDb()
    .select()
    .from(domainDnsRecords)
    .where(eq(domainDnsRecords.domainId, dom.id));
  if (!held) {
    if (tunnelChanged)
      throw new Error(
        `Deplo does not manage the DNS record of ${dom.name}, so it cannot change how Cloudflare serves it`,
      );
    return null;
  }
  if ((await hostnameOwner(dom.name))?.id !== dom.id)
    throw new Error(
      `Another domain on ${dom.name} holds its DNS record: change its tunnel and proxy there`,
    );
  const provider = await loadProviderSecret(held.providerId);
  if (!provider)
    throw new Error("Its Cloudflare connection is gone from Deplo");
  const out = {
    domainId: dom.id,
    tunnel: want.tunnel,
    proxied,
    tunnelChanged,
    oldTunnelId: held.tunnelId,
  };

  if (!tunnelChanged) {
    await cloudflare.setDnsRecordProxied(
      provider.token,
      provider.zoneId,
      held.recordId,
      proxied,
    );
    return out;
  }
  const targets = await deploRecordTargets();
  // Deplo's own record, or one that points at a server or a tunnel of this Deplo.
  const ours = (r: cloudflare.DnsRecord) =>
    r.id === held.recordId || targets.has(r.content.toLowerCase());
  if (want.tunnel) {
    if (!serverId)
      throw new Error("This app has no server yet, so it cannot use a tunnel");
    const tunnel = await ensureServerTunnel(provider, serverId, dom.name);
    let pointed: cloudflare.PointedRecord;
    try {
      pointed = await cloudflare.pointAtTunnel(
        provider.token,
        provider.zoneId,
        dom.name,
        tunnel.tunnelId,
        ours,
        RECORD_COMMENT,
      );
    } catch (e) {
      await syncTunnelIngress(provider, tunnel).catch(() => {});
      throw e;
    }
    await rehold(
      dom.id,
      pointed.id,
      tunnel.id,
      pointed.created || held.created,
    );
    return out;
  }
  const address = await appServerAddresses(dom.appId);
  const pointed = await cloudflare.pointAtAddress(
    provider.token,
    provider.zoneId,
    dom.name,
    { v4: address.v4[0] ?? null, v6: address.v6[0] ?? null },
    RECORD_COMMENT,
    { proxied, ours },
  );
  if (pointed)
    await rehold(dom.id, pointed.id, null, pointed.created || held.created);
  else
    await getDb()
      .delete(domainDnsRecords)
      .where(eq(domainDnsRecords.domainId, dom.id));
  return out;
}

async function rehold(
  domainId: string,
  recordId: string,
  tunnelId: string | null,
  created: boolean,
): Promise<void> {
  await getDb()
    .update(domainDnsRecords)
    .set({ recordId, tunnelId, created })
    .where(eq(domainDnsRecords.domainId, domainId));
}

/** Once the domain is saved the new way: its hostname's other paths follow, and the tunnels it left drop it. */
export async function settleRecordSwitch(sw: RecordSwitch): Promise<void> {
  if (!sw.tunnelChanged) return;
  const shared = await alignSharedRecords(sw.domainId);
  for (const id of new Set([sw.oldTunnelId, ...shared.oldTunnels]))
    if (id) await resyncServerTunnel(id);
  if (shared.rerouteApps.length === 0) return;
  const { rerouteApp } = await import("../../deploy/build/reroute");
  for (const id of shared.rerouteApps) await rerouteApp(id).catch(() => {});
}

export function recordSwitchNote(sw: RecordSwitch | null): string {
  if (!sw) return "";
  if (sw.tunnel) return ", now served through a Cloudflare Tunnel";
  if (!sw.proxied) return ", now pointed straight at its server";
  return ", now proxied through Cloudflare";
}
