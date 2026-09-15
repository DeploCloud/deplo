import "server-only";

import { cache } from "@/lib/request-cache";
import { and, eq, inArray, type SQL } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  cronJobs as cronJobsTable,
  cronRuns as cronRunsTable,
} from "../../db/schema/control-plane/crons";
import { currentCapabilities, requireActiveTeamId } from "../../membership";
import { primaryServiceOf } from "../../crons/runner/targets";
import type { CronTargetKind } from "../../types/cron";
import { listApps } from "../apps/listing";
import { listDatabases } from "../databases/rows";
import { type CronJobDTO, type CronJobsView, toJobDTO } from "./dto";
import { gateApp, gateDatabase } from "./gates";
import { envKeysFor } from "./job-env";
import { appServices, routedServiceOf } from "./target-services";

export async function jobsFor(where: SQL): Promise<CronJobDTO[]> {
  const rows = await getDb()
    .select()
    .from(cronJobsTable)
    .where(where)
    .orderBy(cronJobsTable.name);
  const ids = rows.map((r) => r.id);
  const [keys, running] = await Promise.all([
    envKeysFor(ids),
    inFlightJobIds(ids),
  ]);
  return rows.map((r) => toJobDTO(r, keys.get(r.id) ?? [], running.has(r.id)));
}

export async function inFlightJobIds(jobIds: string[]): Promise<Set<string>> {
  if (jobIds.length === 0) return new Set();
  const rows = await getDb()
    .selectDistinct({ jobId: cronRunsTable.jobId })
    .from(cronRunsTable)
    .where(
      and(
        inArray(cronRunsTable.jobId, jobIds),
        eq(cronRunsTable.status, "running"),
      ),
    );
  return new Set(rows.map((r) => r.jobId));
}

export async function oneJob(id: string): Promise<CronJobDTO | null> {
  const rows = await getDb()
    .select()
    .from(cronJobsTable)
    .where(eq(cronJobsTable.id, id))
    .limit(1);
  if (rows.length === 0) return null;
  const [keys, running] = await Promise.all([
    envKeysFor([id]),
    inFlightJobIds([id]),
  ]);
  return toJobDTO(rows[0], keys.get(id) ?? [], running.has(id));
}

export const listAppCronJobs = cache(
  async (appId: string): Promise<CronJobsView> => {
    const { app } = await gateApp(appId);
    return {
      targetKind: "app",
      targetId: appId,
      enabled: app.cronEnabled,
      jobs: await jobsFor(eq(cronJobsTable.appId, appId)),
      services: appServices(app.compose, app.slug),
      primaryService: primaryServiceOf({
        slug: app.slug,
        compose: app.compose,
        routedService: await routedServiceOf(appId),
      }),
    };
  },
);

export const listDatabaseCronJobs = cache(
  async (databaseId: string): Promise<CronJobsView> => {
    const { database } = await gateDatabase(databaseId);
    return {
      targetKind: "database",
      targetId: databaseId,
      enabled: database.cronEnabled,
      jobs: await jobsFor(eq(cronJobsTable.databaseId, databaseId)),
      services: [],
      primaryService: null,
    };
  },
);

export interface TeamCronJob {
  id: string;
  teamId: string;
  name: string;
  schedule: string;
  enabled: boolean;
  targetKind: CronTargetKind;
  targetRef: string;
  targetName: string;
}

export async function listTeamCronJobs(): Promise<TeamCronJob[]> {
  const teamId = await requireActiveTeamId();
  const [apps, databases, caps] = await Promise.all([
    listApps(),
    listDatabases().catch(() => []),
    currentCapabilities(),
  ]);
  const byApp = new Map(
    apps
      .filter((a) => a.capabilities?.includes("manage_crons"))
      .map((a) => [a.id, { ref: a.slug, name: a.name }] as const),
  );
  const dbOk =
    caps.includes("manage_crons") && caps.includes("open_database_console");
  const byDb = new Map(
    dbOk
      ? databases.map((d) => [d.id, { ref: d.id, name: d.name }] as const)
      : [],
  );
  if (byApp.size === 0 && byDb.size === 0) return [];

  const rows = await getDb()
    .select({
      id: cronJobsTable.id,
      teamId: cronJobsTable.teamId,
      name: cronJobsTable.name,
      schedule: cronJobsTable.schedule,
      enabled: cronJobsTable.enabled,
      targetKind: cronJobsTable.targetKind,
      appId: cronJobsTable.appId,
      databaseId: cronJobsTable.databaseId,
    })
    .from(cronJobsTable)
    .where(eq(cronJobsTable.teamId, teamId))
    .orderBy(cronJobsTable.name);

  return rows.flatMap((r) => {
    const target =
      (r.appId ? byApp.get(r.appId) : undefined) ??
      (r.databaseId ? byDb.get(r.databaseId) : undefined);
    if (!target) return [];
    return [
      {
        id: r.id,
        teamId: r.teamId,
        name: r.name,
        schedule: r.schedule,
        enabled: r.enabled,
        targetKind: r.targetKind as CronTargetKind,
        targetRef: target.ref,
        targetName: target.name,
      },
    ];
  });
}
