import "server-only";

import { getServerById } from "../../data/servers/roster";
import { agentSelfRpc } from "./agent-self-rpc";
import { backupRpc } from "./backup-rpc";
import type { AgentConnection } from "./connection";
import { consoleRpc } from "./console-rpc";
import { cronRpc } from "./cron-rpc";
import { dataCopyRpc } from "./data-copy-rpc";
import { HELLO_TIMEOUT_MS } from "./deadlines";
import { AgentUnreachableError } from "./errors";
import { filesRpc } from "./files-rpc";
import { hostRpc } from "./host-rpc";
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

export async function connectAgent(serverId: string): Promise<AgentConnection> {
  if (connector) return connector(serverId);
  const target = await resolveTarget(serverId);
  return dial(target);
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
