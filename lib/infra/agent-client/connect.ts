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
import {
  openChannel,
  remoteTarget,
  resolveTarget,
  type DialTarget,
} from "./mtls-channel";
import { stackRpc } from "./stack-rpc";

export function dial(target: DialTarget): AgentConnection {
  const channel = openChannel(target);
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
      channel.client.close();
    },
  };
}

let connector: ((serverId: string) => Promise<AgentConnection>) | null = null;

export function __setAgentConnectorForTest(
  fn?: (serverId: string) => Promise<AgentConnection>,
): void {
  connector = fn ?? null;
}

// The sole entry to a host (ADR-0006): an unreachable agent throws, there is no in-process fallback.
export async function connectAgent(serverId: string): Promise<AgentConnection> {
  if (connector) return connector(serverId);
  const target = await resolveTarget(serverId);
  return gateConnection(dial(target), target.agentVersion, serverId);
}

/** Past the minimum-agent gate: Hello, SelfUpdate, the health probe and a Deplo update only (ADR-0037). */
export async function openAgent(serverId: string): Promise<AgentConnection> {
  if (connector) return connector(serverId);
  return dial(await resolveTarget(serverId));
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

export async function connectAgentAt(
  serverId: string,
  overrides: { ip?: string; host?: string; agentPort?: number },
): Promise<AgentConnection> {
  const server = await getServerById(serverId);
  if (!server) throw new AgentUnreachableError(`server ${serverId} not found`);
  if (!server.agent?.certFingerprint)
    throw new AgentUnreachableError(
      `server ${server.name} is not provisioned (no agent has called home yet)`,
    );
  return dial(
    await remoteTarget({
      ...server,
      ip: overrides.ip ?? server.ip,
      host: overrides.host ?? server.host,
      agent: {
        ...server.agent,
        port: overrides.agentPort ?? server.agent.port,
      },
    }),
  );
}
