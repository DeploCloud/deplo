import * as z from "zod";
import { tool, type McpToolDef } from "./tool-def";

export const NOTIFICATIONS: McpToolDef[] = [
  tool({
    name: "list_notification_channels",
    title: "List notification channels",
    description:
      "Where this team is told about deploys and alerts: email, Slack, Discord, Telegram, webhooks. Credentials are masked.",
    group: "Notifications",
    requires: "manage_notifications",
    readOnly: true,
    idempotent: true,
    input: z.object({}),
    query: /* GraphQL */ `
      query McpNotificationChannels {
        notificationChannels
      }
    `,
  }),
  tool({
    name: "save_notification_channel",
    title: "Create or edit a notification channel",
    description:
      "Create a channel from its settings object (type, name, target, which events), or edit one by passing its id.",
    group: "Notifications",
    requires: "manage_notifications",
    input: z.object({
      id: z.string().optional(),
      input: z
        .record(z.string(), z.unknown())
        .describe(
          "The channel's settings, as list_notification_channels shows them.",
        ),
    }),
    query: /* GraphQL */ `
      mutation McpSaveNotificationChannel($id: ID, $input: JSON!) {
        saveNotificationChannel(id: $id, input: $input)
      }
    `,
  }),
  tool({
    name: "test_notification_channel",
    title: "Send a test notification",
    description: "Send a test message through one channel.",
    group: "Notifications",
    requires: "manage_notifications",
    idempotent: true,
    input: z.object({ id: z.string() }),
    query: /* GraphQL */ `
      mutation McpTestNotificationChannel($id: ID!) {
        testNotificationChannel(id: $id)
      }
    `,
  }),
  tool({
    name: "delete_notification_channel",
    title: "Delete a notification channel",
    description:
      "Remove a notification channel, so nothing is sent through it any more.",
    group: "Notifications",
    requires: "manage_notifications",
    destructive: true,
    input: z.object({ id: z.string() }),
    query: /* GraphQL */ `
      mutation McpDeleteNotificationChannel($id: ID!) {
        deleteNotificationChannel(id: $id)
      }
    `,
  }),
];
