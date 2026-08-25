import { builder } from "../builder";
import {
  listMySessions,
  revokeOtherSessions,
  revokeSession,
  type UserSessionDTO,
} from "@/lib/data/sessions";

/**
 * The signed-in devices of the CURRENT user.
 */

const DeviceKindEnum = builder.enumType("DeviceKind", {
  values: ["desktop", "mobile", "tablet", "unknown"] as const,
});

export const UserSessionRef = builder
  .objectRef<UserSessionDTO>("UserSession")
  .implement({
    description:
      "A browser or client currently signed in to the viewer's account. Carries no credential - a session is addressed by its id, never by its token.",
    fields: (t) => ({
      id: t.exposeID("id"),
      current: t.exposeBoolean("current", {
        description:
          "This is the session making the request. It cannot be revoked from here; sign out instead.",
      }),
      label: t.exposeString("label", {
        description: 'Human description, e.g. "Chrome on macOS".',
      }),
      device: t.field({ type: DeviceKindEnum, resolve: (s) => s.device }),
      ipAddress: t.exposeString("ipAddress", { nullable: true }),
      lastSeenAt: t.exposeString("lastSeenAt", {
        description:
          "When the session was last refreshed, which stands in for last used. Accurate to about 15 minutes.",
      }),
      createdAt: t.exposeString("createdAt"),
      expiresAt: t.exposeString("expiresAt"),
    }),
  });

builder.queryFields((t) => ({
  mySessions: t.field({
    type: [UserSessionRef],
    authScopes: { loggedIn: true },
    description:
      "Every device currently signed in to the viewer's account, most recently seen first.",
    resolve: () => listMySessions(),
  }),
}));

builder.mutationFields((t) => ({
  revokeSession: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Sign one device out. Refuses the viewer's own session - use `logout` for that. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await revokeSession(id);
      return true;
    },
  }),
  revokeOtherSessions: t.field({
    type: "Int",
    authScopes: { loggedIn: true },
    description:
      "Sign out every device except the one making the request, and return how many were ended.",
    resolve: () => revokeOtherSessions(),
  }),
}));
