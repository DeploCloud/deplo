import {
  pgTable,
  pgEnum,
  text,
  integer,
  bigint,
  boolean,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { teams, users } from "./identity";
import { servers } from "./servers";

export const deploymentLogLevel = pgEnum("deployment_log_level", [
  "info",
  "warn",
  "error",
  "debug",
  "command",
  "success",
]);

export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    serverId: text("server_id"),
    buildServerId: text("build_server_id"),
    status: text("status").notNull(),
    environment: text("environment").notNull(),
    deployKey: text("deploy_key").notNull(),
    previewId: text("preview_id").references(
      (): AnyPgColumn => appPreviews.id,
      {
        onDelete: "set null",
      },
    ),
    prNumber: integer("pr_number"),
    commitSha: text("commit_sha").notNull(),
    commitMessage: text("commit_message").notNull(),
    commitAuthor: text("commit_author").notNull(),
    branch: text("branch").notNull(),
    url: text("url").notNull(),
    readyAt: isoTimestamptz("ready_at"),
    startedAt: isoTimestamptz("started_at"),
    buildDurationMs: bigint("build_duration_ms", { mode: "number" }),
    forceRecreate: boolean("force_recreate").notNull().default(false),
    imageRef: text("image_ref"),
    rollbackOf: text("rollback_of"),
    creator: text("creator").notNull(),
    creatorUserId: text("creator_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    creatorProvider: text("creator_provider"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("deployments_app_created_idx").on(
      t.appId,
      t.createdAt.desc(),
      t.seq.desc(),
    ),
    index("deployments_queued_server_idx")
      .on(t.serverId, t.createdAt, t.seq)
      .where(sql`${t.status} = 'queued'`),
    index("deployments_queued_lane_idx")
      .on(sql`coalesce(${t.buildServerId}, ${t.serverId})`, t.createdAt, t.seq)
      .where(sql`${t.status} = 'queued'`),
    index("deployments_preview_idx").on(
      t.previewId,
      t.createdAt.desc(),
      t.seq.desc(),
    ),
  ],
);

export const deploymentLogs = pgTable(
  "deployment_logs",
  {
    id: bigint("id", { mode: "number" })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    ts: isoTimestamptz("ts").notNull(),
    level: deploymentLogLevel("level").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("deployment_logs_deployment_idx").on(t.deploymentId, t.id)],
);

export const appPreviews = pgTable(
  "app_previews",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    prNumber: integer("pr_number").notNull(),
    prTitle: text("pr_title").notNull().default(""),
    prAuthor: text("pr_author").notNull().default(""),
    prUrl: text("pr_url").notNull().default(""),
    headBranch: text("head_branch").notNull(),
    headSha: text("head_sha").notNull().default(""),
    headRepo: text("head_repo").notNull().default(""),
    headCloneUrl: text("head_clone_url").notNull().default(""),
    baseBranch: text("base_branch").notNull().default(""),
    isFork: boolean("is_fork").notNull().default(false),
    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: isoTimestamptz("approved_at"),
    approvedSha: text("approved_sha"),
    deployKey: text("deploy_key").notNull(),
    host: text("host").notNull(),
    certProvider: text("cert_provider").notNull().default("none"),
    port: integer("port"),
    status: text("status").notNull().default("queued"),
    latestDeploymentId: text("latest_deployment_id").references(
      (): AnyPgColumn => deployments.id,
      { onDelete: "set null" },
    ),
    url: text("url").notNull().default(""),
    commentId: bigint("comment_id", { mode: "number" }),
    state: text("state").notNull().default("open"),
    closedAt: isoTimestamptz("closed_at"),
    tornDownAt: isoTimestamptz("torn_down_at"),
    lastActivityAt: isoTimestamptz("last_activity_at").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("app_previews_app_pr_uq").on(t.appId, t.prNumber),
    uniqueIndex("app_previews_deploy_key_uq").on(t.deployKey),
    uniqueIndex("app_previews_host_uq").on(t.host),
    index("app_previews_app_idx").on(t.appId),
    index("app_previews_open_idx")
      .on(t.lastActivityAt)
      .where(sql`${t.state} = 'open'`),
    index("app_previews_untorn_idx")
      .on(t.closedAt)
      .where(sql`${t.tornDownAt} is null`),
  ],
);

export const pendingTeardowns = pgTable(
  "pending_teardowns",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    deployKey: text("deploy_key").notNull(),
    projectLabel: text("project_label").notNull(),
    label: text("label").notNull(),
    teamId: text("team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    nextAttemptAt: isoTimestamptz("next_attempt_at").notNull(),
    abandonedAt: isoTimestamptz("abandoned_at"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("pending_teardowns_server_key_uq").on(t.serverId, t.deployKey),
  ],
);
