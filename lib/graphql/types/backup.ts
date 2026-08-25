import { builder } from "../builder";
import {
  listBackups,
  createBackup,
  runBackup,
  runAppBackup,
  runDatabaseBackup,
  restoreBackup,
  listBackupRuns,
  countBackupArtifacts,
  toggleBackup,
  updateBackup,
  cancelBackupRun,
  deleteBackup,
  deleteBackupRun,
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
  values: ["success", "failed", "running", "canceled", "never"] as const,
});

// What a schedule / run targets. Local to this domain (mirrors how
// DatabaseStatus lives in database.ts) rather than the shared enums file.
const BackupTargetKindEnum = builder.enumType("BackupTargetKind", {
  values: ["database", "app"] as const,
});

// A single run's terminal/in-flight state - distinct from `BackupStatus`
// (which has the schedule-only `"never"`). Local to this domain.
const BackupRunStatusEnum = builder.enumType("BackupRunStatus", {
  values: ["running", "success", "failed", "canceled"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const BackupRef = builder.objectRef<BackupDTO>("Backup").implement({
  description:
    "A scheduled backup of a database or project to a backup destination.",
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
    appId: t.exposeID("appId", { nullable: true }),
    serviceName: t.exposeString("serviceName", { nullable: true }),
    destinationId: t.exposeID("destinationId"),
    destinationName: t.exposeString("destinationName"),
    schedule: t.exposeString("schedule", { description: "Cron expression." }),
    timezone: t.exposeString("timezone", {
      description: "IANA zone the cron is read in. UTC for older schedules.",
    }),
    retentionCount: t.exposeInt("retentionCount", {
      description:
        "How many backups this schedule keeps at its destination. A count, " +
        "not a window in days.",
    }),
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
      "One executed backup - a single dump+upload artifact, and the source " +
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
      appId: t.exposeID("appId", { nullable: true }),
      destinationId: t.exposeID("destinationId"),
      objectKey: t.exposeString("objectKey", {
        description: "Object key of the stored artifact.",
      }),
      verified: t.boolean({
        description:
          "Whether Deplo recorded a checksum when it wrote this artifact, and " +
          "can therefore prove on restore that the file has not been replaced. " +
          "False for runs taken before integrity checking shipped.",
        resolve: (r) => Boolean(r.sha256),
      }),
      // Float, not Int - a backup artifact can exceed 2^31 bytes (>2 GB).
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
    // Set when targetKind is "app"; otherwise leave null.
    appId: t.string({ required: false }),
    destinationId: t.string({ required: true }),
    schedule: t.string({ required: true }),
    // Omitted means UTC, which is what every schedule made before this meant.
    timezone: t.string({ required: false }),
    retentionCount: t.int({ required: true }),
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
    timezone: t.string({ required: false }),
    retentionCount: t.int({ required: true }),
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
      "Recorded backup runs for one target (an app OR a database), " +
      "newest first. Pass exactly one of appId / databaseId.",
    args: {
      appId: t.arg.string({ required: false }),
      databaseId: t.arg.string({ required: false }),
    },
    resolve: (_r, { appId, databaseId }) =>
      listBackupRuns({
        appId: appId ?? undefined,
        databaseId: databaseId ?? undefined,
      }),
  }),
  backupArtifactCount: t.int({
    authScopes: { loggedIn: true },
    description:
      "How many stored backup artifacts (successful runs) one target has. " +
      "Deleting the target removes them, so this is what that delete takes " +
      "with it.",
    args: {
      targetKind: t.arg({ type: BackupTargetKindEnum, required: true }),
      targetId: t.arg.string({ required: true }),
    },
    resolve: (_r, { targetKind, targetId }) =>
      countBackupArtifacts({ kind: targetKind, targetId }),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every backup server action)                              */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  createBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_backups" },
    description: "Create a backup schedule. Returns true.",
    args: { input: t.arg({ type: CreateBackupInputType, required: true }) },
    resolve: async (_r, { input }) => {
      await createBackup({
        name: input.name,
        targetKind: input.targetKind ?? undefined,
        databaseId: input.databaseId ?? null,
        appId: input.appId ?? null,
        destinationId: input.destinationId,
        schedule: input.schedule,
        timezone: input.timezone ?? null,
        retentionCount: input.retentionCount,
      });
      return true;
    },
  }),
  runBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_backups" },
    description: "Run a backup schedule manually now. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await runBackup(id);
      return true;
    },
  }),
  runAppBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_backups" },
    description:
      "Run an ad-hoc backup of an app now (no owning schedule). Returns " +
      "true.",
    args: {
      appId: t.arg.string({ required: true }),
      destinationId: t.arg.string({ required: true }),
    },
    resolve: async (_r, { appId, destinationId }) => {
      await runAppBackup(appId, destinationId);
      return true;
    },
  }),
  runDatabaseBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_backups" },
    description:
      "Run an ad-hoc backup of a database now (no owning schedule). Returns " +
      "true.",
    args: {
      databaseId: t.arg.string({ required: true }),
      destinationId: t.arg.string({ required: true }),
    },
    resolve: async (_r, { databaseId, destinationId }) => {
      await runDatabaseBackup(databaseId, destinationId);
      return true;
    },
  }),
  restoreBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "restore_backups" },
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
    authScopes: { capability: "manage_backups" },
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
    authScopes: { capability: "manage_backups" },
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
        timezone: input.timezone ?? null,
        retentionCount: input.retentionCount,
      });
      return true;
    },
  }),
  cancelBackupRun: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_backups" },
    description:
      "Stop a backup that is running: the record settles as canceled and the " +
      "dump is aborted on the host it runs on. Returns false when it had " +
      "already finished.",
    args: { runId: t.arg.string({ required: true }) },
    resolve: (_r, { runId }) => cancelBackupRun(runId),
  }),
  deleteBackupRun: t.field({
    type: "Boolean",
    authScopes: { capability: "delete_backups" },
    description:
      "Permanently delete ONE backup: the artifact at its destination and the " +
      "run record together. Not the schedule (see deleteBackup) and not the " +
      "target's whole history (see deleteBackupArtifacts). Returns true.",
    args: { runId: t.arg.string({ required: true }) },
    resolve: async (_r, { runId }) => {
      await deleteBackupRun(runId);
      return true;
    },
  }),
  deleteBackup: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_backups" },
    description: "Delete a backup schedule. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteBackup(id);
      return true;
    },
  }),
  deleteBackupArtifacts: t.field({
    type: "Int",
    // The precise capability VARIES by target kind - `delete_apps` for a project,
    // `delete_databases` for a database, each mirroring that target's OWN delete gate,
    // which one static authScope cannot express.
    authScopes: { loggedIn: true },
    description:
      "Delete ALL of a target's backup artifacts (across every destination it " +
      "ran to) plus their run records. The 'also delete backups' branch of " +
      "deleting a database or an app. Returns the number removed. Throws if any " +
      "destination's sweep failed, so the caller can abort the target deletion " +
      "rather than orphan the files.",
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
            `was not deleted - check the destination is reachable and retry.`,
        );
      }
      return deleted;
    },
  }),
}));
