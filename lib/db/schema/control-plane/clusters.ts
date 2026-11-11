import {
  pgTable,
  text,
  integer,
  boolean,
  bigint,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { teams } from "./identity";
import { servers } from "./servers";

// Several servers that act as one (spec #176). A null leader server means Deplo's own machine.
export const clusters = pgTable("clusters", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  allTeams: boolean("all_teams").notNull().default(true),
  leaderServerId: text("leader_server_id").references(() => servers.id, {
    onDelete: "set null",
  }),
  leaderEpoch: integer("leader_epoch").notNull().default(0),
  // Set while Deplo's own machine leads because the leader's server does not answer.
  leaderTakeoverAt: isoTimestamptz("leader_takeover_at"),
  // The team whose Activity carries what Deplo says about the leader.
  leaderTeamId: text("leader_team_id").references(() => teams.id, {
    onDelete: "set null",
  }),
  // The last leader event this control plane applied; a reconnect replays from here.
  eventSeq: bigint("event_seq", { mode: "number" }).notNull().default(0),
  createdAt: isoTimestamptz("created_at").notNull(),
});

export const clusterTeams = pgTable(
  "cluster_teams",
  {
    clusterId: text("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.clusterId, t.teamId] }),
    index("cluster_teams_team_idx").on(t.teamId),
  ],
);

// The age public key of each leader holding this cluster's bundles; a null server is Deplo's machine.
export const clusterLeaderKeys = pgTable(
  "cluster_leader_keys",
  {
    clusterId: text("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    publicKey: text("public_key").notNull(),
    serverId: text("server_id").references(() => servers.id, {
      onDelete: "cascade",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.clusterId, t.publicKey] })],
);

// The deployment whose failover bundle each leader key holds for a workload (ADR-0045); a relink compares and resends.
export const failoverBundlePushes = pgTable(
  "failover_bundle_pushes",
  {
    workloadKind: text("workload_kind").notNull(),
    workloadId: text("workload_id").notNull(),
    keyFingerprint: text("key_fingerprint").notNull(),
    deploymentId: text("deployment_id").notNull(),
    // The bundle under DEPLO_SECRET, so a new leader key can be sealed to it without a redeploy.
    bundleEnc: text("bundle_enc").notNull(),
    // Null until the leader acknowledged it.
    pushedAt: isoTimestamptz("pushed_at"),
  },
  (t) => [
    primaryKey({ columns: [t.workloadKind, t.workloadId, t.keyFingerprint] }),
    index("failover_bundle_pushes_key_idx").on(t.keyFingerprint),
  ],
);

// A server in a cluster: at most one cluster per server, so the server id is the key.
export const clusterMembers = pgTable(
  "cluster_members",
  {
    serverId: text("server_id")
      .primaryKey()
      .references(() => servers.id, { onDelete: "cascade" }),
    clusterId: text("cluster_id")
      .notNull()
      .references(() => clusters.id, { onDelete: "cascade" }),
    joinedAt: isoTimestamptz("joined_at").notNull(),
    // Set while the member is being emptied; no new work is placed on it.
    emptyingSince: isoTimestamptz("emptying_since"),
    // Why emptying stopped, until an admin continues; empty while it runs.
    emptyingError: text("emptying_error").notNull().default(""),
    // The workload moving now: its id, and "app" or "database". Empty between two moves.
    emptyingWorkload: text("emptying_workload").notNull().default(""),
    emptyingWorkloadKind: text("emptying_workload_kind").notNull().default(""),
    emptyingTotal: integer("emptying_total").notNull().default(0),
    // The team whose Activity carries what Deplo says about this emptying.
    emptyingTeamId: text("emptying_team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    // What the leader last said about this member's lease: ok, not_responding or fenced.
    leaseState: text("lease_state").notNull().default("ok"),
    leaseChangedAt: isoTimestamptz("lease_changed_at"),
  },
  (t) => [index("cluster_members_cluster_idx").on(t.clusterId)],
);

// Which member holds which release image of a cluster App, and how far a copy has got (spec #176).
export const clusterImageCopies = pgTable(
  "cluster_image_copies",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    imageRef: text("image_ref").notNull(),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    // "copying" | "held" | "failed"
    state: text("state").notNull(),
    error: text("error").notNull().default(""),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.imageRef, t.serverId] }),
    index("cluster_image_copies_server_idx").on(t.serverId),
  ],
);

// The architectures a pulled image is published for, as its registry listed them. No row means not known.
export const imageArchitectures = pgTable(
  "image_architectures",
  {
    imageRef: text("image_ref").notNull(),
    arch: text("arch").notNull(),
    checkedAt: isoTimestamptz("checked_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.imageRef, t.arch] })],
);

// The leader's placement, mirrored; only the placement module writes it. A null member is waiting for room.
export const workloadPlacements = pgTable(
  "workload_placements",
  {
    kind: text("kind").notNull(),
    workloadId: text("workload_id").notNull(),
    replica: integer("replica").notNull().default(0),
    memberServerId: text("member_server_id").references(() => servers.id, {
      onDelete: "set null",
    }),
    epoch: integer("epoch").notNull().default(0),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.workloadId, t.replica] }),
    index("workload_placements_member_idx").on(t.memberServerId),
  ],
);

// One row per server whose cluster binary update is failing; none means idle. See docs/agents/cluster-rollout.md.
export const clusterBinaryUpdates = pgTable("cluster_binary_updates", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),
  targetVersion: text("target_version").notNull(),
  // "busy" | "error" | "no_return"
  failure: text("failure").notNull(),
  attempts: integer("attempts").notNull().default(0),
  firstFailedAt: isoTimestamptz("first_failed_at").notNull(),
  nextRetryAt: isoTimestamptz("next_retry_at").notNull(),
  lastError: text("last_error").notNull().default(""),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});
