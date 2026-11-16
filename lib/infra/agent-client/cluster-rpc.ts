import "server-only";

import type { AgentConnection } from "./connection";
import {
  CLUSTER_CALL_TIMEOUT_MS,
  CLUSTER_IMAGE_COPY_TIMEOUT_MS,
  CLUSTER_INSTALL_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
} from "./deadlines";
import { streamEvents } from "../stream-events";
import { toAgentError } from "./errors";
import { unary, type AgentChannel } from "./mtls-channel";

export function clusterRpc(
  channel: AgentChannel,
): Pick<
  AgentConnection,
  | "installCluster"
  | "removeCluster"
  | "clusterStatus"
  | "clusterCall"
  | "setClusterMember"
  | "clusterWatch"
  | "copyClusterImage"
  | "expectClusterImage"
  | "setClusterForwarders"
  | "setClusterNetwork"
  | "setClusterReplicas"
  | "clusterReplicaStatus"
> {
  const { client } = channel;
  return {
    async installCluster(version, binaries, relay) {
      const r = await unary(
        client.installCluster.bind(client),
        { version, binaries, relay },
        CLUSTER_INSTALL_TIMEOUT_MS,
      );
      return { version: r.version, running: r.running };
    },
    async removeCluster() {
      const r = await unary(
        client.removeCluster.bind(client),
        {},
        CLUSTER_INSTALL_TIMEOUT_MS,
      );
      return { removed: r.removed };
    },
    async clusterStatus() {
      const r = await unary(
        client.clusterStatus.bind(client),
        {},
        HELLO_TIMEOUT_MS,
      );
      return {
        installed: r.installed,
        running: r.running,
        version: r.version,
        relay: r.relay,
        member: r.member,
        relayLinks: r.relayLinks,
      };
    },
    async setClusterMember(member, relays, pins) {
      const r = await unary(
        client.setClusterMember.bind(client),
        {
          member,
          relays,
          clusterId: pins?.clusterId ?? "",
          leaderFingerprints: pins?.leaders ?? [],
        },
        HELLO_TIMEOUT_MS,
      );
      return { member: r.member, relayLinks: r.relayLinks };
    },
    clusterWatch(since) {
      return (async function* () {
        // No deadline: a watch lives until Deplo or the leader ends it.
        for await (const l of streamEvents(client.clusterWatch({ since }), {
          normalise: toAgentError,
        }))
          yield l.line;
      })();
    },
    async copyClusterImage(imageRef, targetFingerprint, keep) {
      const r = await unary(
        client.copyClusterImage.bind(client),
        { imageRef, targetFingerprint, keep },
        CLUSTER_IMAGE_COPY_TIMEOUT_MS,
      );
      return {
        alreadyPresent: r.alreadyPresent,
        bytes: Number(r.bytes),
        pruned: r.pruned,
      };
    },
    async expectClusterImage(imageRef, sourceFingerprint, keep) {
      await unary(
        client.expectClusterImage.bind(client),
        { imageRef, sourceFingerprint, keep },
        HELLO_TIMEOUT_MS,
      );
    },
    async setClusterForwarders(table) {
      const r = await unary(
        client.setClusterForwarders.bind(client),
        {
          ...table,
          entrances: table.entrances ?? [],
          serveEntrances: table.serveEntrances ?? [],
          entrancePort: table.entrancePort ?? 0,
        },
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return { held: r.held, served: r.served };
    },
    async setClusterNetwork(table) {
      const r = await unary(
        client.setClusterNetwork.bind(client),
        table,
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return {
        publicKey: r.publicKey,
        port: r.port,
        addresses: r.addresses,
        peers: r.peers.map((p) => ({
          fingerprint: p.fingerprint,
          path:
            p.path === "direct" || p.path === "relay"
              ? (p.path as "direct" | "relay")
              : "none",
        })),
      };
    },
    async setClusterReplicas(table) {
      const r = await unary(
        client.setClusterReplicas.bind(client),
        table,
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return { entries: r.entries };
    },
    async clusterReplicaStatus() {
      const r = await unary(
        client.clusterReplicaStatus.bind(client),
        {},
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return r.replicas.map((s) => ({
        appId: s.appId,
        role: s.role === "sending" || s.role === "receiving" ? s.role : "idle",
        connected: s.connected,
        streams: s.streams,
        synced: s.synced,
        appliedAt: s.appliedAt,
        bytes: Number(s.bytes ?? 0),
        error: s.error,
        fromServerId: s.fromServerId,
      }));
    },
    async clusterCall(method, payload, timeoutMs = CLUSTER_CALL_TIMEOUT_MS) {
      const r = await unary(
        client.clusterCall.bind(client),
        { method, payload },
        timeoutMs,
      );
      return r.payload;
    },
  };
}
