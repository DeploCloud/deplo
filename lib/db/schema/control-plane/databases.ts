import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { teams } from "./identity";
import { environments } from "./projects";
import { servers } from "./servers";

export const databases = pgTable(
  "databases",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    logo: text("logo"),
    type: text("type").notNull(),
    version: text("version").notNull(),
    username: text("username").notNull(),
    dbName: text("db_name").notNull(),
    status: text("status").notNull(),
    dataCopyError: text("data_copy_error").notNull().default(""),
    migrationRunId: text("migration_run_id"),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    connectionStringEnc: text("connection_string_enc").notNull(),
    exposedPublicly: boolean("exposed_publicly").notNull(),
    exposedPort: integer("exposed_port"),
    resourceMemLimitMb: integer("resource_mem_limit_mb"),
    resourceMemReservationMb: integer("resource_mem_reservation_mb"),
    resourceMemSwapMb: integer("resource_mem_swap_mb"),
    resourceCpuMilli: integer("resource_cpu_milli"),
    resourceCpuShares: integer("resource_cpu_shares"),
    resourceCpuset: text("resource_cpuset"),
    resourcePidsLimit: integer("resource_pids_limit"),
    resourceShmSizeMb: integer("resource_shm_size_mb"),
    resourceStorageSizeGb: integer("resource_storage_size_gb"),
    resourceUlimitNofile: integer("resource_ulimit_nofile"),
    resourceUlimitNproc: integer("resource_ulimit_nproc"),
    resourceOomScoreAdj: integer("resource_oom_score_adj"),
    customImage: text("custom_image"),
    customCommand: text("custom_command"),
    cronEnabled: boolean("cron_enabled").notNull().default(false),
    sizeMb: bigint("size_mb", { mode: "number" }).notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("databases_team_name_uq").on(t.teamId, t.name),
    index("databases_environment_idx").on(t.environmentId),
  ],
);

export const databaseMounts = pgTable(
  "database_mounts",
  {
    databaseId: text("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    filePath: text("file_path").notNull(),
    content: text("content").notNull(),
    mountPath: text("mount_path").notNull(),
  },
  (t) => [primaryKey({ columns: [t.databaseId, t.position] })],
);
