import "server-only";

import type { AgentConnection } from "./connection";
import {
  CLUSTER_CALL_TIMEOUT_MS,
  CLUSTER_INSTALL_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
} from "./deadlines";
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
