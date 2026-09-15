import {
  pgTable,
  text,
  boolean,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { isoTimestamptz } from "../columns";
import { apps } from "./apps";
import { teams, users } from "./identity";
import { folders, projects } from "./projects";

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    instanceAdmin: boolean("instance_admin").notNull().default(false),
    scoped: boolean("scoped").notNull().default(false),
    oauthClientId: text("oauth_client_id"),
    expiresAt: isoTimestamptz("expires_at"),
    lastUsedAt: isoTimestamptz("last_used_at"),
    mcpLastUsedAt: isoTimestamptz("mcp_last_used_at"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("api_tokens_token_hash_uq").on(t.tokenHash),
    uniqueIndex("api_tokens_oauth_client_user_uq")
      .on(t.oauthClientId, t.userId)
      .where(sql`${t.oauthClientId} is not null`),
  ],
);

export const apiTokenCapabilities = pgTable(
  "api_token_capabilities",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tokenId, t.capability] })],
);

export const apiTokenTeams = pgTable(
  "api_token_teams",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.teamId] }),
    index("api_token_teams_team_idx").on(t.teamId),
  ],
);

export const apiTokenProjects = pgTable(
  "api_token_projects",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.projectId] }),
    index("api_token_projects_project_idx").on(t.projectId),
  ],
);

export const apiTokenFolders = pgTable(
  "api_token_folders",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.folderId] }),
    index("api_token_folders_folder_idx").on(t.folderId),
  ],
);

export const apiTokenApps = pgTable(
  "api_token_apps",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tokenId, t.appId] }),
    index("api_token_apps_app_idx").on(t.appId),
  ],
);
