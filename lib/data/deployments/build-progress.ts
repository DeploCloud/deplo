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

// getLogs returns a build's log.
export async function getLogs(deploymentId: string): Promise<LogLine[]> {
  const teamId = await requireActiveTeamId();
  const dep = await loadDeployment(deploymentId);
  if (!dep) return [];
  if (!(await appInTeam(dep.appId, teamId))) return [];
  if (!(await hasAppCapability(dep.appId, "view_logs"))) return [];
  return loadDeploymentLogs(deploymentId);
}

// getQueuePosition gives a queued deployment's 1-based slot in its server's build queue.
export async function getQueuePosition(
  deploymentId: string,
): Promise<number | null> {
  // Establish the active team (and its 2FA gate); the reach check below is
  // per-app, folder and role scope included, not the token-only clamp
  // `appInTeam` gives, so a scoped-role member can't probe a deployment id.
  await requireActiveTeamId();
  const [target] = await getDb()
    .select({
      appId: deploymentsTable.appId,
      status: deploymentsTable.status,
      // Effective owning server: the row's own, else the app's (queue is per-server).
      serverId: sql<
        string | null
      >`coalesce(${deploymentsTable.serverId}, ${appsTable.serverId})`,
    })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(eq(deploymentsTable.id, deploymentId))
    .limit(1);
  if (!target) return null;
  if (!(await hasAppCapability(target.appId, "view_logs"))) return null;
  if (target.status !== "queued" || !target.serverId) return null;

  // The SAME rows and order `pickNext` scans.
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
