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

// deploymentLogLevel - [LogLevel](../../../types.ts); closed, verbose builds only ever emit these.
export const deploymentLogLevel = pgEnum("deployment_log_level", [
  "info",
  "warn",
  "error",
  "debug",
  "command",
  "success",
]);

// deployments - [Deployment](../../../types.ts), fully flat; sorts are ORDER BY created_at DESC, seq DESC.
export const deployments = pgTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    // Denormalized owning server (mirrors apps.server_id at insert time). NOT a FK - a
    // deployment is a historical record that must survive its server's deletion
    // (apps.server_id is RESTRICT, so a live service can't lose its server).
    serverId: text("server_id"),
    // The server this deploy BUILT on, when that was not `server_id`.
    buildServerId: text("build_server_id"),
    status: text("status").notNull(),
    environment: text("environment").notNull(),
    // The host-side KEY this deploy owns: the container `deplo-<key>`, the stack file
    // `<key>.yml`, the files dir `files/<key>`, the named volumes `deplo-<key>-<name>`
    // and every agent RPC.
    deployKey: text("deploy_key").notNull(),
    // The preview this deploy belongs to, or NULL for production. `SET NULL`, not
    // cascade: destroying a preview must never delete the build history of what
    // it deployed.
    previewId: text("preview_id").references(
      (): AnyPgColumn => appPreviews.id,
      {
        onDelete: "set null",
      },
    ),
    // Denormalized pull-request number so the deployments list can still say
    // "PR #42" after the preview row is gone.
    prNumber: integer("pr_number"),
    commitSha: text("commit_sha").notNull(),
    commitMessage: text("commit_message").notNull(),
    commitAuthor: text("commit_author").notNull(),
    branch: text("branch").notNull(),
    url: text("url").notNull(),
    readyAt: isoTimestamptz("ready_at"),
    // When the build actually STARTED - the moment the queue drain claimed this row
    // (`queued` → `building`), i.e. the instant `build_duration_ms` is measured from.
    startedAt: isoTimestamptz("started_at"),
    buildDurationMs: bigint("build_duration_ms", { mode: "number" }),
    // This deploy must REPLACE the running containers even when the rendered stack is
    // unchanged (`docker compose up --force-recreate`).
    forceRecreate: boolean("force_recreate").notNull().default(false),
    // The image tag this deploy actually rendered into its stack - the string the agent
    // built and `compose up` ran (migration 0094).
    imageRef: text("image_ref"),
    // Set when this deploy is a ROLLBACK: the id of the deployment whose image it
    // re-ran.
    rollbackOf: text("rollback_of"),
    creator: text("creator").notNull(),
    // WHO `creator` names, when it names somebody with a Deplo account. `creator` stays
    // free text because it also carries a GitHub login for a webhook push, which
    // belongs to no account here.
    creatorUserId: text("creator_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The git host `creator` is a login ON, when a webhook push wrote this row.
    // NULL ⇒ a person on this instance, so the UI shows their account instead.
    creatorProvider: text("creator_provider"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("deployments_app_created_idx").on(
      t.appId,
      t.createdAt.desc(),
      t.seq.desc(),
    ),
    // The deploy queue's hot path: pick the OLDEST queued deploy for a server. Partial
    // (queued-only) so it indexes just the live backlog, not the whole deploy history;
    // ascending (createdAt, seq) matches the drain's oldest-first ORDER BY.
    index("deployments_queued_server_idx")
      .on(t.serverId, t.createdAt, t.seq)
      .where(sql`${t.status} = 'queued'`),
    // The same hot path once a BUILD SERVER is in play: the queue drains on the
    // lane, `coalesce(build_server_id, server_id)`, which the index above cannot
    // serve. Its sibling stays because other readers still ask by owning server.
    index("deployments_queued_lane_idx")
      .on(sql`coalesce(${t.buildServerId}, ${t.serverId})`, t.createdAt, t.seq)
      .where(sql`${t.status} = 'queued'`),
    // A pull request preview's own build history, newest first.
    index("deployments_preview_idx").on(
      t.previewId,
      t.createdAt.desc(),
      t.seq.desc(),
    ),
  ],
);

// deploymentLogs - one row per log line; the identity PK reproduces `Array.push` order.
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

// appPreviews - one ephemeral stack per open pull request, so a preview never repaints production.
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
    // `owner/name` of the HEAD repo. Differs from the App's repo ⇒ a fork.
    headRepo: text("head_repo").notNull().default(""),
    // The fork's own clone URL: a fork's head ref does not exist on the base
    // repo, and `git clone --branch` accepts neither a SHA nor `refs/pull/N/head`.
    headCloneUrl: text("head_clone_url").notNull().default(""),
    baseBranch: text("base_branch").notNull().default(""),
    isFork: boolean("is_fork").notNull().default(false),
    // Who unblocked a fork preview, and at which commit.
    approvedByUserId: text("approved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    approvedAt: isoTimestamptz("approved_at"),
    approvedSha: text("approved_sha"),
    deployKey: text("deploy_key").notNull(),
    host: text("host").notNull(),
    // What the host's router was rendered with, so the URL scheme stays stable.
    certProvider: text("cert_provider").notNull().default("none"),
    // The container port this preview's router forwards to, minted from the app's
    // `preview_port` (or its build port) when the preview is created.
    port: integer("port"),
    status: text("status").notNull().default("queued"),
    latestDeploymentId: text("latest_deployment_id").references(
      (): AnyPgColumn => deployments.id,
      { onDelete: "set null" },
    ),
    url: text("url").notNull().default(""),
    // The ONE sticky comment Deplo edits in place instead of spamming the thread.
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
    // The reaper's two scans, each partial so it indexes only its working set:
    // open previews by idleness, and closed-but-not-torn-down ones to retry.
    index("app_previews_open_idx")
      .on(t.lastActivityAt)
      .where(sql`${t.state} = 'open'`),
    index("app_previews_untorn_idx")
      .on(t.closedAt)
      .where(sql`${t.tornDownAt} is null`),
  ],
);

// pendingTeardowns - a stack that must die on a host that would not confirm it, kept until it does.
export const pendingTeardowns = pgTable(
  "pending_teardowns",
  {
    id: text("id").primaryKey(),
    // The host that still holds it. Removing the server drops the row with it.
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    // The compose project key: `<slug>`, `<slug>__pr-<n>`, or a database host.
    deployKey: text("deploy_key").notNull(),
    // The `deplo.project` label of what is being destroyed - the identity check.
    projectLabel: text("project_label").notNull(),
    // Human name for the Activity copy: by drain time the row it named is gone.
    label: text("label").notNull(),
    // NULL once the owning team is deleted, which is also "nowhere to report to".
    teamId: text("team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    nextAttemptAt: isoTimestamptz("next_attempt_at").notNull(),
    // Set when the ladder ran out. Cleared when that server comes back online.
    abandonedAt: isoTimestamptz("abandoned_at"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("pending_teardowns_server_key_uq").on(t.serverId, t.deployKey),
  ],
);
