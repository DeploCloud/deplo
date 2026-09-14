import "server-only";

import { and, eq, or, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  cronJobs as cronJobsTable,
  cronRuns as cronRunsTable,
} from "../../db/schema/control-plane/crons";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { composeServiceNames } from "../../deploy/compose-stack/compose-read";

export type JobRow = typeof cronJobsTable.$inferSelect;
export type RunRow = typeof cronRunsTable.$inferSelect;

// CronTarget is a job plus the bits of its target the runner needs to reach a container.
export interface CronTarget {
  serverId: string;
  // The `deplo.project` label: the app's or database's id.
  projectId: string;
  // The stack slug the agent lists instances for (a database's is its host).
  slug: string;
  // For an app, its own compose service - the default container to pick.
  primaryService: string;
  // Where the UI shows this job, for the alert link.
  path: string;
}

export interface SchedulableJob {
  job: JobRow;
  target: CronTarget;
}

// primaryServiceOf picks the container a job runs in when it names none: the routed
// service, else the first the compose file declares, else the slug. Never "whichever
// the host listed first".
export function primaryServiceOf(app: {
  slug: string;
  compose: string | null;
  routedService: string | null;
}): string {
  return app.routedService ?? composeServiceNames(app.compose)[0] ?? app.slug;
}

function targetOf(
  job: JobRow,
  app: {
    slug: string;
    serverId: string;
    compose: string | null;
    routedService: string | null;
  } | null,
  db: { host: string; serverId: string } | null,
): CronTarget | null {
  if (job.appId && app) {
    return {
      serverId: app.serverId,
      projectId: job.appId,
      slug: app.slug,
      primaryService: primaryServiceOf(app),
      path: `/apps/${app.slug}/cron-jobs`,
    };
  }
  if (job.databaseId && db) {
    return {
      serverId: db.serverId,
      projectId: job.databaseId,
      // A database is a single-container stack whose container_name IS its host.
      slug: db.host,
      primaryService: db.host,
      path: `/storage/databases/${job.databaseId}/cron-jobs`,
    };
  }
  return null;
}

// routedServiceSql is the service an app's domain routes to, the primary domain first -
// a subquery, so the page and the scheduler read the same rule.
export const routedServiceSql = (appId: typeof appsTable.id) =>
  sql<string | null>`(select ${domainsTable.service} from ${domainsTable}
    where ${domainsTable.appId} = ${appId} and ${domainsTable.service} is not null
    order by ${domainsTable.isPrimary} desc, ${domainsTable.createdAt} asc limit 1)`;

const targetColumns = {
  job: cronJobsTable,
  appSlug: appsTable.slug,
  appServerId: appsTable.serverId,
  appCompose: appsTable.compose,
  appRoutedService: routedServiceSql(appsTable.id),
  dbHost: databasesTable.host,
  dbServerId: databasesTable.serverId,
};

function assembleTarget(r: {
  job: JobRow;
  appSlug: string | null;
  appServerId: string | null;
  appCompose: string | null;
  appRoutedService: string | null;
  dbHost: string | null;
  dbServerId: string | null;
}): CronTarget | null {
  return targetOf(
    r.job,
    r.appSlug && r.appServerId
      ? {
          slug: r.appSlug,
          serverId: r.appServerId,
          compose: r.appCompose,
          routedService: r.appRoutedService,
        }
      : null,
    r.dbHost && r.dbServerId
      ? { host: r.dbHost, serverId: r.dbServerId }
      : null,
  );
}

// listSchedulableJobs returns every job the scheduler may fire: enabled, on a target
// whose own cron switch is on - which is what makes that switch a real pause button.
export async function listSchedulableJobs(): Promise<SchedulableJob[]> {
  const rows = await getDb()
    .select(targetColumns)
    .from(cronJobsTable)
    // Defense in depth: a cron_job only resolves a target in the SAME team as the job.
    .leftJoin(
      appsTable,
      and(
        eq(appsTable.id, cronJobsTable.appId),
        eq(appsTable.teamId, cronJobsTable.teamId),
      ),
    )
    .leftJoin(
      databasesTable,
      and(
        eq(databasesTable.id, cronJobsTable.databaseId),
        eq(databasesTable.teamId, cronJobsTable.teamId),
      ),
    )
    .where(
      and(
        eq(cronJobsTable.enabled, true),
        or(
          eq(appsTable.cronEnabled, true),
          eq(databasesTable.cronEnabled, true),
        ),
      ),
    );
  const out: SchedulableJob[] = [];
  for (const r of rows) {
    const target = assembleTarget(r);
    if (target) out.push({ job: r.job, target });
  }
  return out;
}

// InFlightRun is one in-flight run, with everything needed to poll or relaunch it.
export interface InFlightRun {
  run: RunRow;
  job: JobRow;
  target: CronTarget;
}

// listInFlightRuns returns every `running` run - the reaper's whole working set.
export async function listInFlightRuns(): Promise<InFlightRun[]> {
  const rows = await getDb()
    .select({ run: cronRunsTable, ...targetColumns })
    .from(cronRunsTable)
    .innerJoin(cronJobsTable, eq(cronJobsTable.id, cronRunsTable.jobId))
    .leftJoin(appsTable, eq(appsTable.id, cronJobsTable.appId))
    .leftJoin(databasesTable, eq(databasesTable.id, cronJobsTable.databaseId))
    .where(eq(cronRunsTable.status, "running"));
  const out: InFlightRun[] = [];
  for (const r of rows) {
    const target = assembleTarget(r);
    if (target) out.push({ run: r.run, job: r.job, target });
  }
  return out;
}

// loadSchedulableJob loads one job with its target, for the manual "Run now" path.
export async function loadSchedulableJob(
  jobId: string,
): Promise<SchedulableJob | null> {
  const rows = await getDb()
    .select(targetColumns)
    .from(cronJobsTable)
    // Defense in depth: a cron_job only resolves a target in the SAME team as the job.
    .leftJoin(
      appsTable,
      and(
        eq(appsTable.id, cronJobsTable.appId),
        eq(appsTable.teamId, cronJobsTable.teamId),
      ),
    )
    .leftJoin(
      databasesTable,
      and(
        eq(databasesTable.id, cronJobsTable.databaseId),
        eq(databasesTable.teamId, cronJobsTable.teamId),
      ),
    )
    .where(eq(cronJobsTable.id, jobId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const target = assembleTarget(r);
  return target ? { job: r.job, target } : null;
}

// loadInFlightRun returns one in-flight run by id, for the cancel path.
export async function loadInFlightRun(
  runId: string,
): Promise<InFlightRun | null> {
  const rows = await getDb()
    .select({ run: cronRunsTable, ...targetColumns })
    .from(cronRunsTable)
    .innerJoin(cronJobsTable, eq(cronJobsTable.id, cronRunsTable.jobId))
    .leftJoin(appsTable, eq(appsTable.id, cronJobsTable.appId))
    .leftJoin(databasesTable, eq(databasesTable.id, cronJobsTable.databaseId))
    .where(
      and(eq(cronRunsTable.id, runId), eq(cronRunsTable.status, "running")),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  const target = assembleTarget(r);
  return target ? { run: r.run, job: r.job, target } : null;
}
