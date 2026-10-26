import net from "node:net";
import { webcrypto } from "node:crypto";

import {
  Server as GrpcServer,
  ServerCredentials,
  status as GrpcStatus,
  type ServerUnaryCall,
  type ServerWritableStream,
} from "@grpc/grpc-js";
import * as x509 from "@peculiar/x509";
import { createWebSocketStream, WebSocket } from "ws";

import {
  AgentService,
  ContractVersion,
  HelloResponse,
  StackResult,
  type FollowLogsRequest,
  type LinkAddresses,
  type LogChunk,
  type MetricsSample,
  type MetricsStreamRequest,
} from "../../agent/gen/agent";
import { certFingerprint, issueAgentServerCert } from "../../agent/pki";
import { CERT_RENEWAL_CAPABILITY } from "../../agent/cert-renewal";
import { AGENT_VERSION } from "../../version";
import {
  LINK_CERT_HEADER,
  LINK_PATH,
  LINK_SUBPROTOCOL,
} from "../agent-link/protocol";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface FakeAgent {
  /** Where the control plane dials it, on 127.0.0.1. */
  port: number;
  certPem: string;
  fingerprint: string;
  /** TCP connections the control plane opened to it, and how many are still open. */
  connections(): { opened: number; open: number };
  /** Sends a line to every log stream a caller holds open. */
  log(line: string): void;
  /** Sends a frame to every telemetry stream a caller holds open. */
  sample(frame: MetricsSample): void;
  /** Stops answering: every connection, open or new, is accepted and dropped. */
  refuse(on: boolean): void;
  /** The open connections went stale: the next bytes on each are answered with a reset. */
  goStale(): void;
  /** Every pair of panel addresses the control plane sent it, oldest first. */
  sentPairs(): LinkAddresses[];
  /** Whether its own port still takes connections; StopListening closes it, as the real agent does. */
  listening(): boolean;
  /** Links in to the door on 127.0.0.1 and serves on the link, as the real agent does. */
  link(
    doorPort: number,
    opts?: { claim?: string; pingEveryMs?: number },
  ): Promise<FakeLink>;
  stop(): Promise<void>;
}

export interface FakeLink {
  /** The door's answer to the upgrade: 101 when it took the link. */
  status: number;
  retryAfter: string | null;
  /** The code the link ended with. */
  closed: Promise<number>;
  /** The agent dies: the connection drops with no close. */
  drop(): void;
  /** The agent freezes: it neither reads nor sends, and the connection stays open. */
  freeze(): void;
}

