import { status as GrpcStatus } from "@grpc/grpc-js";

import { ContractVersion, HelloResponse } from "../../agent/gen/agent";
import { __setAgentConnectorForTest } from "./connect";
import type { AgentConnection, ClusterHostStatus } from "./connection";
import { CLUSTER_HOST_CAPABILITY } from "./hello-capabilities";

export interface FakeClusterHost {
  capabilities: string[];
  /** The agent answers every cluster RPC UNIMPLEMENTED, as one that has Hello but not these. */
  unimplemented: boolean;
  status: ClusterHostStatus;
  /** What the leader answers a forwarded call; throws to refuse it. */
  leader: (method: string, payload: Uint8Array) => Uint8Array;
  installs: { version: string; relay: boolean; urls: string[] }[];
  removes: number;
  calls: { method: string; payload: Uint8Array }[];
  opened: string[];
  closed: number;
}

const NOTHING: ClusterHostStatus = {
  installed: false,
  running: false,
  version: "",
  relay: false,
};

/** The server agent answering a leader's calls, behind `__setAgentConnectorForTest`: the one fake every cluster test uses. */
export function fakeClusterHosts(): {
  host(serverId: string, over?: Partial<FakeClusterHost>): FakeClusterHost;
  restore(): void;
} {
  const hosts = new Map<string, FakeClusterHost>();
  __setAgentConnectorForTest(async (serverId) => {
    const h = hosts.get(serverId);
    if (!h) return null;
    h.opened.push(serverId);
    const guard = <T>(fn: () => T): Promise<T> =>
      h.unimplemented
        ? Promise.reject(
            Object.assign(new Error("unimplemented"), {
              code: GrpcStatus.UNIMPLEMENTED,
            }),
          )
        : Promise.resolve().then(fn);
    const conn: Partial<AgentConnection> = {
      hello: async () =>
        HelloResponse.fromPartial({
          agentVersion: "9.9.9",
          contractVersion: ContractVersion.CONTRACT_VERSION_V1,
          capabilities: h.capabilities,
        }),
      clusterStatus: () => guard(() => ({ ...h.status })),
      installCluster: (version, binaries, relay) =>
        guard(() => {
          h.installs.push({
            version,
            relay,
            urls: Object.values(binaries).map((b) => b.url),
          });
          h.status = { installed: true, running: true, version, relay };
          return { version, running: true };
        }),
      removeCluster: () =>
        guard(() => {
          h.removes++;
          const removed = h.status.installed;
          h.status = { ...NOTHING };
          return { removed };
        }),
      clusterCall: (method, payload) =>
        guard(() => {
          h.calls.push({ method, payload });
          return h.leader(method, payload);
        }),
      close: () => void h.closed++,
    };
    return conn as AgentConnection;
  });
  return {
    host(serverId, over = {}) {
      const h: FakeClusterHost = {
        capabilities: [CLUSTER_HOST_CAPABILITY],
        unimplemented: false,
        status: { ...NOTHING },
        leader: (_m, p) => p,
        installs: [],
        removes: 0,
        calls: [],
        opened: [],
        closed: 0,
        ...over,
      };
      hosts.set(serverId, h);
      return h;
    },
    restore: () => __setAgentConnectorForTest(),
  };
}
