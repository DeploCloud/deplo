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
      "An HTTP Basic Auth credential that gates every domain of a project. The password is write-only and never returned.",
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
      "Basic-auth users of a project, alphabetical by username (requires manage_domains).",
    args: { projectId: t.arg.string({ required: true }) },
    resolve: (_r, { projectId }) => listBasicAuthUsers(projectId),
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
      "Add a basic-auth user to a project. Applies to all its domains on the next deploy or Reload.",
    args: {
      projectId: t.arg.string({ required: true }),
      username: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
    },
    resolve: (_r, { projectId, username, password }) =>
      addBasicAuthUser(projectId, username, password),
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
