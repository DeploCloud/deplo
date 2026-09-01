import { builder } from "../builder";
import {
  updateProfile,
  updateEmail,
  changePassword,
  updateMyAvatar,
} from "@/lib/data/account";

/* ------------------------------------------------------------------ */
/* Mutations (the current user's own profile)                          */
/*                                                                     */
/* No object type here: the viewer is already modelled elsewhere and   */
/* every account data fn returns void, so these mutations report       */
/* success with Boolean true. The data layer (assertUser + password    */
/* re-check) is the security boundary; `loggedIn` is the GraphQL gate. */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  updateProfile: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Update the current user's display name, and their handle when one is given. The handle is the instance-wide public username: lowercase letters, numbers, - and _, 3-32 characters, unique. Returns true.",
    args: {
      name: t.arg.string({ required: true }),
      username: t.arg.string({ required: false }),
    },
    resolve: async (_r, { name, username }) => {
      await updateProfile({ name, username: username ?? undefined });
      return true;
    },
  }),
  updateMyAvatar: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Set the current user's picture SOURCE: a base64 image data-URI (png/jpeg/webp, downscaled to 256x256 by the browser as a convenience - the size and grammar are enforced here), `pixelbot:<seed>` for a generated face, `gravatar`, or `initials` for the monogram. Null or empty clears the choice, which falls back to their Gravatar (when the instance allows it) and then to a face seeded with their id. Returns true.",
    args: { image: t.arg.string({ required: false }) },
    resolve: async (_r, { image }) => {
      await updateMyAvatar(image ?? null);
      return true;
    },
  }),
  updateEmail: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Change the current user's email after re-checking their password. Returns true.",
    args: {
      email: t.arg.string({ required: true }),
      currentPassword: t.arg.string({ required: true }),
    },
    resolve: async (_r, { email, currentPassword }) => {
      await updateEmail({ email, currentPassword });
      return true;
    },
  }),
  changePassword: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Change the current user's password after verifying the current one. Returns true.",
    args: {
      currentPassword: t.arg.string({ required: true }),
      newPassword: t.arg.string({ required: true }),
    },
    resolve: async (_r, { currentPassword, newPassword }) => {
      await changePassword({ currentPassword, newPassword });
      return true;
    },
  }),
}));
