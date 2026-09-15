import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { cronJobs as cronJobsTable } from "../../db/schema/control-plane/crons";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  canMountHostVolumes,
  requireActiveTeamId,
  requireCapability,
} from "../../membership";
import { loadAppGraph } from "../app-graph-load";
import { requireFolderCapabilityForApp } from "../folder-access";
import { requireAppCapability } from "../node-access";
import type { JobRow } from "./dto";

export async function gateApp(appId: string) {
  await requireAppCapability(appId, "manage_crons");
  await requireFolderCapabilityForApp(appId, "manage_crons");
  const teamId = await requireActiveTeamId();
  const app = await loadAppGraph(appId);
  if (!app || app.teamId !== teamId) throw new Error("App not found");
  return { app, teamId };
}

export async function assertRunAsAllowed(
  app: { id: string } | null,
  user: string | null | undefined,
): Promise<void> {
  if (!app || !user) return;
  const name = user.split(":")[0].toLowerCase();
  if (name !== "root" && name !== "0") return;
  const row = (
    await getDb()
      .select({ hostReachBy: appsTable.hostReachBy })
      .from(appsTable)
      .where(eq(appsTable.id, app.id))
      .limit(1)
  )[0];
  if (row?.hostReachBy && !(await canMountHostVolumes()))
    throw new Error(
      'This app reaches the server, so running a job as root needs the "Bind server folders" permission. Run it as another user.',
    );
}

export async function gateDatabase(databaseId: string) {
  const { teamId } = await requireCapability("manage_crons");
  await requireCapability("open_database_console");
  const rows = await getDb()
    .select({ id: databasesTable.id, cronEnabled: databasesTable.cronEnabled })
    .from(databasesTable)
    .where(
      and(eq(databasesTable.id, databaseId), eq(databasesTable.teamId, teamId)),
    )
    .limit(1);
  if (rows.length === 0) throw new Error("Database not found");
  return { teamId, database: rows[0] };
}

export async function gateJob(jobId: string): Promise<{
  job: JobRow;
  teamId: string;
  targetEnabled: boolean;
  app: Awaited<ReturnType<typeof gateApp>>["app"] | null;
}> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .select()
    .from(cronJobsTable)
    .where(and(eq(cronJobsTable.id, jobId), eq(cronJobsTable.teamId, teamId)))
    .limit(1);
  const job = rows[0];
  if (!job) throw new Error("Cron job not found");
  if (job.appId) {
    const { app } = await gateApp(job.appId);
    return { job, teamId, targetEnabled: app.cronEnabled, app };
  }
  if (job.databaseId) {
    const { database } = await gateDatabase(job.databaseId);
    return { job, teamId, targetEnabled: database.cronEnabled, app: null };
  }
  throw new Error("Cron job not found");
}
