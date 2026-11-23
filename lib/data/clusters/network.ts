import "server-only";

import { and, eq, inArray, ne, notInArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  clusterNetworkLinks,
  clusterNetworkPeers,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import {
  planNetwork,
  type NetworkPath,
  type NetworkServer,
} from "../../deploy/cluster-network";
import { nowIso } from "../../ids";
import { setClusterNetwork } from "../../infra/agent-client/cluster-host";
import { AgentClusterNetworkUnsupportedError } from "../../infra/agent-client/errors";
import type { Server } from "../../types/server";
import { messageOf } from "../../utils";
import { instanceFrozen } from "../deplo-move/freeze";
import { getServerById } from "../servers/roster";
import { leaderHostOf } from "./host";
import { fingerprintOf } from "./relay";
import { clusterMemberServerIds, getClusterById } from "./roster";

// The servers of a cluster share a private network (ADR-0047). Deplo hands each server agent its peers; the
// network itself runs between the agents and stays up while Deplo or the leader is down.

// What each server's agent last named as its own addresses; it says them again on every pass.
const ADDRESSES = Symbol.for("deplo.cluster.network.addresses");
const state = globalThis as unknown as { [ADDRESSES]?: Map<string, string[]> };
const addresses = (): Map<string, string[]> => (state[ADDRESSES] ??= new Map());

function warn(clusterId: string, e: unknown) {
  console.warn(
    `[cluster-network] ${clusterId}: ${messageOf(e).replace(/\s+/g, " ").slice(0, 300)}`,
  );
}

/** The servers on a cluster's network: its members, and every server whose leader may lead it. */
async function networkServers(clusterId: string): Promise<Server[]> {
  const cluster = await getClusterById(clusterId);
  if (!cluster) return [];
  const ids = new Set(await clusterMemberServerIds(clusterId));
  // The leader it was moved to, and Deplo's own machine, which stands in for it: both reach members through it.
  for (const id of new Set([cluster.leaderServerId, null])) {
    const host = await leaderHostOf(id);
    if (host) ids.add(host.id);
  }
  const out: Server[] = [];
  for (const id of ids) {
    const s = await getServerById(id);
    if (s && !s.importOnly) out.push(s);
  }
  return out;
}

async function keysOf(clusterId: string) {
  const rows = await getDb()
    .select()
    .from(clusterNetworkPeers)
    .where(eq(clusterNetworkPeers.clusterId, clusterId));
  return new Map(rows.map((r) => [r.serverId, r]));
}

/** Takes servers off a cluster's network; one that cannot be told now keeps its row, so the next pass tries again. */
async function takeOff(clusterId: string, serverIds: string[]): Promise<void> {
  for (const serverId of serverIds) {
    try {
      await setClusterNetwork(serverId, { clusterId, address: "", peers: [] });
    } catch (e) {
      if (!(e instanceof AgentClusterNetworkUnsupportedError)) {
        warn(clusterId, e);
        continue;
      }
    }
    const db = getDb();
    await db
      .delete(clusterNetworkPeers)
      .where(
        and(
          eq(clusterNetworkPeers.clusterId, clusterId),
          eq(clusterNetworkPeers.serverId, serverId),
        ),
      );
    await db
      .delete(clusterNetworkLinks)
      .where(
        and(
          eq(clusterNetworkLinks.clusterId, clusterId),
          eq(clusterNetworkLinks.serverId, serverId),
        ),
      );
  }
}

async function saveLinks(
  clusterId: string,
  serverId: string,
  peers: { fingerprint: string; path: NetworkPath }[],
  byFingerprint: Map<string, string>,
): Promise<void> {
  const at = nowIso();
  const db = getDb();
  const seen: string[] = [];
  for (const p of peers) {
    const peerServerId = byFingerprint.get(p.fingerprint);
    if (!peerServerId) continue;
    seen.push(peerServerId);
    await db
      .insert(clusterNetworkLinks)
      .values({
        clusterId,
        serverId,
        peerServerId,
        path: p.path,
        checkedAt: at,
      })
      .onConflictDoUpdate({
        target: [
          clusterNetworkLinks.clusterId,
          clusterNetworkLinks.serverId,
          clusterNetworkLinks.peerServerId,
        ],
        set: { path: p.path, checkedAt: at },
      });
  }
  await db
    .delete(clusterNetworkLinks)
    .where(
      and(
        eq(clusterNetworkLinks.clusterId, clusterId),
        eq(clusterNetworkLinks.serverId, serverId),
        seen.length
          ? notInArray(clusterNetworkLinks.peerServerId, seen)
          : undefined,
      ),
    );
}

/**
 * Hands every server of the cluster its peers and reads back its key and how it reaches each one. A server
 * that answers with a key for the first time is handed to the others in the next round, so a new cluster is
 * whole after three; a pass with nothing new is one.
 */
// The servers whose network key a caught copy holds: replaced on the next pass, once (ADR-0050).
const RETIRE = Symbol.for("deplo.cluster.network.retire");
const gr = globalThis as unknown as { [RETIRE]?: Set<string> };
const retiring = () => (gr[RETIRE] ??= new Set());

async function keyHeldByAnother(
  serverId: string,
  publicKey: string,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: clusterNetworkPeers.serverId })
    .from(clusterNetworkPeers)
    .where(
      and(
        eq(clusterNetworkPeers.publicKey, publicKey),
        ne(clusterNetworkPeers.serverId, serverId),
      ),
    )
    .limit(1);
  return row != null;
}

