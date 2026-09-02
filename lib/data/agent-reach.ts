import "server-only";

import { connectAgent } from "../infra/agent-client";

/**
 * Whether the agent on that machine answers US. Its own place because the answer
 * is asked for on both sides of a migration, and the direction is what matters:
 * enrolling is outbound, everything else is the control plane dialing back.
 */
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
