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
 * The CURRENT account's passkeys. Registration is TWO round trips because WebAuthn
 * is: the browser needs a challenge before it can talk to the authenticator, and
 * the authenticator's answer means nothing without the challenge it replies to.
 */

const PasskeyKindEnum = builder.enumType("PasskeyKind", {
  description:
    "What holds the credential, as the authenticator itself reported it - not as the person named it.",
  values: ["synced", "device", "securityKey"] as const,
});

const PasskeyRef = builder.objectRef<PasskeyDTO>("Passkey").implement({
  description:
    "A WebAuthn credential on this account. Carries no key material: the public key and the credential id stay server-side.",
  fields: (t) => ({
    id: t.exposeString("id"),
    name: t.exposeString("name", {
      description: 'The label shown in the list, e.g. "Chrome on macOS".',
    }),
    createdAt: t.exposeString("createdAt", { nullable: true }),
    kind: t.field({ type: PasskeyKindEnum, resolve: (p) => p.kind }),
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
