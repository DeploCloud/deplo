import "server-only";

import { eq } from "drizzle-orm";
import { getServerById } from "../../data/servers/roster";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { listAppMembers } from "../../data/clusters/placement";
import { connectAgent } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
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

/** Every server that runs the stack: one, or each member a cluster App's replicas are placed on. */
export async function owningServerIdsForDeployKey(
  deployKey: string,
): Promise<string[]> {
  const first = await owningServerIdForDeployKey(deployKey);
  if (!first) return [];
  if (prNumberFromDeployKey(deployKey) !== null) return [first];
  const p = await loadAppGraphBySlug(appSlugFromDeployKey(deployKey));
  if (!p?.clusterId) return [first];
  const all = await listAppMembers(p);
  return [first, ...all.filter((id) => id !== first)];
}

// One call on every server that runs the stack; all are tried, and the first failure is the one reported.
async function onEachServer(
  deployKey: string,
  run: (conn: AgentConnection) => Promise<{ ok: boolean; error: string }>,
  failed: string,
): Promise<void> {
  let first: unknown = null;
  for (const serverId of await owningServerIdsForDeployKey(deployKey)) {
    try {
      const conn = await connectAgent(serverId);
      try {
        const r = await run(conn);
        if (!r.ok) throw new Error(r.error || failed);
      } finally {
        conn.close();
      }
    } catch (e) {
      first ??= e;
    }
  }
  if (first) throw first;
}

// `services` names compose services to stop instead of the whole stack; empty stops everything.
export async function stopContainer(
  deployKey: string,
  services: string[] = [],
): Promise<void> {
  await onEachServer(
    deployKey,
    (conn) => conn.stopStack(deployKey, services),
    "agent failed to stop the stack",
  );
}

export async function startContainer(deployKey: string): Promise<void> {
  await onEachServer(
    deployKey,
    (conn) => conn.startStack(deployKey),
    "agent failed to start the stack",
  );
}

export async function destroyStack(
  deployKey: string,
  opts: { removeVolumes?: boolean } = {},
): Promise<void> {
  await onEachServer(
    deployKey,
    (conn) => conn.destroyStack(deployKey, opts.removeVolumes),
    "agent failed to destroy the stack",
  );
}
