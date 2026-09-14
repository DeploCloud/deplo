import type { ID } from "./identity";

// CronTargetKind - what a cron job runs inside. Same two kinds a Backup targets.
export type CronTargetKind = "app" | "database";

// CronShell - which shell interprets the command. A named shell the image lacks
// fails the run rather than falling back - see ADR-0018.
export type CronShell = "sh" | "bash";

// CronOverlap - what to do when the previous run of a job is still going.
export type CronOverlap = "skip" | "allow";

// CronRunStatus - how a run ended. `lost` means Deplo could not find out, because
// the agent restarted while the command was in flight; it raises no alert.
export type CronRunStatus =
  "running" | "succeeded" | "failed" | "timedout" | "skipped" | "lost";

// CronJob - a scheduled command inside one container of an App or a Database.
export interface CronJob {
  id: ID;
  teamId: ID;
  targetKind: CronTargetKind;
  // Set when `targetKind === "app"`; otherwise null.
  appId: ID | null;
  // Set when `targetKind === "database"`; otherwise null.
  databaseId: ID | null;
  name: string;
  description: string;
  // Compose service to exec into. Null ⇒ the target's primary container. Never a
  // container NAME: a redeploy mints new ones, so it is resolved live.
  service: string | null;
  // 5-field cron, evaluated in `timezone`.
  schedule: string;
  // IANA zone, validated on write.
  timezone: string;
  shell: CronShell;
  command: string;
  enabled: boolean;
  // Per ATTEMPT - it is the agent's `docker exec` deadline.
  timeoutSeconds: number;
  // Total launches per scheduled fire: 1 means no retry.
  maxAttempts: number;
  overlap: CronOverlap;
  // Runs kept in this job's history; older ones are pruned as runs settle.
  keepRuns: number;
  workdir: string | null;
  user: string | null;
  lastRunAt: string | null;
  lastStatus: CronRunStatus | null;
  // Surfaced on the job row so a job silently `skipped` for a week is visible.
  lastSuccessAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// CronRun - one scheduled fire of a {@link CronJob}, retries included. `command`
// and the limits are frozen at insert: editing a job mid-flight must not change
// the deadline the reaper enforces, and the history must say what actually ran.
export interface CronRun {
  id: ID;
  teamId: ID;
  jobId: ID;
  status: CronRunStatus;
  // "schedule" | "manual" - a hand-pressed Run now is not a missed schedule.
  trigger: "schedule" | "manual";
  actor: string;
  // The cron minute this run answers.
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  attempt: number;
  exitCode: number | null;
  // Last 16 KiB of the final attempt - the tail, never the head.
  stdout: string;
  stderr: string;
  // Why it failed, or why it was skipped. Not command output.
  error: string | null;
  command: string;
  container: string;
  timeoutSeconds: number;
  maxAttempts: number;
}
