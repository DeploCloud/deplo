import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { requireActiveTeamId } from "../../membership";
import { loadDeployment, appInTeam } from "../app-graph-load";
import { loadDeploymentLogs } from "../deployment-logs";
import { hasAppCapability } from "../node-access";
import type { LogLine } from "../../types/deployment";

export async function getLogs(deploymentId: string): Promise<LogLine[]> {
  const teamId = await requireActiveTeamId();
  const dep = await loadDeployment(deploymentId);
  if (!dep) return [];
  if (!(await appInTeam(dep.appId, teamId))) return [];
  if (!(await hasAppCapability(dep.appId, "view_logs"))) return [];
  return loadDeploymentLogs(deploymentId);
}

export async function getQueuePosition(
  deploymentId: string,
): Promise<number | null> {
  await requireActiveTeamId();
  const [target] = await getDb()
    .select({
      appId: deploymentsTable.appId,
      status: deploymentsTable.status,
      serverId: sql<
        string | null
      >`coalesce(${deploymentsTable.serverId}, ${appsTable.serverId})`,
    })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(eq(deploymentsTable.id, deploymentId))
    .limit(1);
  if (!target) return null;
  // Per-app reach, not the team-only check above: without it a scoped member could probe deployment ids.
  if (!(await hasAppCapability(target.appId, "view_logs"))) return null;
  if (target.status !== "queued" || !target.serverId) return null;

  const queued = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(
      and(
        eq(deploymentsTable.status, "queued"),
        sql`coalesce(${deploymentsTable.serverId}, ${appsTable.serverId}) = ${target.serverId}`,
      ),
    )
    .orderBy(asc(deploymentsTable.createdAt), asc(deploymentsTable.seq));
  const idx = queued.findIndex((r) => r.id === deploymentId);
  return idx === -1 ? null : idx + 1;
}
