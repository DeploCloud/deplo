import { builder } from "../builder";
import {
  updateProfile,
  updateEmail,
  changePassword,
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
    description: "Update the current user's display name. Returns true.",
    args: { name: t.arg.string({ required: true }) },
    resolve: async (_r, { name }) => {
      await updateProfile({ name });
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
