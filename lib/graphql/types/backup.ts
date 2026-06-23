import { builder } from "../builder";
import {
  listBackups,
  createBackup,
  runBackup,
  runProjectBackup,
  restoreBackup,
  listBackupRuns,
  toggleBackup,
  updateBackup,
  deleteBackup,
  deleteAllBackupArtifacts,
  type BackupDTO,
} from "@/lib/data/backups";
import type { BackupRun } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

// `lastStatus` is a local string union on the Backup type and is not shared
// across modules, so we define its enum here rather than in enums.ts. Every
// value already matches /[_a-zA-Z0-9]/, so the plain array form is fine.
const BackupStatusEnum = builder.enumType("BackupStatus", {
  values: ["success", "failed", "running", "never"] as const,
});

// What a schedule / run targets. Local to this domain (mirrors how
// DatabaseStatus lives in database.ts) rather than the shared enums file.
const BackupTargetKindEnum = builder.enumType("BackupTargetKind", {
  values: ["database", "project"] as const,
});

// A single run's terminal/in-flight state — distinct from `BackupStatus`
// (which has the schedule-only `"never"`). Local to this domain.
const BackupRunStatusEnum = builder.enumType("BackupRunStatus", {
  values: ["running", "success", "failed"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const BackupRef = builder.objectRef<BackupDTO>("Backup").implement({
  description:
    "A scheduled backup of a database or project to an S3 destination.",
  fields: (t) => ({
    id: t.exposeID("id"),
    teamId: t.exposeID("teamId"),
    name: t.exposeString("name"),
    targetKind: t.field({
      type: BackupTargetKindEnum,
      resolve: (b) => b.targetKind,
    }),
    databaseId: t.exposeID("databaseId", { nullable: true }),
    databaseName: t.exposeString("databaseName", { nullable: true }),
    projectId: t.exposeID("projectId", { nullable: true }),
    projectName: t.exposeString("projectName", { nullable: true }),
    destinationId: t.exposeID("destinationId"),
    destinationName: t.exposeString("destinationName"),
    schedule: t.exposeString("schedule", { description: "Cron expression." }),
    retentionDays: t.exposeInt("retentionDays"),
    lastRunAt: t.exposeString("lastRunAt", { nullable: true }),
    lastStatus: t.field({
      type: BackupStatusEnum,
      resolve: (b) => b.lastStatus,
    }),
    enabled: t.exposeBoolean("enabled"),
    createdAt: t.exposeString("createdAt"),
  }),
});

export const BackupRunRef = builder
  .objectRef<BackupRun>("BackupRun")
  .implement({
    description:
      "One executed backup — a single dump+upload artifact, and the source " +
      "for an in-place restore.",
    fields: (t) => ({
      id: t.exposeID("id"),
      teamId: t.exposeID("teamId"),
      backupId: t.exposeID("backupId", {
        nullable: true,
        description: "The owning schedule, or null for an ad-hoc run.",
      }),
      targetKind: t.field({
        type: BackupTargetKindEnum,
        resolve: (r) => r.targetKind,
      }),
      databaseId: t.exposeID("databaseId", { nullable: true }),
      projectId: t.exposeID("projectId", { nullable: true }),
      destinationId: t.exposeID("destinationId"),
      objectKey: t.exposeString("objectKey", {
        description: "S3 object key of the uploaded artifact.",
      }),
      // Float, not Int — a backup artifact can exceed 2^31 bytes (>2 GB).
      sizeBytes: t.exposeFloat("sizeBytes"),
      status: t.field({
        type: BackupRunStatusEnum,
        resolve: (r) => r.status,
      }),
      error: t.exposeString("error", { nullable: true }),
      startedAt: t.exposeString("startedAt"),
      finishedAt: t.exposeString("finishedAt", { nullable: true }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const CreateBackupInputType = builder.inputType("CreateBackupInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    // Which kind of target this schedule backs up. Optional: omitted defaults to
    // "database" (legacy schedules could only target a database).
    targetKind: t.field({ type: BackupTargetKindEnum, required: false }),
    databaseId: t.string({ required: false }),
    // Set when targetKind is "project"; otherwise leave null.
    projectId: t.string({ required: false }),
    destinationId: t.string({ required: true }),
    schedule: t.string({ required: true }),
    retentionDays: t.int({ required: true }),
  }),
});

// Editing an existing schedule. The target binding (kind + database/project) is
// fixed at creation, so only the settings below are editable; `enabled` has its
// own toggle mutation.
const UpdateBackupInputType = builder.inputType("UpdateBackupInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    destinationId: t.string({ required: true }),
    schedule: t.string({ required: true }),
    retentionDays: t.int({ required: true }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  backups: t.field({
    type: [BackupRef],
    authScopes: { loggedIn: true },
    description: "All backup schedules in the active team, newest first.",
    resolve: () => listBackups(),
  }),
  backupRuns: t.field({
    type: [BackupRunRef],
    authScopes: { loggedIn: true },
    description:
      "Recorded backup runs for one target (a project OR a database), " +
      "newest first. Pass exactly one of projectId / databaseId.",
    args: {
      projectId: t.arg.string({ required: false }),
      databaseId: t.arg.string({ required: false }),
    },
    resolve: (_r, { projectId, databaseId }) =>
      listBackupRuns({
        projectId: projectId ?? undefined,
        databaseId: databaseId ?? undefined,
      }),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every backup server action)                              */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Create a backup schedule. Returns true.",
    args: { input: t.arg({ type: CreateBackupInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await createBackup({
        name: input.name,
        targetKind: input.targetKind ?? undefined,
        databaseId: input.databaseId ?? null,
        projectId: input.projectId ?? null,
        destinationId: input.destinationId,
        schedule: input.schedule,
        retentionDays: input.retentionDays,
      });
      return true;
    },
  }),
  runBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Run a backup schedule manually now. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await runBackup(id);
      return true;
    },
  }),
  runProjectBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description:
      "Run an ad-hoc backup of a project now (no owning schedule). Returns " +
      "true.",
    args: {
      projectId: t.arg.string({ required: true }),
      destinationId: t.arg.string({ required: true }),
    },
    resolve: async (_r, { projectId, destinationId }) => {
      await runProjectBackup(projectId, destinationId);
      return true;
    },
  }),
  restoreBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description:
      "Restore a backup run in place (overwrites the live target). Returns " +
      "true.",
    args: { runId: t.arg.string({ required: true }) },
    resolve: async (_r, { runId }) => {
      await restoreBackup(runId);
      return true;
    },
  }),
  toggleBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Enable or disable a backup schedule. Returns true.",
    args: {
      id: t.arg.string({ required: true }),
      enabled: t.arg.boolean({ required: true }),
    },
    resolve: async (_r, { id, enabled }) => {
      await toggleBackup(id, enabled);
      return true;
    },
  }),
  updateBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description:
      "Edit a backup schedule's name, destination, cron and retention. The " +
      "target it backs up is fixed at creation and cannot be changed. Returns " +
      "true.",
    args: {
      id: t.arg.string({ required: true }),
      input: t.arg({ type: UpdateBackupInputType, required: true }),
    },
    resolve: async (_r, { id, input }) => {
      await updateBackup(id, {
        name: input.name,
        destinationId: input.destinationId,
        schedule: input.schedule,
        retentionDays: input.retentionDays,
      });
      return true;
    },
  }),
  deleteBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_infra" },
    description: "Delete a backup schedule. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteBackup(id);
      return true;
    },
  }),
  deleteBackupArtifacts: t.field({
    type: "Int",
    // The precise capability VARIES by target kind (project → deploy, database →
    // manage_infra, mirroring each target's own delete gate), which a single
    // static authScope can't express — so the outer gate is just loggedIn and
    // `deleteAllBackupArtifacts` enforces the exact per-kind capability in the
    // data layer (the builder's documented defense-in-depth model). This avoids
    // the mismatch where a static manage_infra scope would hard-block a
    // deploy-only member from deleting a project they're otherwise allowed to.
    authScopes: { loggedIn: true },
    description:
      "Delete ALL of a target's S3 backup artifacts (across every destination " +
      "it ran to) plus their run records. The 'also delete backups' branch of " +
      "deleting a database or project. Returns the number of objects removed. " +
      "Throws if any destination's sweep failed (so the caller can abort the " +
      "target deletion rather than orphan bucket objects).",
    args: {
      targetKind: t.arg({ type: BackupTargetKindEnum, required: true }),
      targetId: t.arg.string({ required: true }),
    },
    resolve: async (_r, { targetKind, targetId }) => {
      const { deleted, failedDestinations } = await deleteAllBackupArtifacts({
        kind: targetKind,
        targetId,
      });
      // A partial sweep is a failure: surface it so the delete flow aborts and
      // the operator can retry, rather than deleting the target over a bucket we
      // could not fully clear.
      if (failedDestinations.length > 0) {
        throw new Error(
          `Could not delete every backup artifact (failed for ` +
            `${failedDestinations.length} destination` +
            `${failedDestinations.length === 1 ? "" : "s"}). The ${targetKind} ` +
            `was not deleted — check the destination is reachable and retry.`,
        );
      }
      return deleted;
    },
  }),
}));
