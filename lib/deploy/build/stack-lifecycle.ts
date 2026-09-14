import "server-only";

import { eq } from "drizzle-orm";
import { getServerById } from "../../data/servers/roster";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { connectAgent } from "../../infra/agent-client/connect";
import { appSlugFromDeployKey, prNumberFromDeployKey } from "../deploy-key";
import { loadAppGraphBySlug } from "../../data/app-graph-load";

export async function owningServerIdForDeployKey(
  deployKey: string,
): Promise<string | null> {
  const p = await loadAppGraphBySlug(appSlugFromDeployKey(deployKey));
  if (!p) return null;
  // A preview may be pinned to a machine of its own: `startDeployment` sends it to
  // `preview_server_id ?? server_id`, so every lifecycle verb reads the same column.
  let serverId = p.serverId;
  if (prNumberFromDeployKey(deployKey) !== null) {
    const rows = await getDb()
      .select({ previewServerId: appsTable.previewServerId })
      .from(appsTable)
      .where(eq(appsTable.id, p.id))
      .limit(1);
    serverId = rows[0]?.previewServerId ?? p.serverId;
  }
  const server = await getServerById(serverId);
  return server ? server.id : null;
}

// stopContainer stops a project's stack via the owning server's agent StopStack.
export async function stopContainer(deployKey: string): Promise<void> {
  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return;
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.stopStack(deployKey);
    if (!r.ok) throw new Error(r.error || "agent failed to stop the stack");
  } finally {
    conn.close();
  }
}

// startContainer starts a previously stopped stack via the owning agent's StartStack.
export async function startContainer(deployKey: string): Promise<void> {
  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return;
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.startStack(deployKey);
    if (!r.ok) throw new Error(r.error || "agent failed to start the stack");
  } finally {
    conn.close();
  }
}

// destroyStack stops and removes a project's stack via the owning agent's DestroyStack.
export async function destroyStack(
  deployKey: string,
  opts: { removeVolumes?: boolean } = {},
): Promise<void> {
  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return;
  const conn = await connectAgent(serverId);
  try {
    // `removeVolumes` is left UNSET for an App: its named volumes hold the user's
    // data and must survive a teardown they can undo.
    const r = await conn.destroyStack(deployKey, opts.removeVolumes);
    if (!r.ok) throw new Error(r.error || "agent failed to destroy the stack");
  } finally {
    conn.close();
  }
}
