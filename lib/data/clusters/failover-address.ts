import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
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
    const moved: { id: string; from: string; to: string }[] = [];
    for (const d of await loadDomainsForApp(appId)) {
      const held = d.source === "auto" ? wildcardEmbeddedIp(d.name) : null;
      if (!held || held === ip) continue;
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