// A real gRPC agent with real mTLS on loopback, behind a TCP hop the test can watch and break.
export async function startFakeAgent(
  opts: {
    version?: string;
    dockerAvailable?: boolean;
    capabilities?: string[];
    /** The pair it keeps and reports in Hello; none at all when unset. */
    linkAddresses?: LinkAddresses;
    /** What SelfUpdate turns it into, without a restart; unset, it does not update. */
    updatesTo?: {
      version: string;
      capabilities: string[];
      linkAddresses?: LinkAddresses;
    };
    /** A door on 127.0.0.1 it links into whenever it holds a panel address and no link. */
    door?: number;
  } = {},
): Promise<FakeAgent> {
  let pair = opts.linkAddresses;
  let version = opts.version ?? AGENT_VERSION;
  let capabilities = opts.capabilities ?? [];
  let listening = true;
  const sentPairs: LinkAddresses[] = [];
  const streams = new Set<ServerWritableStream<FollowLogsRequest, LogChunk>>();
  const telemetry = new Set<
    ServerWritableStream<MetricsStreamRequest, MetricsSample>
  >();
  const backends: GrpcServer[] = [];
  const links = new Set<FakeLink>();
  let inject: (link: WebSocket) => void = () => {};
  let backendPort = 0;
  let pendingKeyPem = "";
  const first = await issueAgentServerCert(["127.0.0.1"]);
  const agent = {
    certPem: first.certPem,
    fingerprint: await certFingerprint(first.certPem),
  };

  const serve = async (certPem: string, keyPem: string) => {
    const server = new GrpcServer();
    server.addService(AgentService, {
      hello(_call: unknown, cb: (e: null, r: HelloResponse) => void) {
        cb(
          null,
          HelloResponse.fromPartial({
            contractVersion: ContractVersion.CONTRACT_VERSION_V1,
            agentVersion: version,
            dockerAvailable: opts.dockerAvailable ?? true,
            capabilities: [CERT_RENEWAL_CAPABILITY, ...capabilities],
            hostArch: "amd64",
            linkAddresses: pair,
            listening,
          }),
        );
      },
      selfUpdate(
        _call: unknown,
        cb: (
          e: { code: number; details: string } | null,
          r?: { version: string; restarting: boolean },
        ) => void,
      ) {
        const next = opts.updatesTo;
        if (!next)
          return cb({ code: GrpcStatus.UNIMPLEMENTED, details: "no update" });
        ({ version, capabilities } = next);
        pair = next.linkAddresses;
        cb(null, { version, restarting: true });
        dialDoor();
      },
      // The real agent closes its port only when asked over its link: over the port, it cannot tell the link works.
      stopListening(
        call: ServerUnaryCall<unknown, unknown>,
        cb: (e: { code: number; details: string } | null, r?: object) => void,
      ) {
        if (call.getPeer() !== "unknown")
          return cb({
            code: GrpcStatus.FAILED_PRECONDITION,
            details: "ask over the agent link",
          });
        if (listening) hop.close();
        listening = false;
        cb(null, {});
      },
      setLinkAddresses(
        call: { request: LinkAddresses },
        cb: (e: null, r: LinkAddresses) => void,
      ) {
        pair = { ...call.request };
        sentPairs.push(pair);
        cb(null, pair);
        dialDoor();
      },
      followLogs(call: ServerWritableStream<FollowLogsRequest, LogChunk>) {
        streams.add(call);
        call.on("cancelled", () => streams.delete(call));
      },
      streamMetrics(
        call: ServerWritableStream<MetricsStreamRequest, MetricsSample>,
      ) {
        telemetry.add(call);
        call.on("cancelled", () => telemetry.delete(call));
      },
      async renewalCsr(
        _call: unknown,
        cb: (e: null, r: { csrPem: string }) => void,
      ) {
        const keys = (await webcrypto.subtle.generateKey(
          { name: "Ed25519" },
          true,
          ["sign", "verify"],
        )) as unknown as CryptoKeyPair;
        const csr = await x509.Pkcs10CertificateRequestGenerator.create({
          name: "CN=deplo-agent",
          keys,
          signingAlgorithm: { name: "Ed25519" },
        });
        const pkcs8 = await webcrypto.subtle.exportKey(
          "pkcs8",
          keys.privateKey as unknown as webcrypto.CryptoKey,
        );
        pendingKeyPem = x509.PemConverter.encode(pkcs8, "PRIVATE KEY");
        cb(null, { csrPem: csr.toString("pem") });
      },
      // The real agent hot-swaps: open connections keep the old cert, new ones get the new.
      async installRenewedCert(
        call: { request: { certPem: string } },
        cb: (e: null, r: StackResult) => void,
      ) {
        await serve(call.request.certPem, pendingKeyPem);
        agent.certPem = call.request.certPem;
        agent.fingerprint = await certFingerprint(call.request.certPem);
        cb(null, StackResult.fromPartial({ ok: true }));
      },
    });
    const creds = () =>
      ServerCredentials.createSsl(
        Buffer.from(first.caPem),
        [
          {
            cert_chain: Buffer.from(certPem),
            private_key: Buffer.from(keyPem),
          },
        ],
        true,
      );
    backendPort = await new Promise<number>((resolve, reject) =>
      server.bindAsync("127.0.0.1:0", creds(), (err, port) =>
        err ? reject(err) : resolve(port),
      ),
    );
    const injector = server.createConnectionInjector(creds());
    inject = (ws) => injector.injectConnection(createWebSocketStream(ws));
    backends.push(server);
  };
  await serve(first.certPem, first.keyPem);

  let opened = 0;
  let refusing = false;
  const open = new Map<net.Socket, { stale: boolean; up: net.Socket }>();
  const hop = net.createServer((sock) => {
    opened++;
    if (refusing) return void sock.destroy();
    const up = net.connect(backendPort, "127.0.0.1");
    const state = { stale: false, up };
    open.set(sock, state);
    const drop = () => {
      open.delete(sock);
      sock.destroy();
      up.destroy();
    };
    sock.on("data", (d) => {
      if (!state.stale) return void up.write(d);
      open.delete(sock);
      up.destroy();
      sock.resetAndDestroy();
    });
    up.on("data", (d) => void (state.stale || sock.write(d)));
    sock.on("close", drop).on("error", drop);
    up.on("close", drop).on("error", drop);
  });
  const port = await new Promise<number>((resolve) =>
    hop.listen(0, "127.0.0.1", () =>
      resolve((hop.address() as net.AddressInfo).port),
    ),
  );

  const dialDoor = () => {
    if (opts.door === undefined || !pair?.primary || links.size > 0) return;
    fake.link(opts.door).catch(() => {});
  };

  const fake: FakeAgent = {
    port,
    get certPem() {
      return agent.certPem;
    },
    get fingerprint() {
      return agent.fingerprint;
    },
    connections: () => ({ opened, open: open.size }),
    sentPairs: () => [...sentPairs],
    listening: () => listening,
    log(line) {
      for (const s of streams) s.write({ data: Buffer.from(line) } as LogChunk);
    },
    sample(frame) {
      for (const s of telemetry) s.write(frame);
    },
    refuse(on) {
      refusing = on;
      if (on) for (const sock of [...open.keys()]) sock.destroy();
    },
    goStale() {
      for (const state of open.values()) state.stale = true;
    },
    async link(doorPort, opts = {}) {
      const { ws, status, retryAfter } = await upgrade(doorPort, {
        claim: opts.claim ?? agent.fingerprint,
      });
      if (!ws) {
        const refused = Promise.resolve(0);
        return { status, retryAfter, closed: refused, drop() {}, freeze() {} };
      }
      const pinging = opts.pingEveryMs
        ? setInterval(() => ws.ping(), opts.pingEveryMs)
        : undefined;
      const closed = new Promise<number>((r) =>
        ws.once("close", (code) => {
          clearInterval(pinging);
          r(code);
        }),
      );
      const link: FakeLink = {
        status,
        retryAfter,
        closed,
        drop: () => ws.terminate(),
        freeze: () => {
          clearInterval(pinging);
          ws.pause();
        },
      };
      links.add(link);
      void closed.then(() => links.delete(link));
      inject(ws);
      return link;
    },
    async stop() {
      for (const s of [...streams, ...telemetry]) s.end();
      for (const link of links) link.drop();
      for (const sock of [...open.keys()]) sock.destroy();
      await new Promise((r) => hop.close(r));
      for (const b of backends) b.forceShutdown();
    },
  };
  return fake;
}

