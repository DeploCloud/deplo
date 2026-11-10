import {
  pgTable,
  text,
  integer,
  boolean,
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
