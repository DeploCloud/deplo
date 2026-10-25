import net from "node:net";
import { webcrypto } from "node:crypto";

import {
  Server as GrpcServer,
  ServerCredentials,
  type ServerWritableStream,
} from "@grpc/grpc-js";
import * as x509 from "@peculiar/x509";

import {
  AgentService,
  ContractVersion,
  HelloResponse,
  StackResult,
  type FollowLogsRequest,
  type LogChunk,
} from "../../agent/gen/agent";
import { certFingerprint, issueAgentServerCert } from "../../agent/pki";
import { CERT_RENEWAL_CAPABILITY } from "../../agent/cert-renewal";
import { AGENT_VERSION } from "../../version";

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
  /** Stops answering: every connection, open or new, is accepted and dropped. */
  refuse(on: boolean): void;
  /** The open connections went stale: the next bytes on each are answered with a reset. */
  goStale(): void;
  stop(): Promise<void>;
}

// A real gRPC agent with real mTLS on loopback, behind a TCP hop the test can watch and break.
export async function startFakeAgent(
  opts: { version?: string } = {},
): Promise<FakeAgent> {
  const streams = new Set<ServerWritableStream<FollowLogsRequest, LogChunk>>();
  const backends: GrpcServer[] = [];
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
            agentVersion: opts.version ?? AGENT_VERSION,
            dockerAvailable: true,
            capabilities: [CERT_RENEWAL_CAPABILITY],
            hostArch: "amd64",
          }),
        );
      },
      followLogs(call: ServerWritableStream<FollowLogsRequest, LogChunk>) {
        streams.add(call);
        call.on("cancelled", () => streams.delete(call));
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
    backendPort = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        "127.0.0.1:0",
        ServerCredentials.createSsl(
          Buffer.from(first.caPem),
          [
            {
              cert_chain: Buffer.from(certPem),
              private_key: Buffer.from(keyPem),
            },
          ],
          true,
        ),
        (err, port) => (err ? reject(err) : resolve(port)),
      ),
    );
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

  return {
    port,
    get certPem() {
      return agent.certPem;
    },
    get fingerprint() {
      return agent.fingerprint;
    },
    connections: () => ({ opened, open: open.size }),
    log(line) {
      for (const s of streams) s.write({ data: Buffer.from(line) } as LogChunk);
    },
    refuse(on) {
      refusing = on;
      if (on) for (const sock of [...open.keys()]) sock.destroy();
    },
    goStale() {
      for (const state of open.values()) state.stale = true;
    },
    async stop() {
      for (const s of streams) s.end();
      for (const sock of [...open.keys()]) sock.destroy();
      await new Promise((r) => hop.close(r));
      for (const b of backends) b.forceShutdown();
    },
  };
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
