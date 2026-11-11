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
  | "setClusterForwarders"
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
    async setClusterMember(member, relays) {
      const r = await unary(
        client.setClusterMember.bind(client),
        { member, relays },
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
    async setClusterForwarders(table) {
      const r = await unary(
        client.setClusterForwarders.bind(client),
        table,
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return { held: r.held, served: r.served };
    },
    async clusterCall(method, payload) {
      const r = await unary(
        client.clusterCall.bind(client),
        { method, payload },
        CLUSTER_CALL_TIMEOUT_MS,
      );
      return r.payload;
    },
  };
}
