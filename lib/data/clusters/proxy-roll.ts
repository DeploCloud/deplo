import "server-only";

import { setTimeout as sleep } from "node:timers/promises";

import { eq } from "drizzle-orm";

import type { SetClusterZoneRequest } from "../../agent/gen/agent";
import { getDb } from "../../db/client";
import {
  clusterDnsZones,
  clusterMembers,
} from "../../db/schema/control-plane/clusters";
import { setClusterZone } from "../../infra/agent-client/cluster-host";
import { ADDRESS_PROVE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { messageOf } from "../../utils";
import { withKeyedLock } from "../keyed-mutex";
import {
  checkAddress,
  publishedServerAddresses,
  zoneServed,
} from "../servers/address-checks";
import { getServerById } from "../servers/roster";
import { recordClusterActivity } from "./cluster-activity";
import { getClusterById } from "./roster";

// A cluster member's proxy restarts alone, out of its zone's answers until it serves again (ADR-0049).
// https://deplo.build/docs/operations/clusters/dns-zone

type Roll = {
  /** Members whose proxy restarts now, out of every answer: server id -> certificate. */
  drained: Map<string, string>;
  /** The table each member was last handed, before any drain, by cluster then server. */
  tables: Map<string, Map<string, SetClusterZoneRequest>>;
};
const KEY = Symbol.for("deplo.cluster.proxy-roll");
const g = globalThis as unknown as { [KEY]?: Roll };
const roll: Roll = (g[KEY] ??= { drained: new Map(), tables: new Map() });

export const proxyRollTiming = {
  /** How long resolvers may still name the member; null is the cluster's answer TTL. */
  drainMs: null as number | null,
  /** Right after Deplo starts: how long a restart waits for the zone's first pass. */
  tableWithinMs: 90_000,
  answerWithinMs: 120_000,
  pollMs: 2_000,
  // ponytail: a fixed pause for the proxy to load its routes after 443 answers; probe a served name if it falls short.
  settleMs: 5_000,
};

/** A member's table with every member whose proxy restarts now taken out of the answers. */
export function withDrained(req: SetClusterZoneRequest): SetClusterZoneRequest {
  const out = new Set(roll.drained.values());
  if (out.size === 0) return req;
  return {
    ...req,
    servers: req.servers.map((s) =>
      out.has(s.fingerprint) ? { ...s, emptying: true } : s,
    ),
  };
}

/** Kept from every zone pass, so a restart can hand the members the same table with itself out. */
export function rememberZoneTable(
  clusterId: string,
  serverId: string,
  req: SetClusterZoneRequest,
): void {
  const t = roll.tables.get(clusterId) ?? new Map();
  t.set(serverId, req);
  roll.tables.set(clusterId, t);
}

/** Only the members of this pass keep a table; none at all when the cluster has no zone. */
export function keepZoneTables(clusterId: string, serverIds: string[]): void {
  const t = roll.tables.get(clusterId);
  if (!t) return;
  for (const id of t.keys()) if (!serverIds.includes(id)) t.delete(id);
  if (t.size === 0) roll.tables.delete(clusterId);
}

/** Test seam. */
export function __resetProxyRoll(): void {
  roll.drained.clear();
  roll.tables.clear();
}

/**
 * Restarts a member's proxy as the only one of its cluster: out of the zone's answers for one TTL first, back once
 * its 443 and its name server answer. A server in no cluster restarts at once. A zone pass's own restart skips the
 * wait for the first pass, which is itself.
 */
export async function rollProxyRestart<T>(
  serverId: string,
  restart: () => Promise<T>,
  opts: { inZonePass?: boolean } = {},
): Promise<T> {
  const [member] = await getDb()
    .select({ clusterId: clusterMembers.clusterId })
    .from(clusterMembers)
    .where(eq(clusterMembers.serverId, serverId))
    .limit(1)
    // A unit with no database: no cluster to roll.
    .catch(() => []);
  if (!member) return restart();
  const clusterId = member.clusterId;
  if (!opts.inZonePass) await tablesReady(clusterId);
  return withKeyedLock(`proxy-roll:${clusterId}`, () =>
    restartAlone(clusterId, serverId, restart),
  );
}

async function tablesReady(clusterId: string): Promise<void> {
  const until = Date.now() + proxyRollTiming.tableWithinMs;
  while (!roll.tables.has(clusterId) && Date.now() < until) {
    const [zone] = await getDb()
      .select({ id: clusterDnsZones.id })
      .from(clusterDnsZones)
      .where(eq(clusterDnsZones.clusterId, clusterId))
      .limit(1);
    if (!zone) return;
    await sleep(Math.min(1_000, proxyRollTiming.tableWithinMs));
  }
}

async function restartAlone<T>(
  clusterId: string,
  serverId: string,
  restart: () => Promise<T>,
): Promise<T> {
  const server = await getServerById(serverId);
  const fp = server?.agent?.certFingerprint?.toLowerCase() ?? "";
  const drain = fp !== "" && roll.tables.has(clusterId);
  if (drain) {
    roll.drained.set(serverId, fp);
    await handAgain(clusterId);
    const cluster = await getClusterById(clusterId);
    await sleep(
      proxyRollTiming.drainMs ?? (cluster?.dnsAnswerTtl ?? 30) * 1000,
    );
    // A zone pass that crossed the first hand-out may have told a member otherwise.
    await handAgain(clusterId);
  }
  try {
    const res = await restart();
    if (!(await untilServing(serverId)))
      await recordClusterActivity(
        clusterId,
        `The proxy on ${server?.name ?? serverId} did not answer within ${proxyRollTiming.answerWithinMs / 60_000} minutes of its restart. Deplo put it back in the zone's answers anyway.`,
      );
    return res;
  } finally {
    if (drain) {
      roll.drained.delete(serverId);
      await handAgain(clusterId);
    }
  }
}

async function handAgain(clusterId: string): Promise<void> {
  for (const [serverId, req] of roll.tables.get(clusterId) ?? [])
    await setClusterZone(serverId, withDrained(req)).catch((e) =>
      console.warn(`[proxy-roll] ${clusterId} -> ${serverId}: ${messageOf(e)}`),
    );
}

async function untilServing(serverId: string): Promise<boolean> {
  const until = Date.now() + proxyRollTiming.answerWithinMs;
  for (;;) {
    const s = await serving(serverId);
    if (s !== false) {
      if (s) await sleep(proxyRollTiming.settleMs);
      return true;
    }
    if (Date.now() >= until) return false;
    await sleep(proxyRollTiming.pollMs);
  }
}

/** Its proxy answers on its proven addresses, its name server too; null when its agent cannot tell. */
async function serving(serverId: string): Promise<boolean | null> {
  const { connectAgent } = await import("../../infra/agent-client/connect");
  let proof: { proxyCertificateSha256: string; dnsIdent: string };
  try {
    const conn = await connectAgent(serverId);
    try {
      const hello = await conn.hello();
      if (!hello.capabilities?.includes(ADDRESS_PROVE_CAPABILITY)) return null;
      proof = await conn.proveAddresses("");
    } finally {
      conn.close();
    }
  } catch {
    return false;
  }
  if (!proof.proxyCertificateSha256) return false;
  const name = (await getServerById(serverId))?.name ?? serverId;
  const at = await publishedServerAddresses(serverId);
  const zone = await zoneServed(serverId);
  let checked = false;
  for (const address of at ? [...at.v4, ...at.v6] : []) {
    const out = await checkAddress(
      address,
      name,
      { cert: proof.proxyCertificateSha256, ident: proof.dnsIdent, zone },
      new Map(),
    );
    if (out.reaches) return true;
    if (!("unchecked" in out && out.unchecked)) checked = true;
  }
  // No address Deplo can reach it at: its own agent seeing its proxy answer is all there is.
  return !checked;
}
