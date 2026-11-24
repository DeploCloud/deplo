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
  | "expectClusterBackup"
  | "expectClusterVolume"
  | "sendClusterVolume"
  | "setClusterForwarders"
  | "readProxyCertificates"
  | "setClusterNetwork"
  | "setClusterRotations"
  | "setClusterZone"
  | "setGeoTable"
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
        CLUSTER_CALL_TIMEOUT_MS,
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
    async expectClusterBackup(store, sourceFingerprint) {
      await unary(
        client.expectClusterBackup.bind(client),
        { store, sourceFingerprint },
        HELLO_TIMEOUT_MS,
      );
    },
    async expectClusterVolume(volumeName, wipeFirst, sourceFingerprint) {
      await unary(
        client.expectClusterVolume.bind(client),
        { volumeName, wipeFirst, sourceFingerprint },
        HELLO_TIMEOUT_MS,
      );
    },
    async sendClusterVolume(volumeName, targetFingerprint) {
      // As long as the copy takes: a move's copy has no deadline but its own.
      const r = await unary(
        client.sendClusterVolume.bind(client),
        { volumeName, targetFingerprint },
        6 * 3600_000,
      );
      return {
        bytes: Number(r.bytes),
        sha256: r.sha256,
        path: r.path,
        missing: r.missing,
      };
    },
    async setClusterForwarders(table) {
      const r = await unary(
        client.setClusterForwarders.bind(client),
        {
          ...table,
          answers: table.answers ?? [],
          serveAnswers: table.serveAnswers ?? [],
          answerPort: table.answerPort ?? 0,
          answerMaxConns: table.answerMaxConns ?? 0,
          answerMaxWaiting: table.answerMaxWaiting ?? 0,
          proxyRestartsSeenMs: table.proxyRestartsSeenMs ?? 0,
        },
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return {
        held: r.held,
        served: r.served,
        answerRefusals: (r.answerRefusals ?? []).map((a) => ({
          appId: a.appId,
          count: a.count,
          firstUnixMs: Number(a.firstUnixMs),
          lastUnixMs: Number(a.lastUnixMs),
          cap: a.cap,
          waiting: a.waiting,
          memory: a.memory,
        })),
        proxyRestarts: (r.proxyRestarts ?? []).map((p) => ({
          atUnixMs: Number(p.atUnixMs),
          hosts: p.hosts ?? [],
          urgent: p.urgent === true,
          dropped: p.dropped === true,
          zone: p.zone === true,
        })),
      };
    },
    async readProxyCertificates(hosts, known) {
      const r = await unary(
        client.readProxyCertificates.bind(client),
        { hosts, known },
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return (r.certificates ?? []).map((c) => ({
        hosts: c.hosts ?? [],
        certPem: c.certPem,
        keyPem: c.keyPem,
        sha256: c.sha256,
        notAfterUnixMs: Number(c.notAfterUnixMs),
      }));
    },
    async setClusterNetwork(table) {
      const r = await unary(
        client.setClusterNetwork.bind(client),
        { ...table, retirePublicKey: table.retirePublicKey ?? "" },
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
    async setClusterRotations(clusterId, rotations) {
      const r = await unary(
        client.setClusterRotations.bind(client),
        { clusterId, rotations },
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return { rotations: r.rotations };
    },
    async setClusterZone(table) {
      const r = await unary(
        client.setClusterZone.bind(client),
        table,
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return {
        listening: r.listening ?? [],
        problem: r.problem,
        state: r.state,
        answering: r.answering ?? [],
        heard: r.heard,
        geoSha256: r.geoSha256 ?? "",
        certificates: r.certificates ?? [],
      };
    },
    async setGeoTable(sha256, tableGz) {
      const r = await unary(
        client.setGeoTable.bind(client),
        { sha256, tableGz },
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return { sha256: r.sha256, release: r.release };
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
        relayed: s.relayed,
        diskBytes: Number(s.diskBytes ?? 0),
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
