import "server-only";

import { connectAgent } from "../infra/agent-client/connect";

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
