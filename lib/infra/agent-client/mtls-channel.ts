import "server-only";

// The control plane's side of the second system boundary (ADR-0006).

import {
  credentials,
  Metadata,
  status as GrpcStatus,
  type ClientReadableStream,
  type ServiceError,
} from "@grpc/grpc-js";
import type { PeerCertificate } from "node:tls";
import {
  AgentClient as GrpcAgentClient,
  ContractVersion,
  type HelloResponse,
} from "../../agent/gen/agent";
import { getServerById } from "../../data/servers/roster";
import type { Server } from "../../types/server";
import { streamEvents } from "../stream-events";
import { HELLO_TIMEOUT_MS, STREAM_BYTES_PAUSE_ABOVE } from "./deadlines";
import {
  AgentNetworkUnsupportedError,
  AgentUnreachableError,
  toAgentError,
} from "./errors";
import { NETWORK_CAPABILITY } from "./hello-capabilities";

/** A resolved dial target. The pin is REQUIRED for every server (trust that EXACT
 *  cert) - there is no un-pinned in-process agent. */
export interface DialTarget {
  address: string;
  serverName: string;
  clientCreds: { certPem: string; keyPem: string; caPem: string };
  /** sha256(DER) hex of the agent cert we will accept. */
  pinnedFingerprint: string;
}

// resolveTarget resolves a server to a dial target, pinning the agent cert
// recorded at bootstrap.
export async function resolveTarget(serverId: string): Promise<DialTarget> {
  const server = await getServerById(serverId);
  if (!server) {
    throw new AgentUnreachableError(`server ${serverId} not found`);
  }
  if (!server.agent || !server.agent.certFingerprint) {
    throw new AgentUnreachableError(
      `server ${server.name} is not provisioned (no agent has called home yet)`,
    );
  }
  return remoteTarget(server);
}

// remoteTarget builds a dial target for a provisioned agent.
export async function remoteTarget(server: Server): Promise<DialTarget> {
  const { issueControlPlaneClientCert, caCertPem, IPV4_RE } =
    await import("../../agent/pki");
  const client = await issueControlPlaneClientCert();
  const agent = server.agent!;
  const host = server.ip || server.host;
  return {
    address: `${host}:${agent.port}`,
    // TLS SNI / authority. For an IP host, verify against `localhost` instead -
    // signAgentCsr ALWAYS adds it as a DNS SAN, so verification still passes.
    serverName: IPV4_RE.test(host) ? "localhost" : host,
    clientCreds: {
      certPem: client.certPem,
      keyPem: client.keyPem,
      caPem: await caCertPem(),
    },
    pinnedFingerprint: agent.certFingerprint,
  };
}

