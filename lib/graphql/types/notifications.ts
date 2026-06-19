import { builder } from "../builder";
import {
  getNotificationSettings,
  updateNotificationSettings,
  sendTestNotification,
} from "@/lib/data/notifications";
import type {
  NotificationChannel,
  NotificationSettings,
} from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

/**
 * Per-team notification configuration. The `channels` config map and the
 * `events` toggle map are both deeply nested, team-shaped objects, so they are
 * exposed as opaque JSON scalars rather than re-modelled as a tower of object
 * types — the client reads/writes them as the same JSON the settings UI does.
 */
const NotificationSettingsRef = builder
  .objectRef<NotificationSettings>("NotificationSettings")
  .implement({
    description: "Per-team notification channels + per-event delivery toggles.",
    fields: (t) => ({
      channels: t.field({
        type: "JSON",
        description:
          "Channel config map: push/email/discord/webhook enable flags + endpoints.",
        resolve: (s) => s.channels,
      }),
      events: t.field({
        type: "JSON",
        description:
          "Per-event delivery map (deployment_failed, server_offline, …) -> boolean.",
        resolve: (s) => s.events,
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Enums (local — not shared)                                          */
/* ------------------------------------------------------------------ */

// The data layer only delivers test alerts through the three outbound channels;
// browser push is delivered client-side and is excluded here.
const TestChannelEnum = builder.enumType("TestNotificationChannel", {
  values: ["email", "discord", "webhook"] as const,
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  notificationSettings: t.field({
    type: NotificationSettingsRef,
    authScopes: { loggedIn: true },
    description: "The active team's notification settings (defaults if unset).",
    resolve: () => getNotificationSettings(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations (every notifications server action)                        */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  saveNotificationSettings: t.field({
    type: NotificationSettingsRef,
    authScopes: { loggedIn: true },
    description: "Replace the active team's notification settings.",
    args: { input: t.arg({ type: "JSON", required: true }) },
    // The settings object is opaque JSON on the wire; the data layer validates
    // and persists the full shape. Cast it to the DTO it expects.
    resolve: (_r, { input }) =>
      updateNotificationSettings(input as NotificationSettings),
  }),
  testNotification: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Send a one-off test alert through a single channel. Returns true.",
    args: { channel: t.arg({ type: TestChannelEnum, required: true }) },
    resolve: async (_r, { channel }) => {
      await sendTestNotification(channel as Exclude<NotificationChannel, "push">);
      return true;
    },
  }),
}));
