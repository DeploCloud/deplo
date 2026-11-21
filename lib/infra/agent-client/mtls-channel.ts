import "server-only";

import {
  credentials,
  Metadata,
  type ClientReadableStream,
  type ServiceError,
} from "@grpc/grpc-js";
import {
  AgentClient as GrpcAgentClient,
  ContractVersion,
  type HelloResponse,
} from "../../agent/gen/agent";
import { streamEvents } from "../stream-events";
import { HELLO_TIMEOUT_MS, STREAM_BYTES_PAUSE_ABOVE } from "./deadlines";
import { AgentNetworkUnsupportedError, toAgentError } from "./errors";
import { NETWORK_CAPABILITY } from "./hello-capabilities";

export interface AgentChannel {
  client: GrpcAgentClient;
  hello(timeoutMs?: number): Promise<HelloResponse>;
  assertNetworkCapable(network: string): Promise<void>;
  /** Ends this caller's hold; a shared channel stays up for everyone else. */
  close(): void;
}

// grpc-js has no "never": its idle timer is a setTimeout, so this is the longest one Node allows.
const NEVER_IDLE_MS = 2 ** 31 - 1;

/** An agent link's channel, opened by the door over the link's own mTLS session (agent-link/agent-tls.ts). */
export function openChannel(address: string): AgentChannel {
  const client = new GrpcAgentClient(address, credentials.createInsecure(), {
    "grpc.default_authority": "localhost",
    "grpc.max_receive_message_length": 256 * 1024 * 1024,
    "grpc.max_send_message_length": 256 * 1024 * 1024,
    // grpc-js defaults to 65535 bytes and never tunes it from the measured BDP, so a stream is capped at window/RTT.
    "grpc-node.flow_control_window": 16 * 1024 * 1024,
    "grpc.keepalive_time_ms": 30_000,
    "grpc.keepalive_timeout_ms": 10_000,
    "grpc.keepalive_permit_without_calls": 0,
    "grpc.client_idle_timeout_ms": NEVER_IDLE_MS,
  });
  const sayHello = helloOn(client, toAgentError);
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

/** One caller's view of a shared channel: its own Hello cache. The link, not the caller, closes it. */
export function callerView(channel: AgentChannel): AgentChannel {
  return {
    client: channel.client,
    hello: channel.hello,
    assertNetworkCapable: networkGate(channel.hello),
    close: () => {},
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
