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

export const migrationRunTargets = pgTable(
  "migration_run_targets",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    projectId: text("project_id").notNull(),
    projectName: text("project_name").notNull(),
    serviceId: text("service_id").notNull(),
    serverId: text("server_id"),
    buildServerId: text("build_server_id"),
    exposedPort: integer("exposed_port"),
    exposedPortSet: boolean("exposed_port_set").notNull().default(false),
    state: text("state").notNull().default("pending"),
    stoppedKind: text("stopped_kind"),
    stoppedAt: isoTimestamptz("stopped_at"),
  },
  (t) => [index("migration_run_targets_run_idx").on(t.runId, t.seq)],
);

export const migrationRunServers = pgTable(
  "migration_run_servers",
  {
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    fromId: text("from_id").notNull(),
    toId: text("to_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.fromId] })],
);

export const migrationSourceAddresses = pgTable(
  "migration_source_addresses",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    sourceId: text("source_id").notNull(),
    address: text("address").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.sourceUrl, t.sourceId] })],
);

export const migrationRuns = pgTable(
  "migration_runs",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    sourceUrl: text("source_url").notNull(),
    orgName: text("org_name"),
    platform: text("platform").notNull().default("dokploy"),
    actor: text("actor").notNull(),
    status: text("status").notNull(),
    created: integer("created").notNull(),
    skipped: integer("skipped").notNull(),
    failed: integer("failed").notNull(),
    manual: integer("manual").notNull(),
    error: text("error"),
    startedAt: isoTimestamptz("started_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
    apiKeyEnc: text("api_key_enc"),
    totalSteps: integer("total_steps").notNull().default(0),
    doneSteps: integer("done_steps").notNull().default(0),
    stepLabel: text("step_label"),
    phase: text("phase").notNull().default("config"),
    stopRequested: boolean("stop_requested").notNull().default(false),
    keepSources: boolean("keep_sources").notNull().default(false),
    reportSeenAt: isoTimestamptz("report_seen_at"),
    heartbeatAt: isoTimestamptz("heartbeat_at"),
    runnerOwner: text("runner_owner"),
    actorUserId: text("actor_user_id"),
    sessionId: text("session_id"),
  },
  (t) => [
    index("migration_runs_team_started_idx").on(
      t.teamId,
      t.startedAt.desc(),
      t.seq.desc(),
    ),
    index("migration_runs_session_idx").on(t.sessionId, t.seq),
  ],
);

export const migrationRunMembers = pgTable(
  "migration_run_members",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    sourceRole: text("source_role").notNull().default(""),
    outcome: text("outcome").notNull(),
    message: text("message"),
    linkId: text("link_id"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("migration_run_members_run_email_uq").on(t.runId, t.email),
  ],
);

export const migrationRunDbHosts = pgTable(
  "migration_run_db_hosts",
  {
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    sourceHost: text("source_host").notNull(),
    targetHost: text("target_host").notNull(),
    environmentId: text("environment_id"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.sourceHost] })],
);

export const migrationRunItems = pgTable(
  "migration_run_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => migrationRuns.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    path: text("path").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceName: text("source_name").notNull(),
    at: isoTimestamptz("at"),
    sourceId: text("source_id"),
    outcome: text("outcome").notNull(),
    targetKind: text("target_kind"),
    targetId: text("target_id"),
    message: text("message"),
  },
  (t) => [index("migration_run_items_run_idx").on(t.runId, t.seq)],
);
