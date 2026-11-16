import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { domainTlsConfig } from "../../deploy/domains";
import {
  ENTRANCE_PORT,
  MAX_ENTRANCE_SLOT,
  entrancePorts,
  entranceRoutes,
} from "../../deploy/entrance";
import {
  hasEntranceSupport,
  withEntranceSupport,
} from "../../deploy/traefik-stack";
import { CLUSTER_ENTRANCES_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { serverSupports } from "../../infra/agent-client/preflight";
import type { CertProvider, DomainEntrypoint } from "../../types/domain";
import { messageOf } from "../../utils";
import { instanceFrozen } from "../deplo-move/freeze";
import { withKeyedLock } from "../keyed-mutex";
import { clusterMemberServerIds } from "./roster";

// A cluster domain that answers on every server (ADR-0048): which Apps, on which ports, and the proxies that
// need the change. https://deplo.build/docs/operations/clusters/addresses

export type ClusterEntrance = { appId: string; hosts: string[]; slot: number };

/** The Apps of a cluster with an HTTPS domain that answers on every server, each with its hostnames and its slot. */
export async function listClusterEntrances(
  clusterId: string,
): Promise<ClusterEntrance[]> {
  const rows = await getDb()
    .select({
      appId: domainsTable.appId,
      name: domainsTable.name,
      certProvider: domainsTable.certProvider,
      entrypoint: domainsTable.entrypoint,
      tunnel: domainsTable.tunnel,
    })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(
      and(
        eq(appsTable.clusterId, clusterId),
        eq(domainsTable.answersEverywhere, true),
      ),
    );
  const hosts = new Map<string, string[]>();
  for (const r of rows) {
    const tls = domainTlsConfig({
      name: r.name,
      tunnel: r.tunnel === true,
      certProvider: (r.certProvider ?? undefined) as CertProvider | undefined,
      entrypoint: (r.entrypoint ?? undefined) as DomainEntrypoint | undefined,
    });
    // Only an HTTPS domain off the App's tunnel is ever passed on; anything else stays as it is.
    if (!tls.tls || r.tunnel) continue;
    hosts.set(r.appId, [...(hosts.get(r.appId) ?? []), r.name]);
  }
  if (hosts.size === 0) return [];
  const slots = await ensureEntranceSlots(clusterId, [...hosts.keys()]);
  return [...hosts.entries()]
    .map(([appId, names]) => ({
      appId,
      hosts: [...new Set(names)].sort(),
      slot: slots.get(appId)!,
    }))
    .sort((a, b) => a.slot - b.slot);
}

/**
 * Each App keeps its slot for as long as it is in the cluster: a port that named another App a moment ago would send
 * a visitor to it while a proxy still reads the old routes. One that clashes (an App that joined) gets a free one.
 */
async function ensureEntranceSlots(
  clusterId: string,
  appIds: string[],
): Promise<Map<string, number>> {
  return withKeyedLock(`cluster-entrance-slots:${clusterId}`, async () => {
    const db = getDb();
    const rows = await db
      .select({ id: appsTable.id, slot: appsTable.entranceSlot })
      .from(appsTable)
      .where(eq(appsTable.clusterId, clusterId));
    const wanted = new Set(appIds);
    const taken = new Set<number>();
    const slots = new Map<string, number>();
    for (const r of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!wanted.has(r.id) || r.slot == null || taken.has(r.slot)) continue;
      taken.add(r.slot);
      slots.set(r.id, r.slot);
    }
    let next = 0;
    for (const id of [...wanted].sort()) {
      if (slots.has(id)) continue;
      while (taken.has(next)) next++;
      if (next > MAX_ENTRANCE_SLOT)
        throw new Error(
          "This cluster has no room for another App that answers on every server",
        );
      taken.add(next);
      slots.set(id, next);
      await db
        .update(appsTable)
        .set({ entranceSlot: next })
        .where(eq(appsTable.id, id));
    }
    return slots;
  });
}

/** What every member's agent is handed for them: the same for each, as every server answers for every App. */
export function entranceTable(entrances: ClusterEntrance[]): {
  entrances: {
    appId: string;
    routes: string;
    tlsPort: number;
    webPort: number;
  }[];
  serveEntrances: string[];
  entrancePort: number;
} {
  if (entrances.length === 0)
    return { entrances: [], serveEntrances: [], entrancePort: 0 };
  return {
    entrances: entrances.map((e) => {
      const { tls, web } = entrancePorts(e.slot);
      return {
        appId: e.appId,
        routes: JSON.stringify(entranceRoutes(e.appId, e.hosts, e.slot)),
        tlsPort: tls,
        webPort: web,
      };
    }),
    serveEntrances: entrances.map((e) => e.appId),
    entrancePort: ENTRANCE_PORT,
  };
}

const PROXY_STATE = Symbol.for("deplo.cluster.entrance.proxies");
const proxyState = globalThis as unknown as {
  [PROXY_STATE]?: Map<string, { on: boolean; at: number }>;
};
const known = (): Map<string, { on: boolean; at: number }> =>
  (proxyState[PROXY_STATE] ??= new Map());
// A proxy is read again after this long, in case it was put back by hand.
const KNOWN_FOR_MS = 60 * 60_000;

/** Test seam: forget what the proxies were last seen to have. */
export function __forgetEntranceProxies(): void {
  known().clear();
}

/**
 * Puts the change in a member's proxy, or takes it out. Answers whether the proxy changed, which restarts it; a
 * proxy that already matches, or a server with no proxy of Deplo's, is left alone.
 */
export async function syncEntranceProxy(
  serverId: string,
  on: boolean,
): Promise<boolean> {
  const { fetchHostInfo, withTraefikStackLock, applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");
  return withTraefikStackLock(serverId, async () => {
    const yaml = (await fetchHostInfo(serverId)).traefikComposeYaml;
    if (!yaml || hasEntranceSupport(yaml) === on) {
      known().set(serverId, { on, at: Date.now() });
      return false;
    }
    const res = await applyTraefikConfig(serverId, {
      composeYaml: withEntranceSupport(yaml, on),
    });
    if (!res.ok)
      throw new Error(
        res.error || "The proxy on this server refused the change",
      );
    known().set(serverId, { on, at: Date.now() });
    return true;
  });
}

/**
 * Every member's proxy has the change while the cluster has an App that answers everywhere, and only once that
 * member's agent can carry it; none has it otherwise. One server at a time, as each change restarts its proxy.
 */
export async function syncEntranceProxies(
  clusterId: string,
  wanted: boolean,
): Promise<void> {
  for (const serverId of await clusterMemberServerIds(clusterId)) {
    if (await instanceFrozen()) return;
    const on =
      wanted && (await serverSupports(serverId, CLUSTER_ENTRANCES_CAPABILITY));
    const seen = known().get(serverId);
    if (seen && seen.on === on && Date.now() - seen.at < KNOWN_FOR_MS) continue;
    try {
      await syncEntranceProxy(serverId, on);
    } catch (e) {
      console.warn(
        `[cluster-entrances] ${clusterId} -> ${serverId}: ${messageOf(e).replace(/\s+/g, " ").slice(0, 300)}`,
      );
    }
  }
}
