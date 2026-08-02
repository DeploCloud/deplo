import { builder } from "../builder";
import type { PublicUser } from "@/lib/types";

/**
 * The viewer: who the current request is authenticated as. Proves both auth
 * paths end to end — `me` returns the same shape whether the caller used a
 * session cookie (browser) or an `Authorization: Bearer deplo_…` token.
 */
export const ViewerRef = builder.objectRef<PublicUser>("Viewer").implement({
  description: "The authenticated principal for the current request.",
  fields: (t) => ({
    id: t.exposeID("id"),
    email: t.exposeString("email"),
    username: t.exposeString("username"),
    name: t.exposeString("name"),
    role: t.exposeString("role"),
    isInstanceAdmin: t.exposeBoolean("isInstanceAdmin"),
    avatarColor: t.exposeString("avatarColor"),
    twoFactorEnabled: t.exposeBoolean("twoFactorEnabled", {
      description:
        "Whether this account has a verified second factor. Says only that one exists, never anything about it.",
    }),
  }),
});

builder.queryFields((t) => ({
  me: t.field({
    type: ViewerRef,
    nullable: true,
    description:
      "The authenticated viewer, or null when unauthenticated. Works with a session cookie or an API token.",
    resolve: (_root, _args, ctx) => ctx.viewer,
  }),
  apiContext: t.field({
    type: "JSON",
    description:
      "Diagnostic: how the request authenticated and the active team. Useful when testing token auth.",
    resolve: (_root, _args, ctx) => ({
      via: ctx.via,
      teamId: ctx.teamId,
      capabilities: ctx.capabilities,
    }),
  }),
}));
