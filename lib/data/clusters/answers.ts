import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { domainTlsConfig } from "../../deploy/domains";
import {
  ANSWER_PORT,
  MAX_ANSWER_APPS,
  MAX_ANSWER_SLOT,
  answerPorts,
  answerRoutes,
} from "../../deploy/answer";
import {
  hasAnswerSupport,
  withAnswerSupport,
} from "../../deploy/traefik-stack";
import { CLUSTER_ANSWERS_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { serverSupports } from "../../infra/agent-client/preflight";
import type { CertProvider, DomainEntrypoint } from "../../types/domain";
import { messageOf } from "../../utils";
import { instanceFrozen } from "../deplo-move/freeze";
import { recordActivity } from "../activity";
import { withKeyedLock } from "../keyed-mutex";
import { getServerById } from "../servers/roster";
import { recordClusterActivity } from "./cluster-activity";
import type { ClusterAnswerRefusal } from "../../infra/agent-client/connection";
import { clusterMemberServerIds, getClusterById } from "./roster";

// A cluster domain that answers on every server (ADR-0048): which Apps, on which ports, and the proxies that
// need the change. https://deplo.build/docs/operations/clusters/addresses

export type ClusterAnswer = { appId: string; hosts: string[]; slot: number };

/** Each App of the cluster with an HTTPS domain, off its tunnel, that answers on every server: its hostnames. */
async function answeringApps(
  clusterId: string,
): Promise<Map<string, string[]>> {
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
  return hosts;
}

/**
 * The Apps of a cluster that answer on every server, each with its hostnames and its slot. Never more than a server
 * agent takes: it refuses a whole table past it, so the Apps that came last wait rather than take it from the rest.
 */
export async function listClusterAnswers(
  clusterId: string,
  max = MAX_ANSWER_APPS,
): Promise<ClusterAnswer[]> {
  const hosts = await answeringApps(clusterId);
  if (hosts.size === 0) return [];
  const slots = await ensureAnswerSlots(clusterId, [...hosts.keys()]);
  const all = [...hosts.entries()]
    .filter(([appId]) => slots.has(appId))
    .map(([appId, names]) => ({
      appId,
      hosts: [...new Set(names)].sort(),
      slot: slots.get(appId)!,
    }))
    .sort((a, b) => a.slot - b.slot);
  if (all.length > max)
    console.warn(
      `[cluster-answers] ${clusterId}: ${all.length} Apps answer on every server, past the ${max} a server carries`,
    );
  return all.slice(0, max);
}

/** Why one more App of the cluster cannot answer on every server, or null: the switch asks before it turns on. */
export async function answerAppsRefusal(
  clusterId: string,
  appId: string,
  max = MAX_ANSWER_APPS,
): Promise<string | null> {
  const apps = await answeringApps(clusterId);
  if (apps.has(appId) || apps.size < max) return null;
  return `This cluster already has ${max} Apps that answer on every server, the most its servers carry. Turn it off on one of them first.`;
}

/**
 * Slots only grow, so a port that named an App a moment ago is never handed to the next one while a proxy may still
 * read the old routes; they start again from the lowest free one only once they run out. An App keeps its own.
 */
async function ensureAnswerSlots(
  clusterId: string,
  appIds: string[],
): Promise<Map<string, number>> {
  return withKeyedLock(`cluster-answer-slots:${clusterId}`, () =>
    getDb().transaction(async (tx) => {
      const [cluster] = await tx
        .select({ next: clustersTable.answerSlotNext })
        .from(clustersTable)
        .where(eq(clustersTable.id, clusterId))
        .for("update");
      const slots = new Map<string, number>();
      if (!cluster) return slots;
      const rows = await tx
        .select({ id: appsTable.id, slot: appsTable.answerSlot })
        .from(appsTable)
        .where(eq(appsTable.clusterId, clusterId));
      const wanted = new Set(appIds);
      const taken = new Set<number>();
      for (const r of rows.sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (!wanted.has(r.id) || r.slot == null || taken.has(r.slot)) continue;
        taken.add(r.slot);
        slots.set(r.id, r.slot);
      }
      let next = cluster.next;
      let wrapped = false;
      const take = (): number => {
        for (;;) {
          if (next > MAX_ANSWER_SLOT) {
            if (wrapped)
              throw new Error(
                "This cluster has no room for another App that answers on every server",
              );
            next = 0;
            wrapped = true;
          }
          const slot = next++;
          if (!taken.has(slot)) return slot;
        }
      };
      for (const id of [...wanted].sort()) {
        if (slots.has(id)) continue;
        const slot = take();
        taken.add(slot);
        slots.set(id, slot);
        await tx
          .update(appsTable)
          .set({ answerSlot: slot })
          .where(eq(appsTable.id, id));
      }
      if (next !== cluster.next)
        await tx
          .update(clustersTable)
          .set({ answerSlotNext: next })
          .where(eq(clustersTable.id, clusterId));
      return slots;
    }),
  );
}

/** What every member's agent is handed for them: the same for each, as every server answers for every App. */
export function answerTable(answers: ClusterAnswer[]): {
  answers: {
    appId: string;
    routes: string;
    tlsPort: number;
    webPort: number;
  }[];
  serveAnswers: string[];
  answerPort: number;
} {
  if (answers.length === 0)
    return { answers: [], serveAnswers: [], answerPort: 0 };
  return {
    answers: answers.map((e) => {
      const { tls, web } = answerPorts(e.slot);
      return {
        appId: e.appId,
        routes: JSON.stringify(answerRoutes(e.appId, e.hosts, e.slot)),
        tlsPort: tls,
        webPort: web,
      };
    }),
    serveAnswers: answers.map((e) => e.appId),
    answerPort: ANSWER_PORT,
  };
}

const PROXY_STATE = Symbol.for("deplo.cluster.answer.proxies");
const proxyState = globalThis as unknown as {
  [PROXY_STATE]?: Map<string, { on: boolean; at: number }>;
};
const known = (): Map<string, { on: boolean; at: number }> =>
  (proxyState[PROXY_STATE] ??= new Map());
// A proxy is read again after this long, in case it was put back by hand.
const KNOWN_FOR_MS = 60 * 60_000;

/** Test seam: forget what the proxies were last seen to have. */
export function __forgetAnswerProxies(): void {
  known().clear();
}

/**
 * Puts the change in a member's proxy, or takes it out. Answers whether the proxy changed, which restarts it; a
 * proxy that already matches, or a server with no proxy of Deplo's, is left alone.
 */
export async function syncAnswerProxy(
  serverId: string,
  on: boolean,
): Promise<boolean> {
  const { fetchHostInfo, withTraefikStackLock, applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");
  return withTraefikStackLock(serverId, async () => {
    const yaml = (await fetchHostInfo(serverId)).traefikComposeYaml;
    if (!yaml || hasAnswerSupport(yaml) === on) {
      known().set(serverId, { on, at: Date.now() });
      return false;
    }
    const res = await applyTraefikConfig(serverId, {
      composeYaml: withAnswerSupport(yaml, on),
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
export async function syncAnswerProxies(
  clusterId: string,
  wanted: boolean,
): Promise<void> {
  for (const serverId of await clusterMemberServerIds(clusterId)) {
    if (await instanceFrozen()) return;
    const on =
      wanted && (await serverSupports(serverId, CLUSTER_ANSWERS_CAPABILITY));
    const seen = known().get(serverId);
    if (seen && seen.on === on && Date.now() - seen.at < KNOWN_FOR_MS) continue;
    try {
      await syncAnswerProxy(serverId, on);
    } catch (e) {
      console.warn(
        `[cluster-answers] ${clusterId} -> ${serverId}: ${messageOf(e).replace(/\s+/g, " ").slice(0, 300)}`,
      );
    }
  }
}

/** The clusters with at least one App that answers on every server. */
export async function clustersWithAnswers(): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ clusterId: appsTable.clusterId })
    .from(domainsTable)
    .innerJoin(appsTable, eq(appsTable.id, domainsTable.appId))
    .where(eq(domainsTable.answersEverywhere, true));
  return rows.map((r) => r.clusterId).filter((id): id is string => Boolean(id));
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const times = (n: number) =>
  n === 1 ? "1 visitor connection" : `${n} visitor connections`;

/** What a member turned away, said where it is read: an App's waiting cap to its team, the server's to the cluster's. */
export async function recordAnswerRefusals(
  clusterId: string,
  serverId: string,
  refusals: ClusterAnswerRefusal[],
): Promise<void> {
  const server = (await getServerById(serverId))?.name ?? "A server";
  const cluster = await getClusterById(clusterId);
  for (const r of refusals) {
    const when = `between ${clock(r.firstUnixMs)} and ${clock(r.lastUnixMs)} UTC`;
    if (r.appId) {
      const [app] = await getDb()
        .select({ name: appsTable.name })
        .from(appsTable)
        .where(eq(appsTable.id, r.appId))
        .limit(1);
      if (!app) continue;
      await recordActivity(
        "app",
        `${server} turned away ${times(r.count)} to ${app.name} ${when}: at most ${r.cap} visitors wait for it at once while it is not ready. The cluster's limit is in its settings.`,
        "Deplo",
        r.appId,
      );
      continue;
    }
    const carried = cluster && r.cap === cluster.answerMaxConnections;
    await recordClusterActivity(
      clusterId,
      `${server} turned away ${times(r.count)} to domains that answer on every server ${when}: it ${carried ? `carries at most ${r.cap} at once` : `holds at most ${r.cap} waiting at once`}. Raise the cluster's limit if this is your usual traffic.`,
    );
  }
}
