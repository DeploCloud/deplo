// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { builder } from "../builder";
import {
  cancelCronRun,
  createCronJob,
  deleteCronJob,
  listAppCronJobs,
  listCronRuns,
  listDatabaseCronJobs,
  runCronJobNow,
  setCronEnabled,
  updateCronJob,
  type CronJobDTO,
  type CronJobsView,
  type CronRunDTO,
} from "@/lib/data/crons";
import type { CronTargetKind } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Object types - cron jobs (ADR-0018)                                 */
/* ------------------------------------------------------------------ */

export const CronJobRef = builder.objectRef<CronJobDTO>("CronJob").implement({
  description:
    "A command run inside one container of an App or a Database, on a cron " +
    "schedule, in the job's own timezone. Running it produces a CronRun.",
  fields: (t) => ({
    id: t.exposeID("id"),
    targetKind: t.exposeString("targetKind", {
      description: "app | database.",
    }),
    appId: t.exposeID("appId", { nullable: true }),
    databaseId: t.exposeID("databaseId", { nullable: true }),
    name: t.exposeString("name"),
    description: t.exposeString("description"),
    service: t.exposeString("service", {
      nullable: true,
      description:
        "Compose service to run in. Null means the target's own container - the " +
        "only possibility for a database. Never a container name: a redeploy " +
        "mints new ones, so it is resolved live before every attempt.",
    }),
    schedule: t.exposeString("schedule", { description: "5-field cron." }),
    timezone: t.exposeString("timezone", {
      description:
        "IANA zone the schedule is read in. NOT UTC unless you say so.",
    }),
    shell: t.exposeString("shell", { description: "sh | bash." }),
    command: t.exposeString("command"),
    enabled: t.exposeBoolean("enabled"),
    timeoutSeconds: t.exposeInt("timeoutSeconds", {
      description:
        "Per ATTEMPT - it is the agent's exec deadline. timeout x attempts is " +
        "capped at 24 hours.",
    }),
    maxAttempts: t.exposeInt("maxAttempts", {
      description: "Launches per scheduled fire. 1 means no retry.",
    }),
    overlap: t.exposeString("overlap", {
      description:
        "skip | allow - what happens when the previous run is still going.",
    }),
    keepRuns: t.exposeInt("keepRuns"),
    workdir: t.exposeString("workdir", { nullable: true }),
    user: t.exposeString("user", { nullable: true }),
    lastRunAt: t.exposeString("lastRunAt", { nullable: true }),
    lastStatus: t.exposeString("lastStatus", { nullable: true }),
    lastSuccessAt: t.exposeString("lastSuccessAt", {
      nullable: true,
      description:
        "The last time it actually worked. Separate from lastRunAt so a job " +
        "quietly skipped for a week (its container is stopped) is visible.",
    }),
    nextRunAt: t.exposeString("nextRunAt", {
      nullable: true,
      description:
        "Computed, never stored, from the clock of whoever asked. Null while " +
        "the job is disabled. It is a snapshot, not a countdown: re-read it " +
        "rather than letting an old answer age into the past.",
    }),
    running: t.exposeBoolean("running", {
      description:
        "A run of this job is in flight. Not the same as lastStatus, which is " +
        "written when a run SETTLES and so never says `running`.",
    }),
    envKeys: t.exposeStringList("envKeys", {
      description:
        "The NAMES of the job's extra variables. The values are write-only and " +
        "have no read path.",
    }),
    createdAt: t.exposeString("createdAt"),
    updatedAt: t.exposeString("updatedAt"),
  }),
});

