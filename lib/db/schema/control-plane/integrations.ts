import {
  pgTable,
  pgEnum,
  text,
  bigint,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { teams } from "./identity";

export const githubAccountType = pgEnum("github_account_type", [
  "User",
  "Organization",
]);

export const githubApps = pgTable(
  "github_apps",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    appId: bigint("app_id", { mode: "number" }).notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretEnc: text("client_secret_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc").notNull(),
    privateKeyEnc: text("private_key_enc").notNull(),
    htmlUrl: text("html_url").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("github_apps_app_id_uq").on(t.appId)],
);

export const githubInstallation = pgTable(
  "github_installation",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => githubApps.id, { onDelete: "cascade" }),
    installationId: bigint("installation_id", { mode: "number" }).notNull(),
    accountLogin: text("account_login").notNull(),
    accountType: githubAccountType("account_type").notNull(),
    avatarUrl: text("avatar_url").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("github_installation_installation_id_uq").on(t.installationId),
  ],
);

export const gitConnections = pgTable(
  "git_connections",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    baseUrl: text("base_url").notNull(),
    allowPrivateEndpoint: boolean("allow_private_endpoint")
      .notNull()
      .default(false),
    username: text("username").notNull(),
    tokenEnc: text("token_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc").notNull(),
    webhookToken: text("webhook_token").notNull(),
    accountLogin: text("account_login").notNull().default(""),
    avatarUrl: text("avatar_url").notNull().default(""),
    health: text("health").notNull().default("ok"),
    healthError: text("health_error").notNull().default(""),
    tokenExpiresAt: isoTimestamptz("token_expires_at"),
    tokenScopes: text("token_scopes").notNull().default(""),
    lastCheckedAt: isoTimestamptz("last_checked_at"),
    createdAt: isoTimestamptz("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("git_connections_webhook_token_uq").on(t.webhookToken),
    index("git_connections_team_idx").on(t.teamId),
  ],
);

export const registries = pgTable(
  "registries",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    registryUrl: text("registry_url").notNull(),
    username: text("username").notNull(),
    passwordEnc: text("password_enc").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("registries_team_created_idx").on(t.teamId, t.createdAt.desc()),
  ],
);

export const installedPlugins = pgTable(
  "installed_plugins",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    catalogId: text("catalog_id").notNull(),
    slug: text("slug").notNull(),
    version: text("version").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("installed_plugins_team_catalog_uq").on(t.teamId, t.catalogId),
    uniqueIndex("installed_plugins_slug_uq").on(t.slug),
    index("installed_plugins_team_created_idx").on(
      t.teamId,
      t.createdAt.desc(),
    ),
  ],
);
