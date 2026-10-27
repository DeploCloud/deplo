import "server-only";

import { markServerSeen } from "../../data/servers/agent-handshake";
import { getServerById } from "../../data/servers/roster";
import { LINK_WAIT_MS } from "../agent-link/protocol";
import { linkMayCome, waitForLink } from "../agent-link/registry";
import { agentSelfRpc } from "./agent-self-rpc";
import { backupRpc } from "./backup-rpc";
import { captureRpc } from "./capture-rpc";
import type { AgentConnection } from "./connection";
import { consoleRpc } from "./console-rpc";
import { dialOnly } from "./dial-only";
import { cronRpc } from "./cron-rpc";
import { dataCopyRpc } from "./data-copy-rpc";
import { HELLO_TIMEOUT_MS } from "./deadlines";
import { AgentUnreachableError, assertAgentUsable } from "./errors";
import { filesRpc } from "./files-rpc";
import { hostRpc } from "./host-rpc";
import { inventoryRpc } from "./inventory-rpc";
import { metricsRpc } from "./metrics-rpc";
import { leaseChannel } from "./channel-pool";
import {
  openChannel,
  remoteTarget,
  resolveAddress,
  type AgentChannel,
  type DialTarget,
} from "./mtls-channel";
import { stackRpc } from "./stack-rpc";

/** A connection on a channel of its own, closed with it: an override address only. */
export function dial(target: DialTarget): AgentConnection {
  return dialOnly(connectionOn(openChannel(target)));
}

// A link carries every call; a dial only what brings the server onto its link (ADR-0041).
function connectionFor(leased: {
  channel: AgentChannel;
  linked: boolean;
}): AgentConnection {
  const conn = connectionOn(leased.channel);
  return leased.linked ? conn : dialOnly(conn);
}

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

// The sole entry to a host (ADR-0006): an unreachable agent throws, there is no in-process fallback.
export async function connectAgent(serverId: string): Promise<AgentConnection> {
  const stub = await connector?.(serverId);
  if (stub) return stub;
  const address = await resolveAddress(serverId);
  const started = Date.now();
  const gate = (leased: Awaited<ReturnType<typeof leaseChannel>>) =>
    gateConnection(connectionFor(leased), address.agentVersion, serverId);
  const first = await leaseChannel(serverId, address);
  try {
    return await gate(first);
  } catch (e) {
    if (!(e instanceof AgentUnreachableError)) throw e;
    // A shared connection can die where a fresh dial would not; the failed Hello retired it.
    if (first.answeredBefore)
      return gate(await leaseChannel(serverId, address));
    // The panel just started: an agent that stopped listening once it linked is still on its way back.
    if (first.linked || !linkMayCome(serverId, e)) throw e;
    const link = await waitForLink(
      serverId,
      LINK_WAIT_MS - (Date.now() - started),
    );
    if (!link) throw e;
  }
  return gate(await leaseChannel(serverId, address));
}

/** Past the minimum-agent gate: Hello, SelfUpdate, the health probe and a Deplo update only (ADR-0037). */
export async function openAgent(serverId: string): Promise<AgentConnection> {
  const stub = await connector?.(serverId);
  if (stub) return stub;
  const address = await resolveAddress(serverId);
  return connectionFor(await leaseChannel(serverId, address));
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
  if (server.firstLinkedAt)
    throw new AgentUnreachableError(
      `server ${server.name} connects to Deplo on its own: Deplo never dials it`,
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
