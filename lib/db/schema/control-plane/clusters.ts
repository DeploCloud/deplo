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
    // What the leader last said about this member's lease: ok, not_responding or fenced.
    leaseState: text("lease_state").notNull().default("ok"),
    leaseChangedAt: isoTimestamptz("lease_changed_at"),
  },
  (t) => [index("cluster_members_cluster_idx").on(t.clusterId)],
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
