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

export async function destroyStack(
  deployKey: string,
  opts: { removeVolumes?: boolean } = {},
): Promise<void> {
  const serverId = await owningServerIdForDeployKey(deployKey);
  if (!serverId) return;
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.destroyStack(deployKey, opts.removeVolumes);
    if (!r.ok) throw new Error(r.error || "agent failed to destroy the stack");
  } finally {
    conn.close();
  }
}
