import {
  pgTable,
  text,
  boolean,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { domains } from "./domains";
import { teams, users } from "./identity";
import { servers } from "./servers";

// A DNS provider account one person connected; its API token is theirs, encrypted with the secrets key.
export const dnsProviders = pgTable(
  "dns_providers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    zoneName: text("zone_name").notNull(),
    zoneId: text("zone_id").notNull(),
    accountId: text("account_id").notNull(),
    apiTokenEnc: text("api_token_enc").notNull(),
    // Every member of its teams may use it, not only the person who connected it.
    shared: boolean("shared").notNull().default(false),
    createdAt: isoTimestamptz("created_at").notNull(),
    updatedAt: isoTimestamptz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("dns_providers_user_zone_uq").on(t.userId, t.zoneName),
    index("dns_providers_zone_idx").on(t.zoneName),
  ],
);

export const dnsProviderTeams = pgTable(
  "dns_provider_teams",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => dnsProviders.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.teamId] }),
    index("dns_provider_teams_team_idx").on(t.teamId),
  ],
);

// One Cloudflare Tunnel per provider account and server; its connector runs beside that server's proxy.
export const dnsProviderTunnels = pgTable(
  "dns_provider_tunnels",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => dnsProviders.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    tunnelId: text("tunnel_id").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("dns_provider_tunnels_provider_server_uq").on(
      t.providerId,
      t.serverId,
    ),
  ],
);

// The record Deplo created for a domain, so removing or renaming the domain removes it too.
export const domainDnsRecords = pgTable(
  "domain_dns_records",
  {
    domainId: text("domain_id")
      .primaryKey()
      .references(() => domains.id, { onDelete: "cascade" }),
    providerId: text("provider_id")
      .notNull()
      .references(() => dnsProviders.id, { onDelete: "cascade" }),
    zoneId: text("zone_id").notNull(),
    recordId: text("record_id").notNull(),
    tunnelId: text("tunnel_id").references(() => dnsProviderTunnels.id, {
      onDelete: "set null",
    }),
    // Deplo made this record, so it may delete it; one that was already there is never touched.
    created: boolean("created").notNull().default(true),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("domain_dns_records_provider_idx").on(t.providerId),
    index("domain_dns_records_tunnel_idx").on(t.tunnelId),
  ],
);