/** Normalise a tls PeerCertificate fingerprint ("AA:BB:..") to lowercase hex. */
function peerFingerprint(cert: PeerCertificate): string {
  return (cert.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
}

/** One open mTLS channel to an agent: the raw client plus the two calls every
 *  domain wrapper needs before it can speak. */
export interface AgentChannel {
  client: GrpcAgentClient;
  hello(timeoutMs?: number): Promise<HelloResponse>;
  assertNetworkCapable(network: string): Promise<void>;
}

// openChannel opens the pinned mTLS channel to one agent.
export function openChannel(target: DialTarget): AgentChannel {
  const { certPem, keyPem, caPem } = target.clientCreds;
  // Set by checkServerIdentity below when the peer's cert is not the pinned one.
  // (Recovering it by matching on the error string would mean parsing a message
  // grpc-js owns and can reword at any release.)
  let trustFailed = false;
  const creds = credentials.createSsl(
    Buffer.from(caPem),
    Buffer.from(keyPem),
    Buffer.from(certPem),
    {
      // Standard CA-chain + hostname verification still runs; this fires AFTER it.
      checkServerIdentity: (_host, cert) => {
        const got = peerFingerprint(cert);
        if (got !== target.pinnedFingerprint) {
          trustFailed = true;
          return new Error(
            `agent cert fingerprint mismatch: pinned ${target.pinnedFingerprint}, got ${got}`,
          );
        }
        return undefined;
      },
    },
  );
  const client = new GrpcAgentClient(target.address, creds, {
    // Verify the agent cert against this name (covered by the cert SANs).
    "grpc.ssl_target_name_override": target.serverName,
    "grpc.default_authority": target.serverName,
    // Large messages: a streamed build context rides inside the Deploy request.
    "grpc.max_receive_message_length": 256 * 1024 * 1024,
    "grpc.max_send_message_length": 256 * 1024 * 1024,
    // HTTP/2 flow-control window. grpc-js defaults to 65535 bytes and, unlike grpc-go,
    // never tunes it from the measured BDP - so a stream's ceiling is window/RTT no
    // matter how fat the link is.
    "grpc-node.flow_control_window": 16 * 1024 * 1024,
    // Keepalive, for the LONG-LIVED streams (StreamMetrics runs for the life of this
    // process; logs/attach for hours).
    "grpc.keepalive_time_ms": 30_000,
    "grpc.keepalive_timeout_ms": 10_000,
    // Only ping while an RPC is in flight. Matches the agent's
    // PermitWithoutStream:false - a ping on a wholly idle channel would be
    // refused, and we have no reason to send one.
    "grpc.keepalive_permit_without_calls": 0,
  });

  // Only `hello` normalises this way, because only the health prober consumes the
  // distinction; every other RPC keeps seeing the plain AgentUnreachableError.
  const helloError = (err: unknown): Error => {
    const e = toAgentError(err);
    if (
      e instanceof AgentUnreachableError &&
      (trustFailed || e.code === GrpcStatus.UNAUTHENTICATED)
    ) {
      return new AgentUnreachableError(e.message, e.code, true);
    }
    return e;
  };

  const sayHello = (timeoutMs = HELLO_TIMEOUT_MS) =>
    new Promise<HelloResponse>((resolve, reject) => {
      const deadline = new Date(Date.now() + timeoutMs);
      client.hello(
        {
          contractVersion: ContractVersion.CONTRACT_VERSION_V1,
          controlPlaneVersion: "",
        },
        new Metadata(),
        { deadline },
        (err, resp) => (err ? reject(helloError(err)) : resolve(resp)),
      );
    });

  // An agent that predates ADR-0028 creates no network, and `compose up` then fails
  // with docker's own words, naming neither the server nor the fix. Asked once per
  // connection.
  let helloOnce: Promise<HelloResponse> | null = null;
  const assertNetworkCapable = async (network: string) => {
    if (!network) return;
    const hello = await (helloOnce ??= sayHello());
    if (hello.capabilities?.includes(NETWORK_CAPABILITY)) return;
    throw new AgentNetworkUnsupportedError(
      `The agent on this server is too old to place a stack on its own network. ` +
        `Update it from Servers, then deploy again.`,
    );
  };

  return { client, hello: sayHello, assertNetworkCapable };
}

// unary wraps a plain unary call whose response IS the DTO.
export function unary<Req, Resp>(
  call: (
    req: Req,
    md: Metadata,
    opts: { deadline: Date },
    cb: (err: ServiceError | null, resp: Resp) => void,
  ) => unknown,
  req: Req,
  deadlineMs: number,
): Promise<Resp> {
  return new Promise<Resp>((resolve, reject) => {
    call(
      req,
      new Metadata(),
      { deadline: new Date(Date.now() + deadlineMs) },
      (err, resp) => (err ? reject(toAgentError(err)) : resolve(resp)),
    );
  });
}

// bytesFrom bridges a server-stream of byte frames into raw Buffers, bounded so a
// slow consumer pauses the source instead of buffering the whole artifact here.
export async function* bytesFrom<T extends { data?: Uint8Array | undefined }>(
  stream: ClientReadableStream<T>,
): AsyncGenerator<Buffer, void, unknown> {
  for await (const chunk of streamEvents<T>(stream, {
    pauseAbove: STREAM_BYTES_PAUSE_ABOVE,
    normalise: toAgentError,
  })) {
    if (chunk.data && chunk.data.length) yield Buffer.from(chunk.data);
  }
}
