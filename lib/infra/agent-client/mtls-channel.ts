import "server-only";

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

export interface DialTarget {
  address: string;
  serverName: string;
  clientCreds: { certPem: string; keyPem: string; caPem: string };
  pinnedFingerprint: string;
}

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

export async function remoteTarget(server: Server): Promise<DialTarget> {
  const { issueControlPlaneClientCert, caCertPem, IPV4_RE } =
    await import("../../agent/pki");
  const client = await issueControlPlaneClientCert();
  const agent = server.agent!;
  const host = server.ip || server.host;
  return {
    address: `${host}:${agent.port}`,
    serverName: IPV4_RE.test(host) ? "localhost" : host,
    clientCreds: {
      certPem: client.certPem,
      keyPem: client.keyPem,
      caPem: await caCertPem(),
    },
    pinnedFingerprint: agent.certFingerprint,
  };
}

function peerFingerprint(cert: PeerCertificate): string {
  return (cert.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
}

export interface AgentChannel {
  client: GrpcAgentClient;
  hello(timeoutMs?: number): Promise<HelloResponse>;
  assertNetworkCapable(network: string): Promise<void>;
}

export function openChannel(target: DialTarget): AgentChannel {
  const { certPem, keyPem, caPem } = target.clientCreds;
  let trustFailed = false;
  const creds = credentials.createSsl(
    Buffer.from(caPem),
    Buffer.from(keyPem),
    Buffer.from(certPem),
    {
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
    "grpc.ssl_target_name_override": target.serverName,
    "grpc.default_authority": target.serverName,
    "grpc.max_receive_message_length": 256 * 1024 * 1024,
    "grpc.max_send_message_length": 256 * 1024 * 1024,
    "grpc-node.flow_control_window": 16 * 1024 * 1024,
    "grpc.keepalive_time_ms": 30_000,
    "grpc.keepalive_timeout_ms": 10_000,
    "grpc.keepalive_permit_without_calls": 0,
  });

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