export const CronRunRef = builder.objectRef<CronRunDTO>("CronRun").implement({
  description: "One scheduled fire of a cron job, retries included.",
  fields: (t) => ({
    id: t.exposeID("id"),
    jobId: t.exposeID("jobId"),
    status: t.exposeString("status", {
      description:
        "running | succeeded | failed | timedout | skipped | lost. `skipped` " +
        "never started (the container was stopped, or the previous run was " +
        "still going) and `lost` means the outcome is unknown - the agent " +
        "restarted mid-run. Neither is a failure.",
    }),
    trigger: t.exposeString("trigger", { description: "schedule | manual." }),
    actor: t.exposeString("actor"),
    scheduledFor: t.exposeString("scheduledFor"),
    startedAt: t.exposeString("startedAt"),
    finishedAt: t.exposeString("finishedAt", { nullable: true }),
    attempt: t.exposeInt("attempt", {
      description:
        "0-based. The output below is this attempt's, not the first's.",
    }),
    maxAttempts: t.exposeInt("maxAttempts"),
    retrying: t.exposeBoolean("retrying", {
      description:
        "Running, but waiting out a retry backoff rather than executing.",
    }),
    exitCode: t.exposeInt("exitCode", { nullable: true }),
    stdout: t.exposeString("stdout", {
      description: "Last 16 KiB - the tail.",
    }),
    stderr: t.exposeString("stderr"),
    error: t.exposeString("error", {
      nullable: true,
      description: "Why it failed or was skipped. Not command output.",
    }),
    container: t.exposeString("container"),
    command: t.exposeString("command"),
  }),
});

