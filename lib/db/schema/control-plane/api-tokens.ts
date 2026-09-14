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

// apiTokens - [ApiToken](../../../types.ts); it carries its own capabilities and is never root by construction.
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    // PERSONAL: the token belongs to this person and to no team. It reaches the
    // teams where they hold `manage_tokens`, live, and nobody else can see it.
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    // May administer the WHOLE INSTANCE (users, servers, global env), not just its
    // teams.
    instanceAdmin: boolean("instance_admin").notNull().default(false),
    // The INTENT to be scoped, stored separately from the junctions: a deleted project
    // or app cascades its scope row away, and without this flag an emptied scope would
    // read as "no scope" and silently WIDEN the token.
    scoped: boolean("scoped").notNull().default(false),
    // Set when this token was minted by approving an OAuth consent instead of by the
    // tokens page, and names the client that presented itself.
    oauthClientId: text("oauth_client_id"),
    // When this credential stops working. NULL is "never", which is what every token
    // minted before this column existed keeps.
    expiresAt: isoTimestamptz("expires_at"),
    lastUsedAt: isoTimestamptz("last_used_at"),
    // When this token last spoke MCP, as opposed to `last_used_at`, which rises on any
    // authenticated request (GraphQL, a deploy hook, a tool call alike). NULL is "never
    // spoke MCP", which is where every token starts and where a CI token stays forever.
    mcpLastUsedAt: isoTimestamptz("mcp_last_used_at"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("api_tokens_token_hash_uq").on(t.tokenHash),
    // One connection per (client, person): re-authorizing MOVES a connection
    // rather than leaving two the owner cannot tell apart.
    uniqueIndex("api_tokens_oauth_client_user_uq")
      .on(t.oauthClientId, t.userId)
      .where(sql`${t.oauthClientId} is not null`),
  ],
);

// apiTokenCapabilities - a token's own capabilities; `view` is stored explicitly so "no rows" has one meaning.
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

// apiTokenTeams - what a token may reach, by whole Team.
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

// apiTokenProjects - what a token may reach, by whole Project.
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

// apiTokenFolders - what a token may reach, by whole folder.
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

// apiTokenApps - what a token may reach, by single App.
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
