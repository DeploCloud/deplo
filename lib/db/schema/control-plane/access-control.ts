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

// projectGrants - one row per (project, user, capability); the owner is `projects.owner_user_id`.
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

// folderGrants - the capabilities a folder OWNER hands to other users.
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

// appGrants - the per-App rung of the folder / project grant ladder.
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

// environmentGrants - the Environment rung of the same ladder.
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

// teamRoles - a named, per-team capability set a member can be assigned.
export const teamRoles = pgTable(
  "team_roles",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // 'owner' | 'member' | 'viewer' for the three defaults (revertible to their
    // preset, never deletable), NULL for a team-authored custom role.
    builtinKey: text("builtin_key"),
    name: text("name").notNull(),
    description: text("description"),
    // Policy, NOT a capability: capabilities are a closed set of 8 that answer "may
    // they do X", while this answers "under what condition does any of it count".
    requireTwoFactor: boolean("require_two_factor").notNull().default(false),
    // The INTENT to reach only part of the team, stored apart from the junctions:
    // deleting a project in the scope cascades its row away, and an emptied scope
    // with no flag would read as "no scope" and silently WIDEN the role.
    scoped: boolean("scoped").notNull().default(false),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    // One row per built-in per team; custom roles (NULL) escape the predicate.
    uniqueIndex("team_roles_builtin_uq")
      .on(t.teamId, t.builtinKey)
      .where(sql`${t.builtinKey} is not null`),
    uniqueIndex("team_roles_name_uq").on(t.teamId, sql`lower(${t.name})`),
  ],
);

// teamRoleScopeProjects - what a scoped role reaches, by whole Project.
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

// teamRoleScopeFolders - what a scoped role reaches, by folder subtree.
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

// teamRoleScopeEnvironments - what a scoped role reaches, by Environment.
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

// teamRoleScopeApps - what a scoped role reaches, by single App.
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

// teamRoleCapabilities - [teamRoles.capabilities] → junction.
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

// memberships - [Membership](../../../types.ts). UNIQUE(user_id, team_id) closes the double-add race.
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
    // The member's RANK: 'owner' outranks everyone (only an owner may act on another
    // owner or hand out the owner role).
    role: text("role").notNull(),
    // The assigned {@link teamRoles} row. `ON DELETE RESTRICT`: a role with members
    // can't be deleted out from under them (the data layer refuses first, with a
    // message naming the count).
    roleId: text("role_id").references(() => teamRoles.id, {
      onDelete: "restrict",
    }),
    // Whether this member's access is set per NODE on top of the role - the admin's
    // MODE choice, not a derived fact. Kept as a column because node rows cascade away:
    // "granular with nothing left ticked" must not read as Role mode.
    granular: boolean("granular").notNull().default(false),
    // This member's capability set is THEIR OWN: the member page saved something other
    // than what their role grants, so `syncMembersOfRole` leaves them alone.
    customCapabilities: boolean("custom_capabilities").notNull().default(false),
    // THIS PERSON's own arrangement of the topbar team switcher, not a team-wide one:
    // this row already IS the (user, team) junction the order is grained on.
    switcherPosition: integer("switcher_position"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("memberships_user_team_uq").on(t.userId, t.teamId)],
);

// membershipCapabilities - [Membership.capabilities](../../../types.ts) → junction.
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
