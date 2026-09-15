import {
  pgTable,
  text,
  integer,
  boolean,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { teams, users } from "./identity";
import { environments, folders, projects } from "./projects";

export const projectGrants = pgTable(
  "project_grants",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.userId, t.capability] }),
    index("project_grants_user_idx").on(t.userId),
  ],
);

export const folderGrants = pgTable(
  "folder_grants",
  {
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.folderId, t.userId, t.capability] }),
    index("folder_grants_user_idx").on(t.userId),
  ],
);

export const appGrants = pgTable(
  "app_grants",
  {
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.appId, t.userId, t.capability] }),
    index("app_grants_user_idx").on(t.userId),
  ],
);

export const environmentGrants = pgTable(
  "environment_grants",
  {
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.environmentId, t.userId, t.capability] }),
    index("environment_grants_user_idx").on(t.userId),
  ],
);

export const teamRoles = pgTable(
  "team_roles",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    builtinKey: text("builtin_key"),
    name: text("name").notNull(),
    description: text("description"),
    requireTwoFactor: boolean("require_two_factor").notNull().default(false),
    scoped: boolean("scoped").notNull().default(false),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("team_roles_builtin_uq")
      .on(t.teamId, t.builtinKey)
      .where(sql`${t.builtinKey} is not null`),
    uniqueIndex("team_roles_name_uq").on(t.teamId, sql`lower(${t.name})`),
  ],
);

export const teamRoleScopeProjects = pgTable(
  "team_role_scope_projects",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => teamRoles.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.projectId] }),
    index("team_role_scope_projects_project_idx").on(t.projectId),
  ],
);

export const teamRoleScopeFolders = pgTable(
  "team_role_scope_folders",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => teamRoles.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.folderId] }),
    index("team_role_scope_folders_folder_idx").on(t.folderId),
  ],
);

export const teamRoleScopeEnvironments = pgTable(
  "team_role_scope_environments",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => teamRoles.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.environmentId] }),
    index("team_role_scope_environments_environment_idx").on(t.environmentId),
  ],
);

export const teamRoleScopeApps = pgTable(
  "team_role_scope_apps",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => teamRoles.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.appId] }),
    index("team_role_scope_apps_app_idx").on(t.appId),
  ],
);

export const teamRoleCapabilities = pgTable(
  "team_role_capabilities",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => teamRoles.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.capability] })],
);

export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    roleId: text("role_id").references(() => teamRoles.id, {
      onDelete: "restrict",
    }),
    granular: boolean("granular").notNull().default(false),
    customCapabilities: boolean("custom_capabilities").notNull().default(false),
    switcherPosition: integer("switcher_position"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("memberships_user_team_uq").on(t.userId, t.teamId)],
);

export const membershipCapabilities = pgTable(
  "membership_capabilities",
  {
    membershipId: text("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [primaryKey({ columns: [t.membershipId, t.capability] })],
);
