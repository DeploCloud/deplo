import "server-only";

import {
  cronJobs as cronJobsTable,
  cronRuns as cronRunsTable,
} from "../../db/schema/control-plane/crons";
import { nextCronRunInZone } from "../../crons/cron-tz";
import type {
  CronOverlap,
  CronRunStatus,
  CronShell,
  CronTargetKind,
} from "../../types/cron";

export interface CronJobDTO {
  id: string;
  targetKind: CronTargetKind;
  appId: string | null;
  databaseId: string | null;
  name: string;
  description: string;
  service: string | null;
  schedule: string;
  timezone: string;
  shell: CronShell;
  command: string;
  enabled: boolean;
  timeoutSeconds: number;
  maxAttempts: number;
  overlap: CronOverlap;
  keepRuns: number;
  workdir: string | null;
  user: string | null;
  lastRunAt: string | null;
  lastStatus: CronRunStatus | null;
  lastSuccessAt: string | null;
  /** True while a run is in flight. `lastStatus` cannot say so - it is written
   *  when a run SETTLES. */
  running: boolean;
  /** Computed, never stored: the next instant this fires, in the job's zone. */
  nextRunAt: string | null;
  /** The keys of the job's extra environment. NEVER the values (ADR: secrets are
   *  write-only and have no reveal path). */
  envKeys: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CronRunDTO {
  id: string;
  jobId: string;
  status: CronRunStatus;
  trigger: string;
  actor: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  attempt: number;
  maxAttempts: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  container: string;
  command: string;
  /** True while a retry waits out its backoff, which reads very differently from
   *  "the command is running" even though both are `running` rows. */
  retrying: boolean;
}

/** Everything a Cron jobs page renders in one read. */
export interface CronJobsView {
  targetKind: CronTargetKind;
  targetId: string;
  /** The per-target master switch. While false the scheduler skips every job. */
  enabled: boolean;
  jobs: CronJobDTO[];
  /** Compose services that can be picked as a job's container. Empty for a
   *  database (one container) and when the host cannot be reached. */
  services: string[];
  /** Where a job that names no container runs: the service the app's domain
   *  routes to, else the first declared. Null for a database. */
  primaryService: string | null;
}

export type JobRow = typeof cronJobsTable.$inferSelect;

export function toJobDTO(
  r: JobRow,
  envKeys: string[],
  running: boolean,
): CronJobDTO {
  return {
    id: r.id,
    targetKind: r.targetKind as CronTargetKind,
    appId: r.appId,
    databaseId: r.databaseId,
    name: r.name,
    description: r.description,
    service: r.service,
    schedule: r.schedule,
    timezone: r.timezone,
    shell: r.shell as CronShell,
    command: r.command,
    enabled: r.enabled,
    timeoutSeconds: r.timeoutSeconds,
    maxAttempts: r.maxAttempts,
    overlap: r.overlap as CronOverlap,
    keepRuns: r.keepRuns,
    workdir: r.workdir,
    user: r.user,
    lastRunAt: r.lastRunAt,
    lastStatus: (r.lastStatus as CronRunStatus | null) ?? null,
    lastSuccessAt: r.lastSuccessAt,
    running,
    nextRunAt: r.enabled
      ? (nextCronRunInZone(r.schedule, new Date(), r.timezone)?.toISOString() ??
        null)
      : null,
    envKeys,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toRunDTO(r: typeof cronRunsTable.$inferSelect): CronRunDTO {
  return {
    id: r.id,
    jobId: r.jobId,
    status: r.status as CronRunStatus,
    trigger: r.trigger,
    actor: r.actor,
    scheduledFor: r.scheduledFor,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    exitCode: r.exitCode,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
    container: r.container,
    command: r.command,
    // `attempt > 0` is what separates a retry waiting out its backoff from a run
    // in the split second between its INSERT and its StartJob - both have no
    // agent handle, and only one of them has anything to retry.
    retrying: r.status === "running" && r.agentJobId === null && r.attempt > 0,
  };
}
