import { gzipSync } from "node:zlib";

import { status as GrpcStatus } from "@grpc/grpc-js";

import {
  ContractVersion,
  type DeployRequest,
  HelloResponse,
  HostInfoResponse,
  TraefikConfigResponse,
} from "../../agent/gen/agent";
import { __setAgentConnectorForTest } from "./connect";
import type {
  AgentConnection,
  ClusterForwarderTable,
  ClusterHostStatus,
} from "./connection";
import { __forgetMemberProbes } from "./cluster-host";
import {
  CLUSTER_CAPABILITY,
  CLUSTER_FAILOVER_CAPABILITY,
  CLUSTER_FORWARDERS_CAPABILITY,
  CLUSTER_HOST_CAPABILITY,
  CLUSTER_IMAGES_CAPABILITY,
} from "./hello-capabilities";

export interface FakeClusterHost {
  capabilities: string[];
  /** The agent answers every cluster RPC UNIMPLEMENTED, as one that has Hello but not these. */
  unimplemented: boolean;
  /** No connection opens at all, as to a server that is down. */
  unreachable: boolean;
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
  /** Every name-forwarder table this host's agent was handed, in order (#200). */
  forwarders: ClusterForwarderTable[];
  /** Every deploy request this host's agent was handed, answered ready. */
  deploys: DeployRequest[];
  /** The stacks this host runs, by slug, as readStack shows them; a reroute replaces one. */
  stacks: Record<string, string>;
  reroutes: Parameters<AgentConnection["reroute"]>[0][];
  /** The agent fails every reroute with this message. */
  rerouteError: string;
  /** Every stack and volume call in order, as `reroute:db-main`, `stop:`, `start:`, `destroy:`, `export:`, `import:`. */
  stack: string[];
  opened: string[];
  closed: number;
  /** The leader's event buffer, as its watch serves it: a hello, what came after `since`, then what is pushed. */
  watch: {
    log: {
      seq: number;
      at: string;
      type: string;
      cluster: string;
      data: unknown;
    }[];
    /** The `since` of every watch opened, in order. */
    opens: number[];
    /** Appends an event to the log and hands it to every open watch; returns it. */
    push(type: string, cluster: string, data: unknown): { seq: number };
    /** Ends every open watch, as a leader going away does. */
    drop(): void;
    /** The next watch open fails with this message. */
    refuse: string;
    /** The hello says events were dropped before this watch could read them. */
    gap: boolean;
  };
}

// A volume archive holding one empty file, so a copy has something to carry.
const ONE_FILE_ARCHIVE = (() => {
  const header = Buffer.alloc(512);
  header.write("data", 0, "latin1");
  header.write("00000000000\0", 124, "latin1");
  header.write("0", 156, "latin1");
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
})();

const NOTHING: ClusterHostStatus = {
  installed: false,
  running: false,
  version: "",
  relay: false,
  member: false,
  relayLinks: 0,
};

type Listener = (line: Uint8Array | null) => void;
const listeners = new WeakMap<FakeClusterHost["watch"], Set<Listener>>();
const enc = (v: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(v));

function newWatch(): FakeClusterHost["watch"] {
  const open = new Set<Listener>();
  const w: FakeClusterHost["watch"] = {
    log: [],
    opens: [],
    refuse: "",
    gap: false,
    push(type, cluster, data) {
      const e = {
        seq: (w.log.at(-1)?.seq ?? 0) + 1,
        at: new Date().toISOString(),
        type,
        cluster,
        data,
      };
      w.log.push(e);
      for (const l of open) l(enc(e));
      return e;
    },
    drop() {
      for (const l of [...open]) l(null);
    },
  };
  listeners.set(w, open);
  return w;
}

