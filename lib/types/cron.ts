import type { ID } from "./identity";

export type CronTargetKind = "app" | "database";

export type CronShell = "sh" | "bash";

export type CronOverlap = "skip" | "allow";

export type CronRunStatus =
  "running" | "succeeded" | "failed" | "timedout" | "skipped" | "lost";

export interface CronJob {
  id: ID;
  teamId: ID;
  targetKind: CronTargetKind;
  appId: ID | null;
  databaseId: ID | null;
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
  createdAt: string;
  updatedAt: string;
}

export interface CronRun {
  id: ID;
  teamId: ID;
  jobId: ID;
  status: CronRunStatus;
  trigger: "schedule" | "manual";
  actor: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  attempt: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
  command: string;
  container: string;
  timeoutSeconds: number;
  maxAttempts: number;
}
