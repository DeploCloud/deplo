import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { databases } from "./databases";
import { teams } from "./identity";
import { servers } from "./servers";

export const backupDestination = pgTable(
  "backup_destination",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    provider: text("provider"),
    endpoint: text("endpoint"),
    region: text("region"),
    bucket: text("bucket"),
    accessKeyEnc: text("access_key_enc"),
    secretKeyEnc: text("secret_key_enc"),
    serverId: text("server_id").references(() => servers.id, {
      onDelete: "restrict",
    }),
    path: text("path"),
    ageRecipient: text("age_recipient"),
    ageIdentityEnc: text("age_identity_enc"),
    recoveryKeySavedAt: isoTimestamptz("recovery_key_saved_at"),
    allowPrivateEndpoint: boolean("allow_private_endpoint")
      .notNull()
      .default(false),
    s3ExtraArgs: text("s3_extra_args"),
    status: text("status").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    lastTestAt: isoTimestamptz("last_test_at"),
    lastTestError: text("last_test_error"),
    lastTestServerId: text("last_test_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    lastTestMs: integer("last_test_ms"),
    lastFreeBytes: bigint("last_free_bytes", { mode: "number" }),
    lastTotalBytes: bigint("last_total_bytes", { mode: "number" }),
    resolvedPath: text("resolved_path"),
  },
  (t) => [
    index("backup_destination_team_created_idx").on(
      t.teamId,
      t.createdAt.desc(),
    ),
    index("backup_destination_last_test_server_idx").on(t.lastTestServerId),
    index("backup_destination_server_idx").on(t.serverId),
    check(
      "backup_destination_kind_shape",
      sql`(${t.kind} = 's3' and ${t.provider} is not null and ${t.endpoint} is not null
             and ${t.region} is not null and ${t.bucket} is not null
             and ${t.accessKeyEnc} is not null and ${t.secretKeyEnc} is not null
             and ${t.serverId} is null
             and ((${t.ageRecipient} is null and ${t.ageIdentityEnc} is null)
               or (${t.ageRecipient} is not null and ${t.ageIdentityEnc} is not null)))
          or (${t.kind} = 'server' and ${t.serverId} is not null and ${t.ageRecipient} is not null
             and ${t.ageIdentityEnc} is not null and ${t.bucket} is null
             and ${t.accessKeyEnc} is null and ${t.secretKeyEnc} is null)`,
    ),
  ],
);

export const backups = pgTable(
  "backups",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    targetKind: text("target_kind").notNull(),
    databaseId: text("database_id").references(() => databases.id, {
      onDelete: "cascade",
    }),
    appId: text("app_id").references(() => apps.id, {
      onDelete: "cascade",
    }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => backupDestination.id, { onDelete: "restrict" }),
    schedule: text("schedule").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    retentionCount: integer("retention_count").notNull(),
    lastRunAt: isoTimestamptz("last_run_at"),
    lastStatus: text("last_status").notNull(),
    enabled: boolean("enabled").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    check(
      "backups_target_kind_xor",
      sql`(${t.targetKind} = 'database' and ${t.databaseId} is not null and ${t.appId} is null)
          or (${t.targetKind} = 'app' and ${t.appId} is not null and ${t.databaseId} is null)`,
    ),
  ],
);

export const backupRuns = pgTable(
  "backup_runs",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    backupId: text("backup_id").references(() => backups.id, {
      onDelete: "set null",
    }),
    targetKind: text("target_kind").notNull(),
    databaseId: text("database_id").references(() => databases.id, {
      onDelete: "set null",
    }),
    appId: text("app_id").references(() => apps.id, {
      onDelete: "set null",
    }),
    destinationId: text("destination_id")
      .notNull()
      .references(() => backupDestination.id, { onDelete: "restrict" }),
    targetId: text("target_id").notNull(),
    objectKey: text("object_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    decryptedSizeBytes: bigint("decrypted_size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    orphanedAt: isoTimestamptz("orphaned_at"),
    status: text("status").notNull(),
    error: text("error"),
    startedAt: isoTimestamptz("started_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
  },
  (t) => [
    index("backup_runs_team_started_idx").on(
      t.teamId,
      t.startedAt.desc(),
      t.seq.desc(),
    ),
    index("backup_runs_running_idx")
      .on(t.status)
      .where(sql`${t.status} = 'running'`),
    index("backup_runs_app_idx").on(t.appId),
    index("backup_runs_database_idx").on(t.databaseId),
    index("backup_runs_destination_idx").on(t.destinationId),
    index("backup_runs_team_target_idx").on(t.teamId, t.targetId),
    index("backup_runs_orphaned_idx")
      .on(t.orphanedAt)
      .where(sql`${t.appId} is null and ${t.databaseId} is null`),
  ],
);
