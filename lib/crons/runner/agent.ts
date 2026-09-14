import "server-only";

import type { AgentConnection } from "../../infra/agent-client/connection";
import {
  AgentCronUnsupportedError,
  AgentUnreachableError,
} from "../../infra/agent-client/errors";
import { connectCronAgent } from "../../infra/agent-client/preflight";

let connector: (serverId: string) => Promise<AgentConnection> =
  connectCronAgent;

// connectFn is how the runner reaches an agent: production never overrides it.
export function connectFn(serverId: string): Promise<AgentConnection> {
  return connector(serverId);
}

// __setCronConnector swaps the agent connector. Test-only.
export function __setCronConnector(
  fn: (serverId: string) => Promise<AgentConnection>,
): void {
  connector = fn;
}

// __resetCronConnector restores the real connector. Test-only.
export function __resetCronConnector(): void {
  connector = connectCronAgent;
}

// agentMessage renders an agent failure as the sentence a run's `error` shows.
export function agentMessage(e: unknown): string {
  if (e instanceof AgentCronUnsupportedError) return e.message;
  if (e instanceof AgentUnreachableError)
    return `The server could not be reached: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
