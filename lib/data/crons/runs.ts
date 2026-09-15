import "server-only";

import { desc, eq } from "drizzle-orm";

import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { cronRuns as cronRunsTable } from "../../db/schema/control-plane/crons";
import { requireActiveTeamId } from "../../membership";
import { cancelRun, runJobNow } from "../../crons/runner/fire";
import {
  loadInFlightRun,
  loadSchedulableJob,
} from "../../crons/runner/targets";
import { recordActivity } from "../activity";
import { type CronRunDTO, toRunDTO } from "./dto";
import { gateJob } from "./gates";
import { MAX_KEEP_RUNS } from "./job-validate";

export async function listCronRuns(
  jobId: string,
  limit = 50,
): Promise<CronRunDTO[]> {
  await gateJob(jobId);
  const rows = await getDb()
    .select()
    .from(cronRunsTable)
    .where(eq(cronRunsTable.jobId, jobId))
    .orderBy(desc(cronRunsTable.seq))
    .limit(Math.min(Math.max(limit, 1), MAX_KEEP_RUNS));
  return rows.map(toRunDTO);
}

export async function runCronJobNow(jobId: string): Promise<CronRunDTO> {
  const { job, teamId, targetEnabled } = await gateJob(jobId);
  if (!targetEnabled) {
    throw new Error(
      "Cron jobs are switched off here. Turn them on in Settings first.",
    );
  }
  const user = await getCurrentUser();
  const actor = user?.name ?? "Deplo";
  const schedulable = await loadSchedulableJob(jobId);
  if (!schedulable) throw new Error("Cron job not found");

  const r = await runJobNow(schedulable, actor);
  await recordActivity(
    "cron",
    `Ran cron job ${job.name}`,
    actor,
    job.appId,
    teamId,
    null,
    job.databaseId,
  );
  const rows = await getDb()
    .select()
    .from(cronRunsTable)
    .where(eq(cronRunsTable.id, r.run.id))
    .limit(1);
  return toRunDTO(rows[0] ?? r.run);
}

export async function cancelCronRun(runId: string): Promise<void> {
  const teamId = await requireActiveTeamId();
  const r = await loadInFlightRun(runId);
  if (!r || r.run.teamId !== teamId) throw new Error("Run not found");
  await gateJob(r.job.id);
  const user = await getCurrentUser();
  const actor = user?.name ?? "Deplo";
  await cancelRun(r, actor);
  await recordActivity(
    "cron",
    `Stopped a run of cron job ${r.job.name}`,
    actor,
    r.job.appId,
    teamId,
    null,
    r.job.databaseId,
  );
}
