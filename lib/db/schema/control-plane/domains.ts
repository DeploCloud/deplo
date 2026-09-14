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
import { users } from "./identity";

// domains - [Domain](../../../types.ts).
export const domains = pgTable(
  "domains",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status").notNull(),
    isPrimary: boolean("is_primary").notNull(),
    redirectTo: text("redirect_to"),
    ssl: boolean("ssl").notNull(),
    source: text("source"),
    port: integer("port"),
    entrypoint: text("entrypoint"),
    certProvider: text("cert_provider"),
    pathPrefix: text("path_prefix"),
    stripPrefix: boolean("strip_prefix"),
    service: text("service"),
    // The user's own declaration that something else answers for this hostname
    // (a CDN, a reverse proxy), so its A records never point here and the DNS
    // check cannot settle it - see [Domain.proxied](../../types.ts).
    proxied: boolean("proxied"),
    // The hostname this row REPLACED on the platform it was imported from - set only
    // when the address actually changed (the source's own throwaway host, or a name
    // another team here already serves).
    importedFrom: text("imported_from"),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("domains_one_primary_uq")
      .on(t.appId)
      .where(sql`${t.isPrimary}`),
    uniqueIndex("domains_name_pathprefix_uq").on(
      t.name,
      sql`coalesce(${t.pathPrefix}, '')`,
    ),
    index("domains_app_idx").on(t.appId),
  ],
);

// domainMiddlewares - [Domain.middlewares](../../../types.ts) → ordered child.
export const domainMiddlewares = pgTable(
  "domain_middlewares",
  {
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.domainId, t.position] })],
);

// appBasicAuthUsers - [BasicAuthUser](../../../types.ts), a credential gating EVERY domain of a service.
export const appBasicAuthUsers = pgTable(
  "app_basic_auth_users",
  {
    id: text("id").primaryKey(),
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    username: text("username").notNull(),
    passwordEnc: text("password_enc").notNull(),
    // Carried over from another platform, unchanged and unvetted.
    imported: boolean("imported").notNull().default(false),
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
    uniqueIndex("app_basic_auth_users_app_username_uq").on(t.appId, t.username),
    index("app_basic_auth_users_app_idx").on(t.appId),
  ],
);
