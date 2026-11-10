import { status as GrpcStatus } from "@grpc/grpc-js";

import {
  ContractVersion,
  HelloResponse,
  HostInfoResponse,
  TraefikConfigResponse,
} from "../../agent/gen/agent";
import { __setAgentConnectorForTest } from "./connect";
import type { AgentConnection, ClusterHostStatus } from "./connection";
import {
  CLUSTER_CAPABILITY,
  CLUSTER_HOST_CAPABILITY,
  CLUSTER_IMAGES_CAPABILITY,
} from "./hello-capabilities";

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
  /** Every setClusterMember the agent was asked, in order. */
  memberCalls: { member: boolean; relays: string[] }[];
  /** The proxy stack of this host, as hostInfo reads it and traefikConfig replaces it. */
  proxy: { yaml: string; applied: number; refuse: string };
  /** What the agent answers a copy request; throws to fail it. */
  imageCopy: (
    imageRef: string,
    targetFingerprint: string,
    keep: number,
  ) => { alreadyPresent: boolean; bytes: number; pruned: string[] };
  /** Every copyClusterImage the agent was asked, in order. */
  imageCopies: { imageRef: string; targetFingerprint: string; keep: number }[];
  opened: string[];
  closed: number;
}

const NOTHING: ClusterHostStatus = {
  installed: false,
  running: false,
  version: "",
  relay: false,
  member: false,
  relayLinks: 0,
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
          h.status = {
            ...h.status,
            installed: true,
            running: true,
            version,
            relay,
          };
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
      hostInfo: async () =>
        HostInfoResponse.fromPartial({ traefikComposeYaml: h.proxy.yaml }),
      traefikConfig: async (req) => {
        if (h.proxy.refuse)
          return TraefikConfigResponse.fromPartial({
            ok: false,
            error: h.proxy.refuse,
          });
        if (req.composeYaml) h.proxy.yaml = req.composeYaml;
        h.proxy.applied++;
        return TraefikConfigResponse.fromPartial({ ok: true });
      },
      setClusterMember: (member, relays) =>
        guard(() => {
          h.memberCalls.push({ member, relays });
          h.status = { ...h.status, member };
          return { member, relayLinks: 0 };
        }),
      copyClusterImage: (imageRef, targetFingerprint, keep) =>
        guard(() => {
          h.imageCopies.push({ imageRef, targetFingerprint, keep });
          return h.imageCopy(imageRef, targetFingerprint, keep);
        }),
      close: () => void h.closed++,
    };
    return conn as AgentConnection;
  });
  return {
    host(serverId, over = {}) {
      const h: FakeClusterHost = {
        capabilities: [
          CLUSTER_HOST_CAPABILITY,
          CLUSTER_CAPABILITY,
          CLUSTER_IMAGES_CAPABILITY,
          "hostops",
        ],
        unimplemented: false,
        status: { ...NOTHING },
        leader: (_m, p) => p,
        installs: [],
        removes: 0,
        calls: [],
        memberCalls: [],
        proxy: { yaml: "", applied: 0, refuse: "" },
        imageCopy: () => ({ alreadyPresent: false, bytes: 1, pruned: [] }),
        imageCopies: [],
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
