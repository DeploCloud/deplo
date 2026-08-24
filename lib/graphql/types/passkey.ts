import { builder } from "../builder";
import {
  deletePasskey,
  finishPasskeyRegistration,
  listMyPasskeys,
  renamePasskey,
  startPasskeyRegistration,
  type PasskeyDTO,
} from "@/lib/data/passkeys";

/**
 * The CURRENT account's passkeys.
 *
 * `loggedIn` rather than capability-gated, like sessions and two-factor: a
 * credential belongs to a person, not to a team, and the data layer resolves the
 * owner itself. Nothing here names another user - an instance admin clearing a
 * lost device uses `resetUserPasskeys` on the members path.
 *
 * These fields are the ONLY way in: `/api/auth/passkey/*` is closed to the
 * network (`passkeyGate` in lib/auth/better-auth.ts), because the plugin's own
 * endpoints register a permanent credential on a session alone.
 *
 * Registration is TWO round trips because WebAuthn is: the browser needs a
 * challenge before it can talk to the authenticator, and the authenticator's
 * answer means nothing without the challenge it replies to. The options and the
 * response both cross as opaque `JSON` - deplo never reads either, it hands them
 * to the verifier, which is the only thing that can judge them.
 */

const PasskeyRef = builder.objectRef<PasskeyDTO>("Passkey").implement({
  description:
    "A WebAuthn credential on this account. Carries no key material: the public key and the credential id stay server-side.",
  fields: (t) => ({
    id: t.exposeString("id"),
    name: t.exposeString("name", {
      description: 'The label shown in the list, e.g. "Chrome on macOS".',
    }),
    createdAt: t.exposeString("createdAt", { nullable: true }),
    usableHere: t.exposeBoolean("usableHere", {
      description:
        "False for a credential minted for a different address of this panel: the browser will not offer it here, so the only thing to do with it is remove it.",
    }),
  }),
});

builder.queryFields((t) => ({
  myPasskeys: t.field({
    type: [PasskeyRef],
    authScopes: { loggedIn: true },
    description: "Passkeys registered on this account, newest first.",
    resolve: () => listMyPasskeys(),
  }),
}));

builder.mutationFields((t) => ({
  startPasskeyRegistration: t.field({
    type: "JSON",
    authScopes: { loggedIn: true },
    description:
      "Options for `navigator.credentials.create`. Requires the account password.",
    args: { password: t.arg.string({ required: true }) },
    resolve: (_r, { password }) => startPasskeyRegistration(password),
  }),
  finishPasskeyRegistration: t.field({
    type: PasskeyRef,
    authScopes: { loggedIn: true },
    description:
      "Register the credential the authenticator produced. No password: the challenge it answers was minted behind one.",
    args: {
      response: t.arg({ type: "JSON", required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: (_r, { response, name }) =>
      finishPasskeyRegistration({ response, name }),
  }),
  renamePasskey: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Relabel a passkey. A label is not a credential, so no password.",
    args: {
      id: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, name }) => {
      await renamePasskey({ id, name });
      return true;
    },
  }),
  deletePasskey: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Remove a passkey. Requires the account password, and refuses the last one while a team's two-factor policy rests on it.",
    args: {
      id: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
    },
    resolve: async (_r, { id, password }) => {
      await deletePasskey({ id, password });
      return true;
    },
  }),
}));
