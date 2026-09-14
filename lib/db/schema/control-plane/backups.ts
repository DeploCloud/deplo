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

// backupDestination - [BackupDestination](../../../types.ts): a bucket or a server's disk, one `kind` column.
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
    // Opt OUT of the SSRF guard on the endpoint, for a bucket that lives on the
    // operator's own private network.
    allowPrivateEndpoint: boolean("allow_private_endpoint")
      .notNull()
      .default(false),
    // Advanced per-store quirk flags (`--s3-sign-accept-encoding=false`, …), as typed.
    s3ExtraArgs: text("s3_extra_args"),
    status: text("status").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    // Last "Test connection" verdict, kept so the card can say WHY a destination is in
    // `error` and the connection-log dialog can open on the previous run without
    // silently re-dialing the bucket. All four are NULL until the first test.
    lastTestAt: isoTimestamptz("last_test_at"),
    lastTestError: text("last_test_error"),
    // The server whose agent served the probe (for `s3`, any backup-capable one
    // can; for `server`, it is always that destination's own host).
    // SET NULL: removing a server must not delete a destination's history.
    lastTestServerId: text("last_test_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    lastTestMs: integer("last_test_ms"),
    // Store destinations only: the filesystem headroom the last check saw, so the card
    // can show it without a second RPC.
    lastFreeBytes: bigint("last_free_bytes", { mode: "number" }),
    lastTotalBytes: bigint("last_total_bytes", { mode: "number" }),
    // The root the agent actually resolved (the managed one when `path` is
    // NULL), so the UI shows a real path rather than a blank.
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
      // The age columns are no longer the `server` kind's alone: a bucket artifact is
      // encrypted too (migration 0086), because a project archive carries the app's whole
      // decrypted env and the bucket was the one place it landed in the clear.
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

// backups - [Backup](../../../types.ts), the schedule table (not run history).
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
    // The IANA zone `schedule` is read in. "UTC" for every row that existed before
    // migration 0086, which is what they always meant.
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

// backupRuns - [BackupRun](../../../types.ts), history; a separate table, not a child of `backups`.
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
    // The target's id as PLAIN TEXT, alongside the two FK columns above.
    targetId: text("target_id").notNull(),
    objectKey: text("object_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    // How big the artifact is once DECRYPTED - the exact byte count a download hands
    // the browser, and so its Content-Length. NULL for every run taken before migration
    // 0092 and for one written by an agent that predates the field.
    decryptedSizeBytes: bigint("decrypted_size_bytes", { mode: "number" }),
    // Hex sha256 of the artifact AS WRITTEN (ciphertext, before any decryption). The
    // agent computes it on both halves of a relay and on an S3 upload; the control
    // plane compares them, records the winner here, and re-checks it before a restore.
    sha256: text("sha256"),
    // When the sweep FIRST saw this run's target gone, not when the backup ran.
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
    // FK columns are ON DELETE SET NULL - index them so a delete's cascade is a
    // lookup, not a full-table scan (migration 0042).
    index("backup_runs_app_idx").on(t.appId),
    index("backup_runs_database_idx").on(t.databaseId),
    index("backup_runs_destination_idx").on(t.destinationId),
    // Retention and the orphan sweep both select by (team, target), which is the
    // pair that outlives the FKs above.
    index("backup_runs_team_target_idx").on(t.teamId, t.targetId),
    // The sweep asks only for runs whose target is already gone.
    index("backup_runs_orphaned_idx")
      .on(t.orphanedAt)
      .where(sql`${t.appId} is null and ${t.databaseId} is null`),
  ],
);
