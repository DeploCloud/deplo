import "server-only";

import { connectAgent } from "../infra/agent-client/connect";

// sourceAgentReachable - whether the agent on that machine answers the control plane dialing it.
export async function sourceAgentReachable(serverId: string): Promise<boolean> {
  try {
    const conn = await connectAgent(serverId);
    try {
      await conn.hello();
    } finally {
      conn.close();
    }
    return true;
  } catch {
    return false;
  }
}
