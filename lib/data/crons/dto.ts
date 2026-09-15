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
  running: boolean;
  nextRunAt: string | null;
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
  retrying: boolean;
}

export interface CronJobsView {
  targetKind: CronTargetKind;
  targetId: string;
  enabled: boolean;
  jobs: CronJobDTO[];
  services: string[];
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
    retrying: r.status === "running" && r.agentJobId === null && r.attempt > 0,
  };
}
