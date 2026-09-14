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

// githubAccountType - [GithubInstallation.accountType](../../../types.ts), GitHub's two account kinds.
export const githubAccountType = pgEnum("github_account_type", [
  "User",
  "Organization",
]);

// githubApps - [GithubApp](../../../types.ts); three secrets, `app_id` is the numeric GitHub App id.
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

// githubInstallation - [GithubInstallation](../../../types.ts); `installation_id` is the upsert conflict target.
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

// gitConnections - [GitConnection](../../../types.ts), a team's credentials for one git host that is not GitHub.
export const gitConnections = pgTable(
  "git_connections",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    // gitlab | bitbucket | gitea | git. Plain text, no CHECK: a value written by
    // a newer binary must round-trip through an older one rather than break the
    // row (same reasoning as apps.framework).
    provider: text("provider").notNull(),
    label: text("label").notNull(),
    // Origin of the host, no trailing slash: https://gitlab.com,
    // https://git.acme.com. Self-hosted GitLab/Gitea is the main reason this
    // column exists at all.
    baseUrl: text("base_url").notNull(),
    // Opt OUT of the SSRF guard on `base_url`, for a git server that lives on the
    // operator's own private network.
    allowPrivateEndpoint: boolean("allow_private_endpoint")
      .notNull()
      .default(false),
    // The userinfo half of the clone URL. Provider-dependent and NOT cosmetic:
    // GitLab wants "oauth2", Bitbucket "x-token-auth", Gitea the real username.
    username: text("username").notNull(),
    tokenEnc: text("token_enc").notNull(),
    webhookSecretEnc: text("webhook_secret_enc").notNull(),
    webhookToken: text("webhook_token").notNull(),
    accountLogin: text("account_login").notNull().default(""),
    avatarUrl: text("avatar_url").notNull().default(""),
    // "ok" | "failing". Never NULL: a connection is proven at creation time, so
    // there is no "unknown" state to represent.
    health: text("health").notNull().default("ok"),
    healthError: text("health_error").notNull().default(""),
    // Only when the provider tells us (GitLab does, Gitea does not).
    tokenExpiresAt: isoTimestamptz("token_expires_at"),
    // Space-separated scopes the provider reports for this token. Empty when it
    // reports none, which is NOT the same as "the token has none": a missing-access
    // warning is only ever raised from a non-empty value.
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

// registries - [Registry](../../../types.ts). `password_enc` is a secret.
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

// installedPlugins - [InstalledPlugin](../../../types.ts).
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
