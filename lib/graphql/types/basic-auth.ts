import { builder } from "../builder";
import { VarAuthorRef } from "./env";
import {
  listBasicAuthUsers,
  addBasicAuthUser,
  updateBasicAuthUserPassword,
  removeBasicAuthUser,
  revealBasicAuthPassword,
  type BasicAuthUserDTO,
} from "@/lib/data/basic-auth";
import { rerouteApp } from "@/lib/deploy/build";

/* ------------------------------------------------------------------ */
/* Object type                                                         */
/* ------------------------------------------------------------------ */

// The password is never a FIELD — the username, its authorship and its
// timestamps are all that ride the object. Reading a password back is a separate,
// deliberate `revealBasicAuthPassword` call for one credential (see below).
const BasicAuthUserRef = builder
  .objectRef<BasicAuthUserDTO>("BasicAuthUser")
  .implement({
    description:
      "An HTTP Basic Auth credential that gates every domain of an app. The password is never a field — read one back with revealBasicAuthPassword.",
    fields: (t) => ({
      id: t.exposeID("id"),
      username: t.exposeString("username"),
      // Identity metadata, never a value. Null for credentials created before
      // authorship was tracked (migration 0045 does not backfill) or once the
      // author's account is deleted — the UI renders "—".
      createdBy: t.field({
        type: VarAuthorRef,
        nullable: true,
        description: "Who added the credential.",
        resolve: (u) => u.createdBy,
      }),
      updatedBy: t.field({
        type: VarAuthorRef,
        nullable: true,
        description: "Who last changed its password.",
        resolve: (u) => u.updatedBy,
      }),
      imported: t.exposeBoolean("imported", {
        description:
          "The credential was carried over from another platform verbatim, so it never went through Deplo's password rules. Shown as a warning next to the user.",
      }),
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
    authScopes: { capability: "manage_basic_auth" },
    description:
      "Add a basic-auth user to an app. The login is required on every one of " +
      "its domains within seconds — the routing is re-applied to the running " +
      "container, no redeploy needed.",
    args: {
      appId: t.arg.string({ required: true }),
      username: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
    },
    resolve: async (_r, { appId, username, password }) => {
      const user = await addBasicAuthUser(appId, username, password);
      await applyRouting(appId);
      return user;
    },
  }),
  updateBasicAuthUserPassword: t.field({
    type: BasicAuthUserRef,
    authScopes: { capability: "manage_basic_auth" },
    description:
      "Change a basic-auth user's password. The new password is live on every " +
      "domain of the app within seconds (the old one stops working).",
    args: {
      id: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, password }) => {
      const user = await updateBasicAuthUserPassword(id, password);
      await applyRouting(user.appId);
      return user;
    },
  }),
  revealBasicAuthPassword: t.field({
    type: "String",
    authScopes: { capability: "manage_basic_auth" },
    description:
      "Reveal one credential's password. A basic-auth login is handed to a " +
      "person, so whoever may change it may also read it back — otherwise the " +
      "only answer to “what is the password?” is to reset it and lock everyone " +
      "out. A mutation, not a query, so it is never cached or prefetched.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => revealBasicAuthPassword(id),
  }),
  removeBasicAuthUser: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_basic_auth" },
    description:
      "Remove a basic-auth user, so its login stops working within seconds. " +
      "Removing the last one drops the login prompt entirely. Returns true.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await applyRouting(await removeBasicAuthUser(id));
      return true;
    },
  }),
}));

/**
 * Push an app's current basic-auth credentials to its RUNNING container.
 */
async function applyRouting(appId: string): Promise<void> {
  try {
    await rerouteApp(appId);
  } catch (e) {
    // The row is already committed, so a failed reroute is NOT "the save failed": say
    // exactly what happened and how to retry, or the user is left believing a
    // credential is guarding an app that is still open (or that a deleted one is gone
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Saved, but applying it to the running app failed: ${msg}. ` +
        `Use Reload on the app to try again.`,
    );
  }
}
