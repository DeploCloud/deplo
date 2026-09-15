import {
  pgTable,
  text,
  integer,
  boolean,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { teams, users } from "./identity";

export const notificationChannels = pgTable(
  "notification_channels",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    name: text("name").notNull().default(""),
    enabled: boolean("enabled").notNull().default(true),
    url: text("url").notNull().default(""),
    target: text("target").notNull().default(""),
    secretEnc: text("secret_enc").notNull().default(""),
    secret2Enc: text("secret2_enc").notNull().default(""),
    emailFrom: text("email_from").notNull().default(""),
    emailProvider: text("email_provider").notNull().default("resend"),
    smtpHost: text("smtp_host").notNull().default(""),
    smtpPort: integer("smtp_port").notNull().default(587),
    smtpUser: text("smtp_user").notNull().default(""),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    index("notification_channels_team_created_idx").on(t.teamId, t.createdAt),
  ],
);

export const notificationAlerts = pgTable(
  "notification_alerts",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => notificationChannels.id, { onDelete: "cascade" }),
    alertKey: text("alert_key").notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.alertKey] })],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: isoTimestamptz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.userId, t.endpoint] }),
    index("push_subscriptions_team_idx").on(t.teamId),
  ],
);