export const CronJobsViewRef = builder
  .objectRef<CronJobsView>("CronJobsView")
  .implement({
    description: "Everything a Cron jobs page renders in one read.",
    fields: (t) => ({
      targetKind: t.exposeString("targetKind"),
      targetId: t.exposeID("targetId"),
      enabled: t.exposeBoolean("enabled", {
        description:
          "The per-target master switch. While false the scheduler skips every " +
          "job here, and the jobs themselves are untouched.",
      }),
      services: t.exposeStringList("services", {
        description: "Compose services a job can target. Empty for a database.",
      }),
      jobs: t.field({ type: [CronJobRef], resolve: (v) => v.jobs }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const CronEnvInput = builder.inputType("CronJobEnvInput", {
  description:
    "One extra variable for a job. The value is encrypted at rest and reaches " +
    "the host inside the mTLS RPC - it is never readable back.",
  fields: (t) => ({
    key: t.string({ required: true }),
    value: t.string({ required: true }),
  }),
});

const CronJobInputRef = builder.inputType("CronJobInput", {
  description:
    "Every field is optional so one input serves create and edit; create " +
    "requires name, schedule and command.",
  fields: (t) => ({
    name: t.string({ required: false }),
    description: t.string({ required: false }),
    service: t.string({
      required: false,
      description: "Empty ⇒ the target's own container.",
    }),
    schedule: t.string({ required: false, description: "5-field cron." }),
    timezone: t.string({
      required: false,
      description: "IANA zone, e.g. Europe/Rome.",
    }),
    shell: t.string({ required: false, description: "sh | bash." }),
    command: t.string({ required: false }),
    enabled: t.boolean({ required: false }),
    timeoutSeconds: t.int({
      required: false,
      description: "Per attempt, 1s to 24h.",
    }),
    maxAttempts: t.int({
      required: false,
      description: "1 to 4. 1 means no retry.",
    }),
    overlap: t.string({ required: false, description: "skip | allow." }),
    keepRuns: t.int({ required: false, description: "10 to 500." }),
    workdir: t.string({ required: false }),
    user: t.string({ required: false }),
    env: t.field({
      type: [CronEnvInput],
      required: false,
      description: "Replaces the job's variables wholesale when present.",
    }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries + mutations                                                 */
/* ------------------------------------------------------------------ */

// A pre-check only. The real boundary is `manage_crons` (plus, for a database,
// `open_database_console`) inside lib/data/crons.ts.
const cronScope = { capability: "manage_crons" } as const;

builder.queryFields((t) => ({
  appCronJobs: t.field({
    type: CronJobsViewRef,
    authScopes: cronScope,
    description:
      "An app's cron jobs, its master switch and its pickable services.",
    args: { appId: t.arg.id({ required: true }) },
    resolve: (_r, { appId }) => listAppCronJobs(String(appId)),
  }),
  databaseCronJobs: t.field({
    type: CronJobsViewRef,
    authScopes: cronScope,
    description: "A database's cron jobs and its master switch.",
    args: { databaseId: t.arg.id({ required: true }) },
    resolve: (_r, { databaseId }) => listDatabaseCronJobs(String(databaseId)),
  }),
  cronRuns: t.field({
    type: [CronRunRef],
    authScopes: cronScope,
    description:
      "One job's run history, newest first. Gated on manage_crons and not on " +
      "view: stdout can carry whatever the command printed.",
    args: {
      jobId: t.arg.id({ required: true }),
      limit: t.arg.int({ required: false }),
    },
    resolve: (_r, { jobId, limit }) => listCronRuns(String(jobId), limit ?? 50),
  }),
}));

builder.mutationFields((t) => ({
  setCronEnabled: t.field({
    type: "Boolean",
    authScopes: cronScope,
    description:
      "Turn cron jobs on or off for one target. Off stops the schedule and keeps " +
      "the jobs; runs already in flight are left to finish.",
    args: {
      targetKind: t.arg.string({
        required: true,
        description: "app | database.",
      }),
      targetId: t.arg.id({ required: true }),
      enabled: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { targetKind, targetId, enabled }) => {
      await setCronEnabled(
        targetKind as CronTargetKind,
        String(targetId),
        enabled,
      );
      return true;
    },
  }),
  createCronJob: t.field({
    type: CronJobRef,
    authScopes: cronScope,
    args: {
      targetKind: t.arg.string({
        required: true,
        description: "app | database.",
      }),
      targetId: t.arg.id({ required: true }),
      input: t.arg({ type: CronJobInputRef, required: true }),
    },
    resolve: (_r, { targetKind, targetId, input }) =>
      createCronJob(targetKind as CronTargetKind, String(targetId), {
        name: input.name ?? undefined,
        description: input.description ?? undefined,
        service: input.service ?? undefined,
        schedule: input.schedule ?? undefined,
        timezone: input.timezone ?? undefined,
        shell: input.shell ?? undefined,
        command: input.command ?? undefined,
        enabled: input.enabled ?? undefined,
        timeoutSeconds: input.timeoutSeconds ?? undefined,
        maxAttempts: input.maxAttempts ?? undefined,
        overlap: input.overlap ?? undefined,
        keepRuns: input.keepRuns ?? undefined,
        workdir: input.workdir ?? undefined,
        user: input.user ?? undefined,
        env: input.env ?? undefined,
      }),
  }),
  updateCronJob: t.field({
    type: CronJobRef,
    authScopes: cronScope,
    args: {
      id: t.arg.id({ required: true }),
      input: t.arg({ type: CronJobInputRef, required: true }),
    },
    resolve: (_r, { id, input }) =>
      updateCronJob(String(id), {
        name: input.name ?? undefined,
        description: input.description ?? undefined,
        service: input.service ?? undefined,
        schedule: input.schedule ?? undefined,
        timezone: input.timezone ?? undefined,
        shell: input.shell ?? undefined,
        command: input.command ?? undefined,
        enabled: input.enabled ?? undefined,
        timeoutSeconds: input.timeoutSeconds ?? undefined,
        maxAttempts: input.maxAttempts ?? undefined,
        overlap: input.overlap ?? undefined,
        keepRuns: input.keepRuns ?? undefined,
        workdir: input.workdir ?? undefined,
        user: input.user ?? undefined,
        env: input.env ?? undefined,
      }),
  }),
  deleteCronJob: t.field({
    type: "Boolean",
    authScopes: cronScope,
    description: "Delete a job and its run history.",
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteCronJob(String(id));
      return true;
    },
  }),
  runCronJobNow: t.field({
    type: CronRunRef,
    authScopes: cronScope,
    description:
      "Run a job now, outside its schedule. Ignores the overlap setting - " +
      "somebody just asked for it explicitly.",
    args: { id: t.arg.id({ required: true }) },
    resolve: (_r, { id }) => runCronJobNow(String(id)),
  }),
  cancelCronRun: t.field({
    type: "Boolean",
    authScopes: cronScope,
    description: "Stop a run that is in flight.",
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }) => {
      await cancelCronRun(String(id));
      return true;
    },
  }),
}));
