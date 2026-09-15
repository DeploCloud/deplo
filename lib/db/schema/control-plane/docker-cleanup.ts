import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { isoTimestamptz } from "../columns";
import { servers } from "./servers";

export const dockerCleanupPolicy = pgTable("docker_cleanup_policy", {
  id: text("id").primaryKey().default("default"),
  enabled: boolean("enabled").notNull(),
  schedule: text("schedule").notNull(),
  minAgeHours: integer("min_age_hours").notNull(),
  keepImagesPerApp: integer("keep_images_per_app").notNull(),
  createdAt: isoTimestamptz("created_at").notNull(),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

export const dockerCleanupPolicyScopes = pgTable(
  "docker_cleanup_policy_scopes",
  {
    policyId: text("policy_id")
      .notNull()
      .references(() => dockerCleanupPolicy.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
  },
  (t) => [primaryKey({ columns: [t.policyId, t.scope] })],
);

export const dockerCleanupExcludedServers = pgTable(
  "docker_cleanup_excluded_servers",
  {
    serverId: text("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "cascade" }),
  },
);

export const dockerCleanupRuns = pgTable(
  "docker_cleanup_runs",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    serverId: text("server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    serverName: text("server_name").notNull(),
    trigger: text("trigger").notNull(),
    actor: text("actor").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    reclaimedBytes: bigint("reclaimed_bytes", { mode: "number" }).notNull(),
    startedAt: isoTimestamptz("started_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
  },
  (t) => [
    index("docker_cleanup_runs_server_started_idx").on(
      t.serverId,
      t.startedAt.desc(),
      t.seq.desc(),
    ),
    index("docker_cleanup_runs_running_idx")
      .on(t.status)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const dockerCleanupRunItems = pgTable(
  "docker_cleanup_run_items",
  {
    runId: text("run_id")
      .notNull()
      .references(() => dockerCleanupRuns.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    reclaimedBytes: bigint("reclaimed_bytes", { mode: "number" }).notNull(),
    itemsRemoved: integer("items_removed").notNull(),
    skipped: boolean("skipped").notNull(),
    error: text("error"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.scope] })],
);
