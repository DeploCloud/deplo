import { pgTable, text, integer, primaryKey } from "drizzle-orm/pg-core";

import { apps } from "./apps";
import { databases } from "./databases";
import { teams } from "./identity";
import { folders, projects } from "./projects";

// teamAppOrder - team-wide App display order.
export const teamAppOrder = pgTable(
  "team_app_order",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.appId] })],
);

// teamFolderOrder - team-wide folder display order.
export const teamFolderOrder = pgTable(
  "team_folder_order",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.folderId] })],
);

// teamProjectOrder - team-wide Project-container display order (ADR-0008).
export const teamProjectOrder = pgTable(
  "team_project_order",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.projectId] })],
);

// teamDatabaseOrder - team-wide database display order for the Storage grid.
export const teamDatabaseOrder = pgTable(
  "team_database_order",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    databaseId: text("database_id")
      .notNull()
      .references(() => databases.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.databaseId] })],
);