/** A copy of this server was caught: its network key goes with its identity, and the others learn the new one. */
export async function retireNetworkKey(serverId: string): Promise<void> {
  retiring().add(serverId);
  const rows = await getDb()
    .select({ id: clusterNetworkPeers.clusterId })
    .from(clusterNetworkPeers)
    .where(eq(clusterNetworkPeers.serverId, serverId));
  for (const r of rows)
    await syncClusterNetwork(r.id).catch((e) => warn(r.id, e));
}

export async function syncClusterNetwork(clusterId: string): Promise<void> {
  if (await instanceFrozen()) return;
  const servers = await networkServers(clusterId);
  const present = new Set(servers.map((s) => s.id));
  const stale = [...(await keysOf(clusterId)).keys()].filter(
    (id) => !present.has(id),
  );
  if (stale.length) await takeOff(clusterId, stale);
  if (servers.length === 0) return;
  const fingerprints = new Map<string, string>();
  for (const s of servers) {
    const fp = await fingerprintOf(s.id);
    if (fp) fingerprints.set(s.id, fp);
  }
  const byFingerprint = new Map([...fingerprints].map(([id, fp]) => [fp, id]));
  for (let round = 0; round < 3; round++) {
    const keys = await keysOf(clusterId);
    const input: NetworkServer[] = servers
      .filter((s) => fingerprints.has(s.id))
      .map((s) => ({
        serverId: s.id,
        fingerprint: fingerprints.get(s.id)!,
        publicKey: keys.get(s.id)?.publicKey ?? null,
        port: keys.get(s.id)?.port ?? 0,
        addresses: [s.ip, s.host, ...(addresses().get(s.id) ?? [])],
      }));
    let changed = false;
    for (const [serverId, table] of planNetwork(input)) {
      if (await instanceFrozen()) return;
      try {
        const retire = retiring().has(serverId)
          ? (keys.get(serverId)?.publicKey ?? undefined)
          : undefined;
        let r = await setClusterNetwork(serverId, {
          clusterId,
          ...table,
          ...(retire ? { retirePublicKey: retire } : {}),
        });
        // A copy of another server answers with that server's key: it gets one of its own before anyone learns it.
        if (
          r.publicKey &&
          keys.get(serverId)?.publicKey !== r.publicKey &&
          (await keyHeldByAnother(serverId, r.publicKey))
        ) {
          console.warn(
            `[cluster-network] ${serverId}: answered with another server's network key, replacing it`,
          );
          r = await setClusterNetwork(serverId, {
            clusterId,
            ...table,
            retirePublicKey: r.publicKey,
          });
          if (r.publicKey && (await keyHeldByAnother(serverId, r.publicKey)))
            throw new Error(
              `${serverId} still answers with another server's network key`,
            );
        }
        if (retire && r.publicKey && r.publicKey !== retire) {
          retiring().delete(serverId);
          console.log(
            `[cluster-network] ${serverId}: network key replaced after a copy`,
          );
        }
        const before = addresses().get(serverId)?.join(",");
        addresses().set(serverId, r.addresses);
        const had = keys.get(serverId);
        if (
          r.publicKey &&
          (had?.publicKey !== r.publicKey || had?.port !== r.port)
        ) {
          changed = true;
          const at = nowIso();
          await getDb()
            .insert(clusterNetworkPeers)
            .values({
              clusterId,
              serverId,
              publicKey: r.publicKey,
              port: r.port,
              updatedAt: at,
            })
            .onConflictDoUpdate({
              target: [
                clusterNetworkPeers.clusterId,
                clusterNetworkPeers.serverId,
              ],
              set: { publicKey: r.publicKey, port: r.port, updatedAt: at },
            });
        }
        if (before !== r.addresses.join(",")) changed = true;
        await saveLinks(clusterId, serverId, r.peers, byFingerprint);
      } catch (e) {
        // An agent too old for the network stays off it: its streams take the relay, as before.
        if (!(e instanceof AgentClusterNetworkUnsupportedError))
          warn(clusterId, e);
      }
    }
    if (!changed) break;
  }
}

/** After a change of members or leader: off the caller's lane, and it never throws. */
export function syncClusterNetworkSoon(clusterId: string): void {
  void syncClusterNetwork(clusterId).catch((e) => warn(clusterId, e));
}

/** The sweep's job: every cluster's network is put right, and a deleted cluster's servers are taken off it. */
export async function reconcileClusterNetworks(): Promise<void> {
  const db = getDb();
  const live = (
    await db.select({ id: clustersTable.id }).from(clustersTable)
  ).map((c) => c.id);
  const known = await db
    .selectDistinct({ id: clusterNetworkPeers.clusterId })
    .from(clusterNetworkPeers);
  for (const id of new Set([...live, ...known.map((k) => k.id)])) {
    if (await instanceFrozen()) return;
    await syncClusterNetwork(id).catch((e) => warn(id, e));
  }
}

export type MemberNetwork = {
  /** The servers this one reaches only through Deplo's relay. */
  relayed: string[];
  /** The servers this one cannot reach at all now. */
  unreachable: string[];
};

/** How each server of a cluster reaches the others, by server id, as their agents last said. */
export async function clusterNetworkLinksOf(
  clusterId: string,
  serverIds: string[],
): Promise<Map<string, { peerServerId: string; path: NetworkPath }[]>> {
  const out = new Map<string, { peerServerId: string; path: NetworkPath }[]>();
  if (serverIds.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(clusterNetworkLinks)
    .where(
      and(
        eq(clusterNetworkLinks.clusterId, clusterId),
        inArray(clusterNetworkLinks.serverId, serverIds),
      ),
    );
  for (const r of rows) {
    const path: NetworkPath =
      r.path === "direct" || r.path === "relay" ? r.path : "none";
    const list = out.get(r.serverId) ?? [];
    list.push({ peerServerId: r.peerServerId, path });
    out.set(r.serverId, list);
  }
  return out;
}
