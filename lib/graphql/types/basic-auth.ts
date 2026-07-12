import { builder } from "../builder";
import {
  listBasicAuthUsers,
  addBasicAuthUser,
  updateBasicAuthUserPassword,
  removeBasicAuthUser,
  type BasicAuthUserDTO,
} from "@/lib/data/basic-auth";

/* ------------------------------------------------------------------ */
/* Object type                                                         */
/* ------------------------------------------------------------------ */

// The password is never exposed — only the username + timestamps reach the
// client. Mutations take a plaintext password in; nothing sends one back.
const BasicAuthUserRef = builder
  .objectRef<BasicAuthUserDTO>("BasicAuthUser")
  .implement({
    description:
      "An HTTP Basic Auth credential that gates every domain of an app. The password is write-only and never returned.",
    fields: (t) => ({
      id: t.exposeID("id"),
      username: t.exposeString("username"),
      createdAt: t.exposeString("createdAt"),
      updatedAt: t.exposeString("updatedAt"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  basicAuthUsers: t.field({
    type: [BasicAuthUserRef],
    authScopes: { loggedIn: true },
    description:
      "Basic-auth users of an app, alphabetical by username (requires manage_domains).",
    args: { appId: t.arg.string({ required: true }) },
    resolve: (_r, { appId }) => listBasicAuthUsers(appId),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  addBasicAuthUser: t.field({
    type: BasicAuthUserRef,
    authScopes: { capability: "manage_domains" },
    description:
      "Add a basic-auth user to an app. Applies to all its domains on the next deploy or Reload.",
    args: {
      appId: t.arg.string({ required: true }),
      username: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
    },
    resolve: (_r, { appId, username, password }) =>
      addBasicAuthUser(appId, username, password),
  }),
  updateBasicAuthUserPassword: t.field({
    type: BasicAuthUserRef,
    authScopes: { capability: "manage_domains" },
    description: "Change a basic-auth user's password.",
    args: {
      id: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
    },
    resolve: (_r, { id, password }) =>
      updateBasicAuthUserPassword(id, password),
  }),
  removeBasicAuthUser: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_domains" },
    description: "Remove a basic-auth user. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await removeBasicAuthUser(id);
      return true;
    },
  }),
}));