async function* watchStream(
  h: FakeClusterHost,
  since: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  const w = h.watch;
  w.opens.push(since);
  if (w.refuse) {
    const message = w.refuse;
    w.refuse = "";
    throw new Error(message);
  }
  const queue: (Uint8Array | null)[] = [];
  let wake: (() => void) | null = null;
  const listener: Listener = (l) => {
    queue.push(l);
    wake?.();
  };
  listeners.get(w)!.add(listener);
  try {
    yield enc({ hello: true, head: w.log.at(-1)?.seq ?? 0, gap: w.gap });
    for (const e of w.log) if (e.seq > since) yield enc(e);
    while (true) {
      if (!queue.length) await new Promise<void>((r) => (wake = r));
      const l = queue.shift();
      if (l === null) return;
      if (l) yield l;
    }
  } finally {
    listeners.get(w)!.delete(listener);
  }
}

/** The server agent answering a leader's calls, behind `__setAgentConnectorForTest`: the one fake every cluster test uses. */
export function fakeClusterHosts(): {
  host(serverId: string, over?: Partial<FakeClusterHost>): FakeClusterHost;
  restore(): void;
} {
  const hosts = new Map<string, FakeClusterHost>();
  __forgetMemberProbes();
  __setAgentConnectorForTest(async (serverId) => {
    const h = hosts.get(serverId);
    if (!h) return null;
    if (h.unreachable) throw new Error("the server is offline");
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
          dockerAvailable: true,
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
      deploy: async function* (req: DeployRequest) {
        h.deploys.push(req);
        yield {
          seq: 1,
          result: {
            ready: true,
            error: "",
            commitSha: "",
            observedPort: 0,
            builtWith: "",
            listeningPorts: [],
          },
        };
      },
      readStack: async (slug) => ({
        exists: slug in h.stacks,
        yaml: h.stacks[slug] ?? "",
      }),
      reroute: async (req) => {
        h.stack.push(`reroute:${req.slug}`);
        if (h.rerouteError) return { ok: false, error: h.rerouteError };
        h.reroutes.push(req);
        h.stacks[req.slug] = req.composeYaml;
        return { ok: true, error: "" };
      },
      stopStack: async (slug) => {
        h.stack.push(`stop:${slug}`);
        return { ok: true, error: "" };
      },
      startStack: async (slug) => {
        h.stack.push(`start:${slug}`);
        return { ok: true, error: "" };
      },
      destroyStack: async (slug) => {
        h.stack.push(`destroy:${slug}`);
        return { ok: true, error: "" };
      },
      exportVolume: async function* (name) {
        h.stack.push(`export:${name}`);
        yield ONE_FILE_ARCHIVE;
      },
      importVolume: async (name, _wipe, chunks) => {
        h.stack.push(`import:${name}`);
        let bytesWritten = 0;
        for await (const c of chunks) bytesWritten += c.length;
        return {
          ok: true,
          error: "",
          bytesWritten,
          sha256: "",
          dropped: { links: 0, special: 0, names: [] },
        };
      },
      checkPort: async () => ({ available: true, reason: "" }),
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
      clusterWatch: (since) => watchStream(h, since),
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
      setClusterForwarders: (table) =>
        guard(() => {
          h.forwarders.push(table);
          return { held: table.hold.length, served: table.serve.length };
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
          CLUSTER_FAILOVER_CAPABILITY,
          CLUSTER_FORWARDERS_CAPABILITY,
          "hostops",
        ],
        unimplemented: false,
        unreachable: false,
        status: { ...NOTHING },
        leader: (_m, p) => p,
        installs: [],
        removes: 0,
        calls: [],
        memberCalls: [],
        proxy: { yaml: "", applied: 0, refuse: "" },
        imageCopy: () => ({ alreadyPresent: false, bytes: 1, pruned: [] }),
        imageCopies: [],
        forwarders: [],
        deploys: [],
        stacks: {},
        reroutes: [],
        rerouteError: "",
        stack: [],
        opened: [],
        closed: 0,
        watch: newWatch(),
        ...over,
      };
      hosts.set(serverId, h);
      return h;
    },
    restore: () => __setAgentConnectorForTest(),
  };
}
