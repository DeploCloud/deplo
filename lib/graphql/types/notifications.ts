import { builder } from "../builder";
import {
  deleteNotificationChannel,
  getWebPushPublicKey,
  listNotificationChannels,
  saveNotificationChannel,
  sendTestNotification,
  subscribeWebPush,
  unsubscribeWebPush,
} from "@/lib/data/notifications";

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

/**
 * Channels are exposed as opaque `JSON`, deliberately and for the same reason
 * the settings object was: the instance shape follows the channel catalog, no
 * credential is ever in it (a stored one surfaces as a `…Set` bit with no read
 * path), and the settings UI reads and writes exactly this JSON.
 *
 * Every field is `loggedIn` with the real gate inside `lib/data/notifications.ts`
 * — the two-gate model, where the field contract is introspectable and the
 * boundary is the data layer.
 */
builder.queryFields((t) => ({
  notificationChannels: t.field({
    type: "JSON",
    authScopes: { loggedIn: true },
    description:
      "The active team's configured channels, each with its own subscribed alerts.",
    resolve: () => listNotificationChannels(),
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
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  saveNotificationChannel: t.field({
    type: "JSON",
    authScopes: { loggedIn: true },
    description:
      "Create a channel (omit id) or replace one. Returns the saved channel.",
    args: {
      id: t.arg.id({ required: false }),
      input: t.arg({ type: "JSON", required: true }),
    },
    // Opaque JSON on the wire, so ANYTHING can arrive: the data layer coerces it
    // field by field (`parseChannelInput`) rather than trusting the shape.
    resolve: (_r, { id, input }) =>
      saveNotificationChannel(id ? String(id) : null, input),
  }),
  deleteNotificationChannel: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description: "Remove a channel. Its subscribed alerts go with it.",
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }) => {
      await deleteNotificationChannel(String(id));
      return true;
    },
  }),
  testNotificationChannel: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Send a one-off test alert through one channel, using its saved config.",
    args: { id: t.arg.id({ required: true }) },
    resolve: async (_r, { id }) => {
      await sendTestNotification(String(id));
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
