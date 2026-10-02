import { pgTable, text, integer, primaryKey, index } from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";

// ADR-0035. Local to the machine it is on: a Deplo move never copies these, and never wipes them.
export const deploMoves = pgTable(
  "deplo_moves",
  {
    id: text("id").primaryKey(),
    side: text("side").notNull(),
    state: text("state").notNull(),
    codeHash: text("code_hash"),
    codeEnc: text("code_enc"),
    expiresAt: isoTimestamptz("expires_at"),
    peerUrl: text("peer_url"),
    peerInstance: text("peer_instance"),
    // A name, not a user id: the copy replaces every user on the receiving side.
    startedBy: text("started_by").notNull(),
    error: text("error").notNull().default(""),
    rowsCopied: integer("rows_copied").notNull().default(0),
    unreadable: integer("unreadable").notNull().default(0),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
    finishedAt: isoTimestamptz("finished_at"),
  },
  (t) => [index("deplo_moves_side_state_idx").on(t.side, t.state)],
);

export const deploMoveServers = pgTable(
  "deplo_move_servers",
  {
    moveId: text("move_id")
      .notNull()
      .references(() => deploMoves.id, { onDelete: "cascade" }),
    serverId: text("server_id").notNull(),
    name: text("name").notNull(),
    position: integer("position").notNull(),
    state: text("state").notNull().default("waiting"),
    error: text("error").notNull().default(""),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.moveId, t.serverId] })],
);
