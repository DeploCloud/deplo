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

// databases - [Database](../../../types.ts). `connection_string_enc` is a secret; `server_id` RESTRICT.
export const databases = pgTable(
  "databases",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // Placement, exactly like an App's: the Environment this database belongs to,
    // which is also the network it is reachable on. NULL ⇒ the team's own network.
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    // DISPLAY name only - editable in Settings → General, like an App's. The
    // container's identity is `host` (the compose project / volume / DNS name),
    // frozen at create: renaming a database never touches the running stack.
    name: text("name").notNull(),
    // Uploaded display logo (a base64 image data-URI), or NULL to fall back to
    // the engine's own brand mark. Same column contract and validation as
    // `apps.logo`; purely cosmetic, never read by a deploy.
    logo: text("logo"),
    type: text("type").notNull(),
    version: text("version").notNull(),
    // The engine login the connection string authenticates as AND (except
    // mysql/mariadb, which always dump as root) the backup dump user.
    username: text("username").notNull(),
    // The logical database the engine creates on first init (POSTGRES_DB /
    // MYSQL_DATABASE / CLICKHOUSE_DB / mongo default DB).
    dbName: text("db_name").notNull(),
    status: text("status").notNull(),
    // The twin of `apps.data_copy_error`, and the one that matters most: an engine
    // started on a volume a failed migration emptied does not fail, it INITIALISES - a
    // brand new empty database, over the place the old one was meant to be.
    dataCopyError: text("data_copy_error").notNull().default(""),
    // The migration still creating this database. See the apps column.
    migrationRunId: text("migration_run_id"),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "restrict" }),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    connectionStringEnc: text("connection_string_enc").notNull(),
    exposedPublicly: boolean("exposed_publicly").notNull(),
    // The HOST port the container publishes when exposedPublicly is true (the compose
    // `ports:` maps exposed_port:port).
    exposedPort: integer("exposed_port"),
    // Per-database resource limits - the exact flattened ResourceLimits shape and units
    // used on `apps` above (NULL ⇒ uncapped, all-NULL ⇒ `resources: null`; MiB / GiB /
    // milli-CPUs).
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
    // Expert overrides, both applied at the next render/reroute.
    customImage: text("custom_image"),
    customCommand: text("custom_command"),
    // Cron jobs on this database's container - same opt-in switch, same default
    // and same reasoning as `apps.cron_enabled`. A database is a single-container
    // stack, so a job here needs no service selector.
    cronEnabled: boolean("cron_enabled").notNull().default(false),
    sizeMb: bigint("size_mb", { mode: "number" }).notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("databases_team_name_uq").on(t.teamId, t.name),
    index("databases_environment_idx").on(t.environmentId),
  ],
);

// databaseMounts - [Database.mounts](../../../types.ts) → ordered child of the engine's own config files.
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
