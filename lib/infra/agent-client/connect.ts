import "server-only";

import { markServerSeen } from "../../data/servers/agent-handshake";
import { getServerById } from "../../data/servers/roster";
import { agentSelfRpc } from "./agent-self-rpc";
import { backupRpc } from "./backup-rpc";
import { captureRpc } from "./capture-rpc";
import type { AgentConnection } from "./connection";
import { consoleRpc } from "./console-rpc";
import { cronRpc } from "./cron-rpc";
import { dataCopyRpc } from "./data-copy-rpc";
import { HELLO_TIMEOUT_MS } from "./deadlines";
import { AgentUnreachableError, assertAgentUsable } from "./errors";
import { filesRpc } from "./files-rpc";
import { hostRpc } from "./host-rpc";
import { inventoryRpc } from "./inventory-rpc";
import { metricsRpc } from "./metrics-rpc";
import { serverChannel } from "./channel-pool";
import type { AgentChannel } from "./mtls-channel";
import { stackRpc } from "./stack-rpc";

function connectionOn(channel: AgentChannel): AgentConnection {
  return {
    hello(timeoutMs = HELLO_TIMEOUT_MS) {
      return channel.hello(timeoutMs);
    },
    ...metricsRpc(channel),
    ...stackRpc(channel),
    ...agentSelfRpc(channel),
    ...dataCopyRpc(channel),
    ...hostRpc(channel),
    ...inventoryRpc(channel),
    ...captureRpc(channel),
    ...backupRpc(channel),
    ...consoleRpc(channel),
    ...cronRpc(channel),
    ...filesRpc(channel),
    close() {
      channel.close();
    },
  };
}

let connector: ((serverId: string) => Promise<AgentConnection | null>) | null =
  null;

/** Stands in for every agent; a server it answers null for is reached for real. */
export function __setAgentConnectorForTest(
  fn?: (serverId: string) => Promise<AgentConnection | null>,
): void {
  connector = fn ?? null;
}

// The sole entry to a host (ADR-0006), over its agent link (ADR-0040): an unreachable agent throws, there is no fallback.
export async function connectAgent(serverId: string): Promise<AgentConnection> {
  const stub = await connector?.(serverId);
  if (stub) return stub;
  const pin = await agentPin(serverId);
  const gate = (channel: AgentChannel) =>
    gateConnection(connectionOn(channel), pin.version, serverId);
  const channel = await serverChannel(serverId, pin.fingerprint);
  try {
    return await gate(channel);
  } catch (e) {
    if (!(e instanceof AgentUnreachableError)) throw e;
  }
  // A link can die before the door hears of it; the failed Hello retired its channel, so this waits for the next link.
  return gate(await serverChannel(serverId, pin.fingerprint));
}

/** Past the minimum-agent gate: Hello, SelfUpdate, the health probe and a Deplo update only (ADR-0037). */
export async function openAgent(serverId: string): Promise<AgentConnection> {
  const stub = await connector?.(serverId);
  if (stub) return stub;
  const pin = await agentPin(serverId);
  return connectionOn(await serverChannel(serverId, pin.fingerprint));
}

// The certificate Deplo pinned when the agent called home: the identity its link must prove.
async function agentPin(
  serverId: string,
): Promise<{ fingerprint: string; version?: string }> {
  const server = await getServerById(serverId);
  if (!server) throw new AgentUnreachableError(`server ${serverId} not found`);
  if (!server.agent?.certFingerprint)
    throw new AgentUnreachableError(
      `server ${server.name} is not provisioned (no agent has called home yet)`,
    );
  return {
    fingerprint: server.agent.certFingerprint,
    version: server.agent.version,
  };
}

// Every call is judged on a live Hello; the caller's first hello() reuses it rather than paying twice.
export async function gateConnection(
  conn: AgentConnection,
  stored: string | undefined,
  serverId: string,
): Promise<AgentConnection> {
  try {
    const hello = await conn.hello();
    if (hello.agentVersion !== stored)
      await markServerSeen(serverId, hello.agentVersion);
    assertAgentUsable(hello.agentVersion);
    let first: typeof hello | null = hello;
    return {
      ...conn,
      hello(timeoutMs) {
        const answer = first;
        first = null;
        return answer ? Promise.resolve(answer) : conn.hello(timeoutMs);
      },
    };
  } catch (e) {
    conn.close();
    throw e;
  }
}
