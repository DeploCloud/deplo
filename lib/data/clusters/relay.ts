import "server-only";

import * as cloudflare from "../../cloudflare/tunnel-api";
import { decryptSecretOrThrow } from "../../crypto";
import { getDb } from "../../db/client";
import { eq } from "drizzle-orm";
import {
  clusterMembers as clusterMembersTable,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import {
  panelTunnelReachesHost,
  panelTunnelIngress,
  panelTunnelToken,
  withPanelTunnel,
} from "../../deploy/panel-tunnel-stack";
import { isDeploHostServer } from "../../deploy/domains";
import { panelRoute, withPanelRoute } from "../../deploy/traefik-stack";
import {
  callClusterRelay,
  clusterLeaderStatus,
  installClusterLeader,
  setClusterMember,
} from "../../infra/agent-client/cluster-host";
import { deploHostServer } from "../instance-settings/settings-store";
import { loadPanelTunnel } from "../instance-settings/panel-tunnel-store";
import { getServerById } from "../servers/roster";
import { leaderHost } from "./host";
import { clusterMemberServerIds, getClusterById } from "./roster";

// Every party of a cluster reaches the others through the relay on Deplo's machine (ADR-0044). This module owns what
// that relay is told and where its door sits in the proxy; it is internal, so the callers hold the gates.

export type RelayParty = { fingerprint: string; role: "leader" | "member" };
export type RelayRoster = { cluster: string; parties: RelayParty[] };

export type RosterPush = {
  roster: RelayRoster;
  /** The members whose agent was told to dial the relays. */
  dialing: string[];
  /** Why a relay or a member could not be told, by server. */
  failed: { serverId: string; message: string }[];
};

async function fingerprintOf(serverId: string): Promise<string | null> {
  const server = await getServerById(serverId);
  const fp = server?.agent?.certFingerprint?.toLowerCase() ?? "";
  // A server not enrolled yet holds no certificate; the relay refuses a roster with anything but a sha256 in it.
  return /^[0-9a-f]{64}$/.test(fp) ? fp : null;
}

/** Who a cluster's relay lets through: its leader, then each member, by the certificate their server holds. */
export async function clusterRoster(
  clusterId: string,
  memberServerIds: string[] = [],
): Promise<RelayRoster> {
  const parties: RelayParty[] = [];
  const cluster = await getClusterById(clusterId);
  if (cluster) {
    const host = await leaderHost(cluster);
    const fp = host ? await fingerprintOf(host.id) : null;
    if (fp) parties.push({ fingerprint: fp, role: "leader" });
    for (const id of new Set(memberServerIds)) {
      const m = await fingerprintOf(id);
      if (m) parties.push({ fingerprint: m, role: "member" });
    }
  }
  return { cluster: clusterId, parties };
}

const encode = (v: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(v));

/**
 * Sends a cluster's roster to every relay and tells each member's agent to dial them. An empty roster
 * (a deleted cluster, or nobody left) makes the relay forget the cluster and cuts its parties off at once.
 */
export async function pushClusterRoster(
  clusterId: string,
  given?: string[],
): Promise<RosterPush> {
  const memberServerIds = given ?? (await clusterMemberServerIds(clusterId));
  const roster = await clusterRoster(clusterId, memberServerIds);
  const out: RosterPush = { roster, dialing: [], failed: [] };
  const relayHost = await deploHostServer();
  if (!relayHost) {
    out.failed.push({
      serverId: "",
      message: "Deplo's own machine is not connected as a server.",
    });
    return out;
  }
  try {
    await callClusterRelay(relayHost.id, "relay.roster", encode(roster));
  } catch (e) {
    out.failed.push({ serverId: relayHost.id, message: messageOf(e) });
  }
  if (roster.parties.length > 0)
    for (const id of new Set(memberServerIds)) {
      try {
        await setClusterMember(id, true);
        out.dialing.push(id);
      } catch (e) {
        out.failed.push({ serverId: id, message: messageOf(e) });
      }
    }
  return out;
}

/** A server that left the cluster stops dialing; its agent forgets it was ever a member. */
export async function releaseClusterMember(serverId: string): Promise<void> {
  await setClusterMember(serverId, false);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The clusters a server is a party of: collect them before it is removed, to push their rosters once it is gone. */
export async function clustersOfServer(serverId: string): Promise<string[]> {
  const server = await getServerById(serverId);
  const rows = await getDb()
    .select({ id: clustersTable.id, leader: clustersTable.leaderServerId })
    .from(clustersTable);
  const member = await getDb()
    .select({ id: clusterMembersTable.clusterId })
    .from(clusterMembersTable)
    .where(eq(clusterMembersTable.serverId, serverId));
  const onDeploHost = !!server && isDeploHostServer(server);
  const inside = new Set(member.map((m) => m.id));
  return rows
    .filter(
      (r) =>
        inside.has(r.id) ||
        r.leader === serverId ||
        (r.leader === null && onDeploHost),
    )
    .map((r) => r.id);
}

/** Pushes the roster of each given cluster; a failure is logged, never thrown, because the caller's own change already happened. */
export async function pushClusterRosters(clusterIds: string[]): Promise<void> {
  for (const id of clusterIds) {
    try {
      const r = await pushClusterRoster(id);
      for (const f of r.failed)
        console.warn(`[cluster-relay] ${id}: ${f.serverId} ${f.message}`);
    } catch (e) {
      console.warn(`[cluster-relay] ${id}: ${messageOf(e)}`);
    }
  }
}

/** A server's certificate changed (renewed, re-enrolled): the clusters it is a party of name the new one, and the old one is cut off. */
export async function pushRostersForServer(serverId: string): Promise<void> {
  try {
    await pushClusterRosters(await clustersOfServer(serverId));
  } catch (e) {
    console.warn(`[cluster-relay] ${serverId}: ${messageOf(e)}`);
  }
}

export type RelayRouteChange = "on" | "off" | "unchanged" | "unmanaged";

/** Puts the relay's route in the proxy of Deplo's machine while a cluster exists, and takes it out when none does. */
export async function syncClusterRelayRoute(): Promise<RelayRouteChange> {
  const host = await deploHostServer();
  if (!host) return "unmanaged";
  const wanted =
    (
      await getDb()
        .select({ id: clustersTable.id })
        .from(clustersTable)
        .limit(1)
    ).length > 0;
  const { fetchHostInfo, withTraefikStackLock, applyTraefikConfig } =
    await import("../../infra/agent-client/host-ops");
  return withTraefikStackLock(host.id, async () => {
    const yaml = (await fetchHostInfo(host.id)).traefikComposeYaml;
    const route = yaml ? panelRoute(yaml) : null;
    if (!yaml || !route) return "unmanaged";
    const tunnel = await loadPanelTunnel();
    const connectorOn = tunnel ? panelTunnelReachesHost(yaml) : wanted;
    if ((route.relay === true) === wanted && connectorOn === wanted)
      return "unchanged";

    let next = withPanelRoute(yaml, { ...route, relay: wanted });
    let restoreIngress: (() => Promise<unknown>) | null = null;
    if (tunnel) {
      const token = decryptSecretOrThrow(
        tunnel.apiTokenEnc,
        "the Cloudflare API token",
      );
      const connector = panelTunnelToken(yaml);
      if (connector) next = withPanelTunnel(next, connector, { relay: wanted });
      await cloudflare.setTunnelIngress(
        token,
        tunnel.accountId,
        tunnel.tunnelId,
        panelTunnelIngress(tunnel.hostname, route.target, wanted),
      );
      restoreIngress = () =>
        cloudflare.setTunnelIngress(
          token,
          tunnel.accountId,
          tunnel.tunnelId,
          panelTunnelIngress(tunnel.hostname, route.target, !wanted),
        );
    }
    try {
      const res = await applyTraefikConfig(host.id, { composeYaml: next });
      if (!res.ok)
        throw new Error(
          res.error || "The proxy on this server refused the change",
        );
    } catch (e) {
      await restoreIngress?.().catch(() => {});
      throw e;
    }
    return wanted ? "on" : "off";
  });
}

export type ClusterRelayStart = {
  /** The relay was installed or started on Deplo's machine just now. */
  started: boolean;
  route: RelayRouteChange;
  /** Why the proxy could not take the route, when it could not: the relay then runs unreachable from outside. */
  routeError: string | null;
  serverName: string;
};

/** Agent 0 runs the relay while any cluster exists, and its route sits in the proxy. Throws why not. */
export async function ensureClusterRelay(): Promise<ClusterRelayStart> {
  const host = await deploHostServer();
  if (!host)
    throw new Error(
      "Deplo's own machine is not connected as a server yet, so there is nowhere to start the relay.",
    );
  const here = await clusterLeaderStatus(host.id);
  const started = !(here.installed && here.running && here.relay);
  if (started) await installClusterLeader(host.id, { relay: true });
  let route: RelayRouteChange = "unmanaged";
  let routeError: string | null = null;
  try {
    route = await syncClusterRelayRoute();
  } catch (e) {
    routeError = messageOf(e);
  }
  return { started, route, routeError, serverName: host.name };
}

/** The sweep's job: the route and the relay's rosters are put right again after an update, a restart or a change made elsewhere. */
export async function reconcileClusterRelay(): Promise<void> {
  const rows = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable);
  await syncClusterRelayRoute();
  await pushClusterRosters(rows.map((r) => r.id));
}
