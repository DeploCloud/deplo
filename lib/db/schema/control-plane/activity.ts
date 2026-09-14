import { pgTable, text, bigint, index } from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { databases } from "./databases";
import { teams } from "./identity";

// activities - [Activity](../../../types.ts), append-only.
export const activities = pgTable(
  "activities",
  {
    id: text("id").primaryKey(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    message: text("message").notNull(),
    actor: text("actor").notNull(),
    actorUserId: text("actor_user_id"),
    // The git host `actor` is a login ON, when a webhook push wrote this row.
    // NULL ⇒ a person here, or an actor with no host at all (`system`).
    actorProvider: text("actor_provider"),
    appId: text("app_id").references(() => apps.id, {
      onDelete: "set null",
    }),
    // A database is not an App, so it needs its own pointer - without it every
    // database event is indistinguishable from a team-level one (migration 0134).
    databaseId: text("database_id").references(() => databases.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("activities_team_created_idx").on(
      t.teamId,
      t.createdAt.desc(),
      t.seq.desc(),
    ),
    // app_id is ON DELETE SET NULL - index it so deleting an app doesn't scan the
    // whole activity history (migration 0042).
    index("activities_app_idx").on(t.appId),
    index("activities_database_idx").on(t.databaseId),
    // "What has this person done?" - the per-user feed on an account's admin
    // page, which reads across every team and would otherwise seq-scan.
    index("activities_actor_created_idx").on(t.actorUserId, t.createdAt.desc()),
  ],
);
