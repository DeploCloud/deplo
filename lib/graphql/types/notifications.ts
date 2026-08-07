import { builder } from "../builder";
import {
  getNotificationSettings,
  getWebPushPublicKey,
  sendTestNotification,
  subscribeWebPush,
  unsubscribeWebPush,
  updateNotificationSettings,
} from "@/lib/data/notifications";
import { ALL_CHANNELS } from "@/lib/types";
import type { NotificationChannel, NotificationSettings } from "@/lib/types";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

/**
 * Per-team notification configuration. The `channels` config map and the
 * `alerts` subscription list are both team-shaped and change with the catalog,
 * so they are exposed as opaque JSON scalars rather than re-modelled as a tower
 * of object types — the client reads/writes them as the same JSON the settings
 * UI does. No credential is ever in there: a stored secret surfaces as a
 * `…Set: boolean` and has no read path.
 */
const NotificationSettingsRef = builder
  .objectRef<NotificationSettings>("NotificationSettings")
  .implement({
    description:
      "Per-team notification channels, each with its own subscribed alerts.",
    fields: (t) => ({
      channels: t.field({
        type: "JSON",
        description:
          "Channel config map: enable flags + endpoints for all twelve channels.",
        resolve: (s) => s.channels,
      }),
      alerts: t.field({
        type: "JSON",
        description:
          "Per channel, the subscribed alert keys (deployment_failed, server_offline, …).",
        resolve: (s) => s.alerts,
      }),
    }),
  });

/* ------------------------------------------------------------------ */
/* Enums (local — not shared)                                          */
/* ------------------------------------------------------------------ */

// Every channel can be tested, browser push included: it goes to the caller's
// own devices, which is the only way to prove the subscription works. Read from
// `ALL_CHANNELS` so the enum cannot drift from the union.
const TestChannelEnum = builder.enumType("TestNotificationChannel", {
  values: ALL_CHANNELS,
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
  webPushPublicKey: t.field({
    type: "String",
    authScopes: { loggedIn: true },
    description:
      "This instance's VAPID public key, minted on first use. Public by design.",
    resolve: () => getWebPushPublicKey(),
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
    // Opaque JSON on the wire, so ANYTHING can arrive: the data layer coerces it
    // field by field (`parseSettingsInput`) rather than trusting the shape.
    resolve: (_r, { input }) => updateNotificationSettings(input),
  }),
  testNotification: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Send a one-off test alert through a single channel. Returns true.",
    args: { channel: t.arg({ type: TestChannelEnum, required: true }) },
    resolve: async (_r, { channel }) => {
      await sendTestNotification(channel as NotificationChannel);
      return true;
    },
  }),
  subscribeWebPush: t.field({
    type: "Boolean",
    // Deliberately NOT `manage_notifications`: opting your own browser in is
    // your own business, the same way revoking your own session is.
    authScopes: { loggedIn: true },
    description: "Register this browser for push alerts in the active team.",
    args: {
      endpoint: t.arg.string({ required: true }),
      p256dh: t.arg.string({ required: true }),
      auth: t.arg.string({ required: true }),
    },
    resolve: async (_r, args) => {
      await subscribeWebPush(args);
      return true;
    },
  }),
  unsubscribeWebPush: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description: "Forget this browser's push registration.",
    args: { endpoint: t.arg.string({ required: true }) },
    resolve: async (_r, { endpoint }) => {
      await unsubscribeWebPush(endpoint);
      return true;
    },
  }),
}));
