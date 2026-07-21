import { builder } from "../builder";
import {
  listBasicAuthUsers,
  addBasicAuthUser,
  updateBasicAuthUserPassword,
  removeBasicAuthUser,
  type BasicAuthUserDTO,
} from "@/lib/data/basic-auth";
import { rerouteApp } from "@/lib/deploy/build";

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
    authScopes: { capability: "manage_domains" },
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
  removeBasicAuthUser: t.field({
    type: "Boolean",
    authScopes: { capability: "manage_domains" },
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
 *
 * The `basicauth` middleware is a Traefik LABEL, rendered from these rows at
 * deploy/reroute time and baked into the container — so every mutation above is
 * DB-only until the stack is re-rendered. Without this, adding a credential left
 * the app wide open (and deleting one left it locked) until someone happened to
 * redeploy or hit Reload: the UI listed a credential that was not actually
 * guarding anything. A security control that is only "saved" is not a control,
 * so the write and its application ship together.
 *
 * `rerouteApp` is the lightweight, label-only path (no build, no git, no env
 * regeneration): it recreates just the routed service in place, and Traefik picks
 * the new labels up a second or two later. It reports "unchanged" when the
 * rendered labels already match and "deferred" when the app isn't running — in
 * which case the credential still lands in the stack file, so it is in force the
 * moment the app next comes up (and nothing is being served in the meantime).
 *
 * Authorization is already settled: every mutation above gates on
 * `requireCapability("manage_domains")` + the app's team + its folder before
 * writing. Like `lib/graphql/types/domain.ts`, this deliberately calls the
 * deploy-engine primitive rather than `reloadApp`, whose own gate is `deploy` — a
 * member who may manage domains but not deploy must still be able to apply the
 * credential they just set.
 */
async function applyRouting(appId: string): Promise<void> {
  try {
    await rerouteApp(appId);
  } catch (e) {
    // The row is already committed, so a failed reroute is NOT "the save failed":
    // say exactly what happened and how to retry, or the user is left believing a
    // credential is guarding an app that is still open (or that a deleted one is
    // gone while the login still works).
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Saved, but applying it to the running app failed: ${msg}. ` +
        `Use Reload on the app to try again.`,
    );
  }
}
