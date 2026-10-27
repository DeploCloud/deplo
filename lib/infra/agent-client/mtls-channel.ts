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
import { isDeploHostServer } from "../../deploy/domains";
import { formatHostPort, isIpLiteral } from "../../host-address";

export interface AgentAddress {
  address: string;
  serverName: string;
  pinnedFingerprint: string;
  agentVersion?: string;
  /** It has linked before: Deplo never dials it again (ADR-0041). */
  linkedOnce?: boolean;
  /** The host running Deplo: until it links, its dial also carries Deplo's own update (ADR-0037). */
  runsDeplo?: boolean;
}

export interface DialTarget extends AgentAddress {
  clientCreds: { certPem: string; keyPem: string; caPem: string };
}

export async function resolveAddress(serverId: string): Promise<AgentAddress> {
  const server = await getServerById(serverId);
  if (!server) {
    throw new AgentUnreachableError(`server ${serverId} not found`);
  }
  if (!server.agent || !server.agent.certFingerprint) {
    throw new AgentUnreachableError(
      `server ${server.name} is not provisioned (no agent has called home yet)`,
    );
  }
  return agentAddress(server);
}

export function agentAddress(server: Server): AgentAddress {
  const agent = server.agent!;
  const host = server.ip || server.host;
  return {
    address: formatHostPort(host, agent.port),
    // SNI forbids an IP servername: an IP host verifies against the localhost DNS SAN signAgentCsr always adds.
    serverName: isIpLiteral(host) ? "localhost" : host,
    pinnedFingerprint: agent.certFingerprint,
    agentVersion: agent.version,
    linkedOnce: !!server.firstLinkedAt,
    runsDeplo: isDeploHostServer(server),
  };
}

export async function withClientCert(
  address: AgentAddress,
): Promise<DialTarget> {
  const { issueControlPlaneClientCert, caCertPem } =
    await import("../../agent/pki");
  const client = await issueControlPlaneClientCert();
  return {
    ...address,
    clientCreds: {
      certPem: client.certPem,
      keyPem: client.keyPem,
      caPem: await caCertPem(),
    },
  };
}

export async function remoteTarget(server: Server): Promise<DialTarget> {
  return withClientCert(agentAddress(server));
}

function peerFingerprint(cert: PeerCertificate): string {
  return (cert.fingerprint256 ?? "").replace(/:/g, "").toLowerCase();
}

export interface AgentChannel {
  client: GrpcAgentClient;
  hello(timeoutMs?: number): Promise<HelloResponse>;
  assertNetworkCapable(network: string): Promise<void>;
  /** Ends this caller's hold; a shared channel stays up for everyone else. */
  close(): void;
}

// grpc-js has no "never": its idle timer is a setTimeout, so this is the longest one Node allows.
const NEVER_IDLE_MS = 2 ** 31 - 1;

/** `linked`: the channel rides an agent link, whose one connection grpc-js must never close for idleness. */
export function openChannel(
  target: DialTarget,
  opts: { linked?: boolean } = {},
): AgentChannel {
  const { certPem, keyPem, caPem } = target.clientCreds;
  let trustFailed = false;
  const creds = credentials.createSsl(
    Buffer.from(caPem),
    Buffer.from(keyPem),
    Buffer.from(certPem),
    {
      // Replaces the hostname check, never the CA chain: the pinned fingerprint is what names the agent.
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
    // grpc-js defaults to 65535 bytes and never tunes it from the measured BDP, so a stream is capped at window/RTT.
    "grpc-node.flow_control_window": 16 * 1024 * 1024,
    "grpc.keepalive_time_ms": 30_000,
    "grpc.keepalive_timeout_ms": 10_000,
    "grpc.keepalive_permit_without_calls": 0,
    ...(opts.linked ? { "grpc.client_idle_timeout_ms": NEVER_IDLE_MS } : {}),
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

  const sayHello = helloOn(client, helloError);
  return {
    client,
    hello: sayHello,
    assertNetworkCapable: networkGate(sayHello),
    close: () => client.close(),
  };
}

/** A caller's channel over an agent link's client; the link, not the caller, closes it. */
export function linkChannel(client: GrpcAgentClient): AgentChannel {
  const sayHello = helloOn(client, toAgentError);
  return {
    client,
    hello: sayHello,
    assertNetworkCapable: networkGate(sayHello),
    close: () => {},
  };
}

function helloOn(client: GrpcAgentClient, mapError: (err: unknown) => Error) {
  return (timeoutMs = HELLO_TIMEOUT_MS) =>
    new Promise<HelloResponse>((resolve, reject) => {
      const deadline = new Date(Date.now() + timeoutMs);
      client.hello(
        {
          contractVersion: ContractVersion.CONTRACT_VERSION_V1,
          controlPlaneVersion: "",
        },
        new Metadata(),
        { deadline },
        (err, resp) => (err ? reject(mapError(err)) : resolve(resp)),
      );
    });
}

/** One caller's view of a shared channel: its own Hello cache and its own close. */
export function callerView(
  channel: AgentChannel,
  close: () => void,
): AgentChannel {
  return {
    client: channel.client,
    hello: channel.hello,
    assertNetworkCapable: networkGate(channel.hello),
    close,
  };
}

function networkGate(hello: AgentChannel["hello"]) {
  let helloOnce: Promise<HelloResponse> | null = null;
  // ADR-0028: an agent that creates no network fails at compose up in docker's words, naming neither host nor fix.
  return async (network: string) => {
    if (!network) return;
    const answer = await (helloOnce ??= hello());
    if (answer.capabilities?.includes(NETWORK_CAPABILITY)) return;
    throw new AgentNetworkUnsupportedError(
      `The agent on this server is too old to place a stack on its own network. ` +
        `Update it from Servers, then deploy again.`,
    );
  };
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
