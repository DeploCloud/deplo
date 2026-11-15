import "server-only";

import { and, eq } from "drizzle-orm";

import * as cloudflare from "../../cloudflare/tunnel-api";
import { getDb } from "../../db/client";
import {
  appTunnelDomains,
  dnsProviderTunnels,
  domainDnsRecords,
} from "../../db/schema/control-plane/dns-providers";
import { domains } from "../../db/schema/control-plane/domains";
import { servers } from "../../db/schema/control-plane/servers";
import { messageOf } from "../../utils";
import { recordActivity } from "../activity";
import { loadAppGraph } from "../app-graph-load";
import { healAppTunnelIngress } from "../clusters/app-tunnel";
import { instanceFrozen } from "../deplo-move/freeze";
import { withKeyedLock } from "../keyed-mutex";
import {
  alignSharedRecords,
  deploRecordTargets,
  hostnameOwner,
} from "./shared-hostname";
import {
  ensureServerTunnel,
  healServerTunnelIngress,
  loadProviderSecret,
  resyncServerTunnel,
  syncTunnelIngress,
  waitForConnector,
} from "./tunnels";

// A hostname served through a server's tunnel reaches only the proxy of that server. When its App runs somewhere
// else, the hostname moves to the tunnel of the server it runs on now, whose connector Deplo starts there first.

const RECORD_COMMENT = "Deplo app";

type Held = {
  id: string;
  name: string;
  providerId: string;
  recordId: string;
  tunnelId: string | null;
  created: boolean;
};

export type Followed = { moved: string[]; problems: string[] };

/**
 * Points every tunnel hostname the App owns at the tunnel of the server it runs on, unless its own tunnel serves
 * it. `waitMs` is how long a connector that has just started may take to reach Cloudflare; DNS waits for it.
 */
export async function followAppServer(
  appId: string,
  waitMs = 0,
): Promise<Followed> {
  const out: Followed = { moved: [], problems: [] };
  if (await instanceFrozen()) return out;
  const app = await loadAppGraph(appId);
  if (!app?.serverId) return out;
  const rows = await getDb()
    .select({
      id: domains.id,
      name: domains.name,
      providerId: domainDnsRecords.providerId,
      recordId: domainDnsRecords.recordId,
      tunnelId: domainDnsRecords.tunnelId,
      created: domainDnsRecords.created,
      ownTunnel: appTunnelDomains.domainId,
    })
    .from(domains)
    .innerJoin(domainDnsRecords, eq(domainDnsRecords.domainId, domains.id))
    .leftJoin(appTunnelDomains, eq(appTunnelDomains.domainId, domains.id))
    .where(and(eq(domains.appId, appId), eq(domains.tunnel, true)));
  const reroute = new Set<string>();
  for (const d of rows) {
    // The App's own tunnel runs wherever it does.
    if (d.ownTunnel) continue;
    // A path of another App's hostname is served from wherever that App runs.
    if ((await hostnameOwner(d.name))?.id !== d.id) continue;
    try {
      const shared = await withKeyedLock(`domain:${d.name}`, () =>
        pointAtServer(d, app.serverId, waitMs),
      );
      if (!shared) continue;
      for (const a of shared.rerouteApps) reroute.add(a);
      out.moved.push(d.name);
    } catch (e) {
      out.problems.push(`${d.name} (${messageOf(e)})`);
    }
  }
  if (reroute.size > 0) {
    const { rerouteApp } = await import("../../deploy/build/reroute");
    for (const id of reroute) await rerouteApp(id).catch(() => {});
  }
  if (out.moved.length > 0) {
    const [server] = await getDb()
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, app.serverId));
    await recordActivity(
      "domain",
      `Moved ${out.moved.join(", ")} to the Cloudflare Tunnel on ${server?.name ?? "its server"}, where ${app.name} runs now`,
      "Deplo",
      appId,
      app.teamId,
    );
  }
  return out;
}

// Null when the hostname already points at that server's tunnel, or its connector is not connected yet.
async function pointAtServer(
  d: Held,
  serverId: string,
  waitMs: number,
): Promise<{ rerouteApps: string[] } | null> {
  const [current] = d.tunnelId
    ? await getDb()
        .select({
          serverId: dnsProviderTunnels.serverId,
          providerId: dnsProviderTunnels.providerId,
        })
        .from(dnsProviderTunnels)
        .where(eq(dnsProviderTunnels.id, d.tunnelId))
    : [];
  if (current?.serverId === serverId && current.providerId === d.providerId)
    return null;
  const provider = await loadProviderSecret(d.providerId);
  if (!provider)
    throw new Error("its Cloudflare connection is gone from Deplo");

  const tunnel = await ensureServerTunnel(provider, serverId, d.name);
  // A tunnel nobody runs yet answers nobody: the hostname stays where it is until the connector is up.
  if (!(await waitForConnector(provider, tunnel.tunnelId, waitMs))) {
    await syncTunnelIngress(provider, tunnel).catch(() => {});
    return null;
  }
  const targets = await deploRecordTargets();
  let pointed: cloudflare.PointedRecord;
  try {
    pointed = await cloudflare.pointAtTunnel(
      provider.token,
      provider.zoneId,
      d.name,
      tunnel.tunnelId,
      // Deplo's own record, or one that points at a server or a tunnel of this Deplo.
      (r) => r.id === d.recordId || targets.has(r.content.toLowerCase()),
      RECORD_COMMENT,
    );
  } catch (e) {
    await syncTunnelIngress(provider, tunnel).catch(() => {});
    throw e;
  }
  await getDb()
    .update(domainDnsRecords)
    .set({
      zoneId: provider.zoneId,
      recordId: pointed.id,
      tunnelId: tunnel.id,
      created: pointed.created || d.created,
    })
    .where(eq(domainDnsRecords.domainId, d.id));
  const shared = await alignSharedRecords(d.id);
  const stale = new Set([d.tunnelId, ...shared.oldTunnels]);
  stale.delete(tunnel.id);
  for (const id of stale) if (id) await resyncServerTunnel(id);
  await resyncServerTunnel(tunnel.id);
  return { rerouteApps: shared.rerouteApps };
}

/**
 * The sweep: every tunnel hostname points at the server its App runs on, and every tunnel routes exactly as
 * Deplo derives it - to the proxy by name, never an address. Normally there is nothing to do.
 */
export async function reconcileTunnelDomains(): Promise<void> {
  if (await instanceFrozen()) return;
  const owners = await getDb()
    .selectDistinct({ appId: domains.appId })
    .from(domains)
    .innerJoin(domainDnsRecords, eq(domainDnsRecords.domainId, domains.id))
    .where(eq(domains.tunnel, true));
  for (const { appId } of owners) {
    const { problems } = await followAppServer(appId).catch((e) => ({
      moved: [],
      problems: [messageOf(e)],
    }));
    for (const p of problems) console.warn(`[tunnel] ${appId}: ${p}`);
  }
  const healed =
    (await healServerTunnelIngress()) + (await healAppTunnelIngress());
  if (healed > 0)
    console.log(
      `[deplo] put back the routes of ${healed} Cloudflare Tunnel(s)`,
    );
}
