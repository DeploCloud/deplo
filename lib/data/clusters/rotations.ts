import "server-only";

import { desc, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  serverRetiredCerts,
  servers as serversTable,
} from "../../db/schema/control-plane/servers";
import { setClusterRotations } from "../../infra/agent-client/cluster-host";
import { messageOf } from "../../utils";
import { getServerById } from "../servers/roster";
import { leaderHost, leaderHostOf } from "./host";
import { clusterMemberServerIds, getClusterById } from "./roster";

// A cluster member's key rotates only once every server of its clusters holds the next one, and a table that names
// the old one accepts the new (ADR-0050): a server off at the promotion still reaches it while Deplo is down.

export type KeyRotation = { from: string; to: string };

const isFingerprint = (fp: string | null | undefined): fp is string =>
  !!fp && /^[0-9a-f]{64}$/.test(fp);

/** The servers of a cluster: its members, and every server whose leader may lead it. */
export async function clusterPartyIds(clusterId: string): Promise<string[]> {
  const cluster = await getClusterById(clusterId);
  if (!cluster) return [];
  const ids = new Set(await clusterMemberServerIds(clusterId));
  for (const id of new Set([cluster.leaderServerId, null])) {
    const host = await leaderHostOf(id);
    if (host) ids.add(host.id);
  }
  return [...ids];
}

/** Each server's next certificate, for those with one staged: the relay lets it in before it is installed. */
export async function nextFingerprints(
  serverIds: string[],
): Promise<Map<string, string>> {
  if (serverIds.length === 0) return new Map();
  const rows = await getDb()
    .select({
      id: serversTable.id,
      next: serversTable.agentNextCertFingerprint,
    })
    .from(serversTable)
    .where(inArray(serversTable.id, serverIds));
  return new Map(
    rows
      .map((r) => [r.id, r.next?.toLowerCase() ?? ""] as const)
      .filter(([, fp]) => isFingerprint(fp)),
  );
}

/** A cluster's key rotations: the last one each server made, and the one staged now. */
export async function clusterRotations(
  clusterId: string,
): Promise<KeyRotation[]> {
  const ids = await clusterPartyIds(clusterId);
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = await db
    .select({
      id: serversTable.id,
      current: serversTable.agentCertFingerprint,
      next: serversTable.agentNextCertFingerprint,
    })
    .from(serversTable)
    .where(inArray(serversTable.id, ids));
  const retired = new Map<string, string>();
  for (const r of await db
    .select({
      serverId: serverRetiredCerts.serverId,
      fingerprint: serverRetiredCerts.fingerprint,
    })
    .from(serverRetiredCerts)
    .where(inArray(serverRetiredCerts.serverId, ids))
    .orderBy(desc(serverRetiredCerts.retiredAt)))
    if (!retired.has(r.serverId)) retired.set(r.serverId, r.fingerprint);
  const out: KeyRotation[] = [];
  for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const current = r.current?.toLowerCase();
    if (!isFingerprint(current)) continue;
    const old = retired.get(r.id)?.toLowerCase();
    if (isFingerprint(old) && old !== current)
      out.push({ from: old, to: current });
    const next = r.next?.toLowerCase();
    if (isFingerprint(next) && next !== current)
      out.push({ from: current, to: next });
  }
  return out;
}

/**
 * Hands a server's staged certificate to every server, relay and leader of its clusters. Answers who could not
 * take it, by name: none means the key may be installed.
 */
export async function announceNextKey(serverId: string): Promise<string[]> {
  const { clustersOfServer, pushClusterRoster } = await import("./relay");
  const { pushLeaderRoster } = await import("./leader-sync");
  const missing = new Set<string>();
  const name = async (id: string) =>
    (await getServerById(id))?.name ?? (id || "Deplo's own machine");
  const miss = async (id: string, why: unknown) => {
    console.warn(
      `[cert-renewal] ${serverId}: ${id} cannot take the next key: ${messageOf(why)}`,
    );
    missing.add(await name(id));
  };
  for (const clusterId of await clustersOfServer(serverId)) {
    const rotations = await clusterRotations(clusterId);
    const pushed = await pushClusterRoster(clusterId);
    for (const f of pushed.failed) await miss(f.serverId, f.message);
    for (const id of await clusterPartyIds(clusterId)) {
      try {
        await setClusterRotations(id, clusterId, rotations);
      } catch (e) {
        await miss(id, e);
      }
    }
    const cluster = await getClusterById(clusterId);
    if (!cluster) continue;
    try {
      await pushLeaderRoster(cluster, { requireRotations: true });
    } catch (e) {
      await miss((await leaderHost(cluster))?.id ?? "", e);
    }
  }
  return [...missing].sort();
}