/** One upgrade request at the door, written the way anything on the internet could write it. */
export async function knock(
  doorPort: number,
  opts: {
    path?: string;
    protocol?: string | null;
    claim?: string | null;
    forwardedFor?: string;
  } = {},
): Promise<{ status: number; retryAfter: string | null }> {
  const { ws, status, retryAfter } = await upgrade(doorPort, opts);
  ws?.terminate();
  return { status, retryAfter };
}

async function upgrade(
  doorPort: number,
  opts: {
    path?: string;
    protocol?: string | null;
    claim?: string | null;
    forwardedFor?: string;
  },
): Promise<{
  ws: WebSocket | null;
  status: number;
  retryAfter: string | null;
}> {
  const headers: Record<string, string> = {};
  if (opts.claim) headers[LINK_CERT_HEADER] = opts.claim;
  if (opts.forwardedFor) headers["x-forwarded-for"] = opts.forwardedFor;
  const protocol =
    opts.protocol === undefined ? LINK_SUBPROTOCOL : opts.protocol;
  const ws = new WebSocket(
    `ws://127.0.0.1:${doorPort}${opts.path ?? LINK_PATH}`,
    protocol ? [protocol] : [],
    { headers, perMessageDeflate: false },
  );
  return new Promise((resolve, reject) => {
    // Errors after the answer are the link ending, which `closed` reports.
    ws.on("error", reject);
    ws.once("open", () => resolve({ ws, status: 101, retryAfter: null }));
    ws.once("unexpected-response", (req, res) => {
      req.destroy();
      resolve({
        ws: null,
        status: res.statusCode ?? 0,
        retryAfter: res.headers["retry-after"] ?? null,
      });
    });
  });
}

/** Polls until `check` holds; the network settles a tick after the call that caused it. */
export async function eventually(
  check: () => boolean,
  ms = 2_000,
): Promise<void> {
  const until = performance.now() + ms;
  while (!check()) {
    if (performance.now() > until) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 10));
  }
}
