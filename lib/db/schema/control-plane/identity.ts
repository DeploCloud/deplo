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

// users - [User](../../../types.ts).
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    username: text("username").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
    suspended: boolean("suspended").notNull().default(false),
    canExposePorts: boolean("can_expose_ports").notNull().default(false),
    canMountHostVolumes: boolean("can_mount_host_volumes")
      .notNull()
      .default(false),
    avatarColor: text("avatar_color").notNull(),
    // DEAD since 0055: sessions are Better Auth rows now, so revoking them is a
    // DELETE, not a version bump. The column survives one release so a rollback
    // still finds the schema it expects; dropping it is its own migration.
    tokenVersion: integer("token_version").notNull().default(0),
    // True when the account has a verified TOTP factor. Written ONLY by Better
    // Auth's twoFactor plugin; read by Deplo's policy gate (lib/membership.ts).
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    // Better Auth's `user` model requires these three. Deplo has no email verification
    // flow, so `email_verified` is true for everyone; `updated_at` exists to satisfy
    // the model.
    emailVerified: boolean("email_verified").notNull().default(true),
    image: text("image"),
    updatedAt: isoTimestamptz("updated_at")
      .notNull()
      .default(sql`now()`),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_username_uq").on(t.username),
  ],
);

// teams - [Team](../../../types.ts).
export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Derived from the name at creation and then FROZEN: it is what the API's
    // `X-Deplo-Team` header accepts instead of the id, so a rename would break
    // every caller already sending the old one.
    slug: text("slug").notNull(),
    plan: text("plan").notNull(),
    // The team's ABSOLUTE owner - the user who originally created the team (the
    // "crown").
    founderUserId: text("founder_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    // Team-wide 2FA policy: when true, a member without a verified TOTP factor resolves
    // NO capabilities in this team, over the UI and the bearer API alike
    // (lib/membership.ts).
    requireTwoFactor: boolean("require_two_factor").notNull().default(false),
    // Whether this team's API tokens may drive it over MCP (`/api/mcp`). Off ⇒ the
    // endpoint refuses the whole request, before any tool runs.
    mcpEnabled: boolean("mcp_enabled").notNull().default(true),
    // When the team's default backup destination was seeded (lib/data/destinations/create.ts
    // `ensureDefaultDestination`).
    backupDefaultSeededAt: isoTimestamptz("backup_default_seeded_at"),
    // The team's picture, shown before its name everywhere the team is named.
    image: text("image"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [uniqueIndex("teams_slug_uq").on(t.slug)],
);

// invites - [Invite](../../../types.ts). `status` is a soft lifecycle; a revoke never hard-deletes.
export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status").notNull(),
    invitedBy: text("invited_by").notNull(),
    expiresAt: isoTimestamptz("expires_at").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    acceptedAt: isoTimestamptz("accepted_at"),
  },
  (t) => [
    uniqueIndex("invites_token_hash_uq").on(t.tokenHash),
    uniqueIndex("invites_team_email_pending_uq")
      .on(t.teamId, t.email)
      .where(sql`${t.status} = 'pending'`),
  ],
);

// inviteCapabilities - [Invite.capabilities](../../../types.ts) → junction.
export const inviteCapabilities = pgTable(
  "invite_capabilities",
  {
    inviteId: text("invite_id")
      .notNull()
      .references(() => invites.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [primaryKey({ columns: [t.inviteId, t.capability] })],
);

// registrationLinks - [RegistrationLink](../../../types.ts).
export const registrationLinks = pgTable(
  "registration_links",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    // The same token, encrypted, so the admin can copy the link again instead of
    // minting a second one because they lost the first. NULL on links minted before
    // migration 0048 - those can only be revoked and re-minted.
    tokenEnc: text("token_enc"),
    status: text("status").notNull(),
    // How the registrant's team is decided: 'own_team' (they name + own a fresh team at
    // registration, the historical behavior) or 'existing_teams' (an admin pre-assigned
    // them to existing teams - see registration_link_teams).
    mode: text("mode").notNull().default("own_team"),
    createdBy: text("created_by").notNull(),
    usedByUsername: text("used_by_username"),
    expiresAt: isoTimestamptz("expires_at").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
    usedAt: isoTimestamptz("used_at"),
  },
  (t) => [uniqueIndex("registration_links_token_hash_uq").on(t.tokenHash)],
);

// registrationLinkTeams - the teams an `existing_teams` link pre-assigns its registrant to.
export const registrationLinkTeams = pgTable(
  "registration_link_teams",
  {
    id: text("id").primaryKey(),
    linkId: text("link_id")
      .notNull()
      .references(() => registrationLinks.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
  },
  (t) => [
    uniqueIndex("registration_link_teams_link_team_uq").on(t.linkId, t.teamId),
    index("registration_link_teams_link_idx").on(t.linkId),
  ],
);

// registrationLinkTeamCapabilities - [registrationLinkTeams.capabilities] → junction.
export const registrationLinkTeamCapabilities = pgTable(
  "registration_link_team_capabilities",
  {
    linkTeamId: text("link_team_id")
      .notNull()
      .references(() => registrationLinkTeams.id, { onDelete: "cascade" }),
    capability: text("capability").notNull(),
  },
  (t) => [primaryKey({ columns: [t.linkTeamId, t.capability] })],
);
