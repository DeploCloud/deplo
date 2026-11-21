import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusterMembers } from "../../db/schema/control-plane/clusters";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { rerouteApp } from "../../deploy/build/reroute";
import { rehostWildcard, wildcardEmbeddedIp } from "../../deploy/domains";
import { recordActivity } from "../activity";
import { loadAppGraph, loadDomainsForApp } from "../app-graph-load";
import { instanceFrozen } from "../deplo-move/freeze";
import { assertHostnameNotAnotherTeams } from "../domains/hostname-claim";
import { syncProductionUrl } from "../domains/primary-domain";
import { repointRedirects } from "../domains/www-pairing";
import { withKeyedLock } from "../keyed-mutex";
import { serverWildcardIp } from "../servers/addresses";
import { getServerById } from "../servers/roster";
import { recordOnce } from "./bundles";
import { clusterMemberServerIds } from "./roster";
import type { App } from "../../types/app";
import type { AddressAway } from "../../types/domain";
import { messageOf } from "../../utils";

/**
 * A generated address carries its server's IP, so an App the leader moved answers on a name that points at the
 * server it left. Once its stack is on the new member the name follows, as a server move does. Read from what is
 * stored, never from an event, so a failover Deplo slept through is caught up the same way.
 */
export async function rehostClusterApp(appId: string): Promise<string[]> {
  return withKeyedLock(`cluster-address:${appId}`, async () => {
    if (await instanceFrozen()) return [];
    const app = await loadAppGraph(appId);
    if (!app?.clusterId) return [];
    const ip = await serverWildcardIp(await getServerById(app.serverId));
    if (!ip) return [];
    const waits = await waitsForItsServer(app);
    const moved: { id: string; from: string; to: string }[] = [];
    for (const d of await loadDomainsForApp(appId)) {
      const held = d.source === "auto" ? wildcardEmbeddedIp(d.name) : null;
      if (!held || held === ip || waits.has(held)) continue;
      const to = rehostWildcard(d.name, ip);
      if (to === d.name) continue;
      try {
        await assertHostnameNotAnotherTeams(to, app.teamId, d.id);
        moved.push({ id: d.id, from: d.name, to });
      } catch (e) {
        await recordOnce(
          app,
          `${app.name} moved to another server of its cluster, but its generated address stays ${d.name}: ${messageOf(e)}`,
        );
      }
    }
    if (moved.length === 0) return [];
    const rename = async (dir: "to" | "from") => {
      for (const m of moved) {
        await getDb()
          .update(domainsTable)
          .set({ name: m[dir] })
          .where(and(eq(domainsTable.id, m.id), eq(domainsTable.appId, appId)));
        await repointRedirects(
          appId,
          dir === "to" ? m.from : m.to,
          m[dir],
          app.teamId,
        );
      }
      await syncProductionUrl(appId);
    };
    await rename("to");
    // "deferred" is a stack that is not on the new member yet: the names go back and the sweep tries again.
    let outcome: "rerouted" | "unchanged" | "deferred" | Error;
    try {
      outcome = await rerouteApp(appId);
    } catch (e) {
      outcome = e instanceof Error ? e : new Error(String(e));
    }
    if (outcome === "deferred" || outcome instanceof Error) {
      await rename("from");
      if (outcome instanceof Error) throw outcome;
      return [];
    }
    await recordActivity(
      "domain",
      `${app.name} moved to another server of its cluster, so its generated address is now ${moved.map((m) => m.to).join(", ")}`,
      "Deplo",
      appId,
      app.teamId,
    );
    return moved.map((m) => m.to);
  });
}

/**
 * A load-balanced App gets its copy back on a server that returns, and every copy holds the name in its routes: a
 * renamed address would restart them all. Its address waits for the server it names while that one is a member.
 */
async function waitsForItsServer(app: App): Promise<Set<string>> {
  const { appLoadBalanced } = await import("./load-balancing");
  if (!app.clusterId || !(await appLoadBalanced(app))) return new Set();
  const ips = await Promise.all(
    (await clusterMemberServerIds(app.clusterId)).map(async (id) =>
      serverWildcardIp(await getServerById(id)),
    ),
  );
  return new Set(ips.filter((ip): ip is string => Boolean(ip)));
}

/**
 * By domain id, each generated address of a load-balanced App that names a server away now. It waits for that
 * server instead of following the App, so it answers nothing until it is back; the App's own domains still do.
 */
export async function generatedAddressesAway(
  app: App,
): Promise<Record<string, AddressAway>> {
  const { appLoadBalanced } = await import("./load-balancing");
  if (!app.clusterId || !(await appLoadBalanced(app))) return {};
  const members = await getDb()
    .select({ id: clusterMembers.serverId, lease: clusterMembers.leaseState })
    .from(clusterMembers)
    .where(eq(clusterMembers.clusterId, app.clusterId));
  const away = new Map<string, string>();
  for (const m of members) {
    const server = await getServerById(m.id);
    const ip = await serverWildcardIp(server);
    if (server && ip && (m.lease !== "ok" || server.status === "offline"))
      away.set(ip, server.name);
  }
  if (away.size === 0) return {};
  const domains = await loadDomainsForApp(app.id);
  const use =
    domains
      .filter((d) => d.source !== "auto" && (d.answersEverywhere || d.tunnel))
      .sort((a, b) => Number(b.primary) - Number(a.primary))[0]?.name ?? null;
  const out: Record<string, AddressAway> = {};
  for (const d of domains) {
    const server =
      d.source === "auto" ? away.get(wildcardEmbeddedIp(d.name) ?? "") : null;
    if (server) out[d.id] = { server, use };
  }
  return out;
}

/** The sweep's backstop: every cluster App whose generated address names a server it left catches up. */
export async function rehostClusterAddresses(): Promise<void> {
  if (await instanceFrozen()) return;
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(isNotNull(appsTable.clusterId));
  for (const r of rows)
    await rehostClusterApp(r.id).catch((e) =>
      console.warn(`[cluster-address] ${r.id}: ${messageOf(e)}`),
    );
}
