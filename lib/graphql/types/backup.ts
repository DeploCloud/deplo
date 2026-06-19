import { builder } from "../builder";
import {
  listBackups,
  createBackup,
  runBackup,
  toggleBackup,
  deleteBackup,
  type BackupDTO,
} from "@/lib/data/backups";

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

// `lastStatus` is a local string union on the Backup type and is not shared
// across modules, so we define its enum here rather than in enums.ts. Every
// value already matches /[_a-zA-Z0-9]/, so the plain array form is fine.
const BackupStatusEnum = builder.enumType("BackupStatus", {
  values: ["success", "failed", "running", "never"] as const,
});

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const BackupRef = builder.objectRef<BackupDTO>("Backup").implement({
  description: "A scheduled database backup to an S3 destination.",
  fields: (t) => ({
    id: t.exposeID("id"),
    teamId: t.exposeID("teamId"),
    name: t.exposeString("name"),
    databaseId: t.exposeID("databaseId", { nullable: true }),
    databaseName: t.exposeString("databaseName", { nullable: true }),
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

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

const CreateBackupInputType = builder.inputType("CreateBackupInput", {
  fields: (t) => ({
    name: t.string({ required: true }),
    databaseId: t.string({ required: false }),
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
        databaseId: input.databaseId ?? null,
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
}));
