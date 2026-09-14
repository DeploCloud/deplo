import "server-only";

import { and, count, eq } from "drizzle-orm";

import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { cronJobs as cronJobsTable } from "../../db/schema/control-plane/crons";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { newId, nowIso } from "../../ids";
import type { CronTargetKind } from "../../types/cron";
import { recordActivity } from "../activity";
import type { CronJobDTO } from "./dto";
import { assertRunAsAllowed, gateApp, gateDatabase, gateJob } from "./gates";
import { validateEnv, writeEnv } from "./job-env";
import { buildPatch, type CronJobInput } from "./job-validate";
import { oneJob } from "./listing";
import { assertServiceInTarget } from "./target-services";

const MAX_JOBS_PER_TARGET = 20;

/** Turn cron jobs on or off for one target. */
export async function setCronEnabled(
  targetKind: CronTargetKind,
  targetId: string,
  enabled: boolean,
): Promise<void> {
  const user = await getCurrentUser();
  const actor = user?.name ?? "Deplo";
  if (targetKind === "app") {
    const { app, teamId } = await gateApp(targetId);
    const rows = await getDb()
      .update(appsTable)
      .set({ cronEnabled: enabled, updatedAt: nowIso() })
      .where(and(eq(appsTable.id, targetId), eq(appsTable.teamId, teamId)))
      .returning({ id: appsTable.id });
    if (rows.length === 0) throw new Error("App not found");
    await recordActivity(
      "cron",
      `${enabled ? "Enabled" : "Disabled"} cron jobs for ${app.name}`,
      actor,
      targetId,
    );
    return;
  }
  const { teamId } = await gateDatabase(targetId);
  const rows = await getDb()
    .update(databasesTable)
    .set({ cronEnabled: enabled })
    .where(
      and(eq(databasesTable.id, targetId), eq(databasesTable.teamId, teamId)),
    )
    .returning({ name: databasesTable.name });
  if (rows.length === 0) throw new Error("Database not found");
  await recordActivity(
    "cron",
    `${enabled ? "Enabled" : "Disabled"} cron jobs for database ${rows[0].name}`,
    actor,
    null,
    teamId,
    null,
    targetId,
  );
}

export async function createCronJob(
  targetKind: CronTargetKind,
  targetId: string,
  input: CronJobInput,
): Promise<CronJobDTO> {
  const user = await getCurrentUser();
  const gated =
    targetKind === "app"
      ? await gateApp(targetId)
      : { app: null, teamId: (await gateDatabase(targetId)).teamId };
  const teamId = gated.teamId;
  assertServiceInTarget(input.service?.trim(), gated.app);

  // Required on create, optional on edit - so the patch builder is shared and the
  // requiredness lives in exactly one place.
  if (input.name === undefined) throw new Error("Give the cron job a name");
  if (input.command === undefined)
    throw new Error("Give the cron job a command to run");
  if (input.schedule === undefined)
    throw new Error("Give the cron job a schedule");

  const patch = buildPatch(input);
  await assertRunAsAllowed(gated.app, patch.user);
  const env = input.env ? validateEnv(input.env) : [];
  const [{ n: existing }] = await getDb()
    .select({ n: count() })
    .from(cronJobsTable)
    .where(
      targetKind === "app"
        ? eq(cronJobsTable.appId, targetId)
        : eq(cronJobsTable.databaseId, targetId),
    );
  if (Number(existing) >= MAX_JOBS_PER_TARGET)
    throw new Error(
      `At most ${MAX_JOBS_PER_TARGET} cron jobs per app or database.`,
    );
  const now = nowIso();
  const id = newId("cron");

  try {
    await getDb()
      .insert(cronJobsTable)
      .values({
        id,
        teamId,
        targetKind,
        appId: targetKind === "app" ? targetId : null,
        databaseId: targetKind === "database" ? targetId : null,
        name: patch.name!,
        schedule: patch.schedule!,
        command: patch.command!,
        description: patch.description ?? "",
        service: patch.service ?? null,
        timezone: patch.timezone ?? "UTC",
        shell: patch.shell ?? "sh",
        enabled: patch.enabled ?? true,
        timeoutSeconds: patch.timeoutSeconds ?? 3600,
        maxAttempts: patch.maxAttempts ?? 1,
        overlap: patch.overlap ?? "skip",
        keepRuns: patch.keepRuns ?? 50,
        workdir: patch.workdir ?? null,
        user: patch.user ?? null,
        createdByUserId: user?.id ?? null,
        createdAt: now,
        updatedAt: now,
      });
  } catch (e) {
    // The unique index is the real check; catching it here turns a Postgres constraint
    // string into the sentence the form should show.
    if (/cron_jobs_(app|database)_name_uq/.test(errorChainText(e))) {
      throw new Error(`A cron job called "${patch.name}" already exists here`);
    }
    throw e;
  }
  await writeEnv(id, env);
  await recordActivity(
    "cron",
    `Created cron job ${patch.name}`,
    user?.name ?? "Deplo",
    targetKind === "app" ? targetId : null,
    teamId,
    null,
    targetKind === "database" ? targetId : null,
  );
  return (await oneJob(id))!;
}

/** An error plus its `cause` chain as one string - where drivers hide details. */
function errorChainText(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    parts.push(String(cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(" ");
}

export async function updateCronJob(
  jobId: string,
  input: CronJobInput,
): Promise<CronJobDTO> {
  const { job, teamId, app } = await gateJob(jobId);
  const user = await getCurrentUser();
  assertServiceInTarget(input.service?.trim(), app);
  const patch = buildPatch(input, job);
  await assertRunAsAllowed(app, patch.user ?? job.user);
  if (Object.keys(patch).length > 0 || input.env !== undefined) {
    patch.updatedAt = nowIso();
    const rows = await getDb()
      .update(cronJobsTable)
      .set(patch)
      .where(and(eq(cronJobsTable.id, jobId), eq(cronJobsTable.teamId, teamId)))
      .returning({ id: cronJobsTable.id });
    if (rows.length === 0) throw new Error("Cron job not found");
  }
  if (input.env !== undefined) await writeEnv(jobId, validateEnv(input.env));
  await recordActivity(
    "cron",
    `Updated cron job ${patch.name ?? job.name}`,
    user?.name ?? "Deplo",
    job.appId,
    teamId,
    null,
    job.databaseId,
  );
  return (await oneJob(jobId))!;
}

export async function deleteCronJob(jobId: string): Promise<void> {
  const { job, teamId } = await gateJob(jobId);
  const user = await getCurrentUser();
  const rows = await getDb()
    .delete(cronJobsTable)
    .where(and(eq(cronJobsTable.id, jobId), eq(cronJobsTable.teamId, teamId)))
    .returning({ id: cronJobsTable.id });
  if (rows.length === 0) throw new Error("Cron job not found");
  await recordActivity(
    "cron",
    `Deleted cron job ${job.name}`,
    user?.name ?? "Deplo",
    job.appId,
    teamId,
    null,
    job.databaseId,
  );
}
