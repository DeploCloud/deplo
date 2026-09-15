import "server-only";

import { cronJobs as cronJobsTable } from "../../db/schema/control-plane/crons";
import { invalidScheduleMessage, isValidSchedule } from "../../schedule";
import { canonicalTimeZone, nextCronRunInZone } from "../../crons/cron-tz";
import type { JobRow } from "./dto";

const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;
const MAX_TOTAL_SECONDS = 24 * 60 * 60;
const MIN_KEEP_RUNS = 10;
export const MAX_KEEP_RUNS = 500;
const MAX_ATTEMPTS = 4;
const NEVER_FIRES_DAYS = 4 * 366;

export interface CronJobInput {
  name?: string;
  description?: string | null;
  service?: string | null;
  schedule?: string;
  timezone?: string;
  shell?: string;
  command?: string;
  enabled?: boolean;
  timeoutSeconds?: number;
  maxAttempts?: number;
  overlap?: string;
  keepRuns?: number;
  workdir?: string | null;
  user?: string | null;
  env?: { key: string; value: string | null }[];
}

export function buildPatch(
  input: CronJobInput,
  current?: JobRow,
): Partial<typeof cronJobsTable.$inferInsert> {
  const patch: Partial<typeof cronJobsTable.$inferInsert> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("Give the cron job a name");
    if (name.length > 80)
      throw new Error("Keep the name to 80 characters or fewer");
    patch.name = name;
  }
  if (input.description !== undefined) {
    patch.description = (input.description ?? "").trim().slice(0, 500);
  }
  if (input.service !== undefined) {
    patch.service = (input.service ?? "").trim() || null;
  }
  if (input.schedule !== undefined) {
    const schedule = input.schedule.trim().replace(/\s+/g, " ");
    if (!isValidSchedule(schedule))
      throw new Error(invalidScheduleMessage(schedule));
    patch.schedule = schedule;
  }
  if (input.timezone !== undefined) {
    const tz = canonicalTimeZone(input.timezone);
    if (!tz) {
      throw new Error(
        `"${input.timezone.trim()}" is not a timezone. Pick one from the list, like "Europe/Rome".`,
      );
    }
    patch.timezone = tz;
  }
  if (input.shell !== undefined) {
    if (input.shell !== "sh" && input.shell !== "bash") {
      throw new Error("The shell must be sh or bash");
    }
    patch.shell = input.shell;
  }
  if (input.command !== undefined) {
    const command = input.command.trim();
    if (!command) throw new Error("Give the cron job a command to run");
    if (command.length > 8000) {
      throw new Error(
        "Keep the command under 8000 characters - put a long script in the image",
      );
    }
    patch.command = command;
  }
  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
  if (input.overlap !== undefined) {
    if (input.overlap !== "skip" && input.overlap !== "allow") {
      throw new Error("Overlap must be skip or allow");
    }
    patch.overlap = input.overlap;
  }
  if (input.keepRuns !== undefined) {
    if (input.keepRuns < MIN_KEEP_RUNS || input.keepRuns > MAX_KEEP_RUNS) {
      throw new Error(
        `Keep between ${MIN_KEEP_RUNS} and ${MAX_KEEP_RUNS} runs of history`,
      );
    }
    patch.keepRuns = Math.trunc(input.keepRuns);
  }
  if (input.workdir !== undefined) {
    const workdir = (input.workdir ?? "").trim();
    if (workdir && !/^\/[\w./@+-]*$/.test(workdir))
      throw new Error(
        "The working directory must be an absolute path inside the container",
      );
    patch.workdir = workdir || null;
  }
  if (input.user !== undefined) {
    const user = (input.user ?? "").trim();
    if (user && !/^[\w.-]+(:[\w.-]+)?$/.test(user))
      throw new Error("Run as must be a user or uid, optionally with :group");
    patch.user = user || null;
  }

  if (input.timeoutSeconds !== undefined) {
    if (
      input.timeoutSeconds < 1 ||
      input.timeoutSeconds > MAX_TIMEOUT_SECONDS
    ) {
      throw new Error("Keep the timeout between 1 second and 24 hours");
    }
    patch.timeoutSeconds = Math.trunc(input.timeoutSeconds);
  }
  if (input.maxAttempts !== undefined) {
    if (input.maxAttempts < 1 || input.maxAttempts > MAX_ATTEMPTS) {
      throw new Error(`Allow between 1 and ${MAX_ATTEMPTS} attempts`);
    }
    patch.maxAttempts = Math.trunc(input.maxAttempts);
  }

  if (patch.schedule !== undefined || patch.timezone !== undefined) {
    const schedule = patch.schedule ?? current?.schedule;
    const tz = patch.timezone ?? current?.timezone ?? "UTC";
    if (
      schedule &&
      !nextCronRunInZone(schedule, new Date(), tz, NEVER_FIRES_DAYS)
    ) {
      throw new Error(
        "This schedule never comes up - check the day and the month",
      );
    }
  }

  const timeout = patch.timeoutSeconds ?? current?.timeoutSeconds ?? 3600;
  const attempts = patch.maxAttempts ?? current?.maxAttempts ?? 1;
  if (timeout * attempts > MAX_TOTAL_SECONDS) {
    throw new Error(
      `${attempts} attempts of ${Math.round(timeout / 60)} minutes could run for ` +
        `${Math.round((timeout * attempts) / 3600)} hours. Lower the timeout or the retries so they fit in 24 hours.`,
    );
  }
  return patch;
}
