import {
  pgTable,
  text,
  integer,
  boolean,
  uniqueIndex,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { teams, users } from "./identity";

// folders - [Folder](../../../types.ts). Ownership survives the owner leaving the team.
export const folders = pgTable(
  "folders",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    parentId: text("parent_id").references((): AnyPgColumn => folders.id, {
      onDelete: "set null",
    }),
    color: text("color"),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The Project CONTAINER this folder lives in, or NULL when the folder sits at the
    // team top level (additive adoption - ADR-0008). Forward-ref thunk because
    // `projects` (the container) is declared just below.
    projectId: text("project_id").references((): AnyPgColumn => projects.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    index("folders_owner_idx").on(t.ownerUserId),
    index("folders_project_idx").on(t.projectId),
  ],
);

// projects - the team-scoped Project CONTAINER (ADR-0008); a Project never nests in a Project.
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    color: text("color"),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // The migration still creating this project. See the apps column.
    migrationRunId: text("migration_run_id"),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("projects_team_slug_uq").on(t.teamId, t.slug),
    index("projects_owner_idx").on(t.ownerUserId),
  ],
);

// environments - [Environment](../../../types.ts), a per-Project isolated deploy target (ADR-0008).
export const environments = pgTable(
  "environments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").notNull(),
    gitBranch: text("git_branch").notNull().default(""),
    isDefault: boolean("is_default").notNull().default(false),
    position: integer("position").notNull(),
    // The migration still creating this environment. See the apps column.
    migrationRunId: text("migration_run_id"),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("environments_project_name_uq").on(t.projectId, t.name),
    uniqueIndex("environments_project_slug_uq").on(t.projectId, t.slug),
    index("environments_project_idx").on(t.projectId),
  ],
);
