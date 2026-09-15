import {
  pgTable,
  text,
  boolean,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { teams, users } from "./identity";
import { environments, projects } from "./projects";

export const envVars = pgTable(
  "env_vars",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull(),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [uniqueIndex("env_vars_app_key_uq").on(t.appId, t.key)],
);

export const appPreviewEnvVars = pgTable(
  "app_preview_env_vars",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull().default("plain"),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [uniqueIndex("app_preview_env_vars_app_key_uq").on(t.appId, t.key)],
);

export const envVarTargets = pgTable(
  "env_var_targets",
  {
    envVarId: text("env_var_id")
      .notNull()
      .references(() => envVars.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
  },
  (t) => [primaryKey({ columns: [t.envVarId, t.target] })],
);

export const sharedEnvVars = pgTable(
  "shared_env_vars",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueEnc: text("value_enc").notNull(),
    type: text("type").notNull(),
    // A column, not count(teams) > 1: deleting a team cascades a junction row away and must not disarm the variable.
    autoInject: boolean("auto_inject").notNull().default(false),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    updatedByUserId: text("updated_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    index("shared_env_vars_team_idx").on(t.teamId),
    index("shared_env_vars_team_key_idx").on(t.teamId, t.key),
  ],
);

export const sharedEnvVarTargets = pgTable(
  "shared_env_var_targets",
  {
    varId: text("var_id")
      .notNull()
      .references(() => sharedEnvVars.id, { onDelete: "cascade" }),
    target: text("target").notNull(),
  },
  (t) => [primaryKey({ columns: [t.varId, t.target] })],
);

export const sharedEnvVarEnvironments = pgTable(
  "shared_env_var_environments",
  {
    varId: text("var_id")
      .notNull()
      .references(() => sharedEnvVars.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.varId, t.environmentId] }),
    index("shared_env_var_environments_env_idx").on(t.environmentId),
  ],
);

export const sharedEnvVarProjects = pgTable(
  "shared_env_var_projects",
  {
    varId: text("var_id")
      .notNull()
      .references(() => sharedEnvVars.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.varId, t.projectId] }),
    index("shared_env_var_projects_project_idx").on(t.projectId),
  ],
);

export const sharedEnvVarTeams = pgTable(
  "shared_env_var_teams",
  {
    varId: text("var_id")
      .notNull()
      .references(() => sharedEnvVars.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.varId, t.teamId] }),
    index("shared_env_var_teams_team_idx").on(t.teamId),
  ],
);

export const sharedEnvVarApps = pgTable(
  "shared_env_var_apps",
  {
    varId: text("var_id")
      .notNull()
      .references(() => sharedEnvVars.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.varId, t.appId] }),
    index("shared_env_var_apps_app_idx").on(t.appId),
  ],
);
