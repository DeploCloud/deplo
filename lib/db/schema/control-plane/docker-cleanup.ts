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

// dockerCleanupPolicy - the singleton cleanup policy; instance-wide, because servers are shared.
export const dockerCleanupPolicy = pgTable("docker_cleanup_policy", {
  // Always `'default'`. The row is a singleton; the PK exists to enforce that.
  id: text("id").primaryKey().default("default"),
  enabled: boolean("enabled").notNull(),
  // 5-field cron, evaluated in **UTC** by lib/backups/cron.ts (no timezone column,
  // no DST handling). Validated at write time: an unparseable expression never
  // matches, so it would silently mean "never run" rather than fail loudly.
  schedule: text("schedule").notNull(),
  // CACHE scopes only (build cache / dangling images / orphan buildkit volumes):
  // reclaim objects older than this (docker's `--filter until=<n>h`); 0 = no age
  // filter.
  minAgeHours: integer("min_age_hours").notNull(),
  // `unused_app_images` only: how many of the newest images to keep per app slug
  // (per built service, for compose stacks). Enforced by the nightly sweep AND
  // right after each deploy. >= 1.
  keepImagesPerApp: integer("keep_images_per_app").notNull(),
  createdAt: isoTimestamptz("created_at").notNull(),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

// dockerCleanupPolicyScopes - the scopes the policy may reclaim, a junction rather than a JSONB array.
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

// dockerCleanupExcludedServers - servers the SCHEDULED sweep skips.
export const dockerCleanupExcludedServers = pgTable(
  "docker_cleanup_excluded_servers",
  {
    serverId: text("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "cascade" }),
  },
);

// dockerCleanupRuns - one cleanup run on one server; the history, separate from the policy.
export const dockerCleanupRuns = pgTable(
  "docker_cleanup_runs",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    serverId: text("server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    serverName: text("server_name").notNull(),
    // `'manual'` | `'scheduled'`.
    trigger: text("trigger").notNull(),
    // The human's name, or `"Scheduler"` for a tick - free text, like `activities.actor`.
    actor: text("actor").notNull(),
    // `'running'` | `'success'` | `'failed'`.
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

// dockerCleanupRunItems - the per-scope breakdown of one run.
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
