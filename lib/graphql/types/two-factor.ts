import { builder } from "../builder";
import {
  confirmTwoFactorEnrolment,
  disableTwoFactor,
  regenerateRecoveryCodes,
  startTwoFactorEnrolment,
} from "@/lib/data/two-factor";

/**
 * Two-factor enrolment and teardown for the CURRENT account.
 */

const TwoFactorEnrolmentRef = builder
  .objectRef<{ totpUri: string; recoveryCodes: string[] }>("TwoFactorEnrolment")
  .implement({
    description:
      "A pending enrolment: the secret to scan and the codes to save. Two-factor is not on until `confirmTwoFactorEnrolment` succeeds.",
    fields: (t) => ({
      totpUri: t.exposeString("totpUri", {
        description: "The otpauth:// URI an authenticator app scans.",
      }),
      recoveryCodes: t.exposeStringList("recoveryCodes", {
        description: "Single-use codes, shown this once and never again.",
      }),
    }),
  });

builder.mutationFields((t) => ({
  startTwoFactorEnrolment: t.field({
    type: TwoFactorEnrolmentRef,
    authScopes: { loggedIn: true },
    description:
      "Mint a TOTP secret and recovery codes. Requires the account password. Refused when two-factor is already on.",
    args: { password: t.arg.string({ required: true }) },
    resolve: (_r, { password }) => startTwoFactorEnrolment(password),
  }),
  confirmTwoFactorEnrolment: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Finish enrolment with the first code from the authenticator app. Turns two-factor on.",
    args: { code: t.arg.string({ required: true }) },
    resolve: async (_r, { code }) => {
      await confirmTwoFactorEnrolment(code);
      return true;
    },
  }),
  disableTwoFactor: t.field({
    type: "Boolean",
    authScopes: { loggedIn: true },
    description:
      "Turn two-factor off. Requires the password AND a current code (a recovery code also works).",
    args: {
      password: t.arg.string({ required: true }),
      code: t.arg.string({ required: true }),
    },
    resolve: async (_r, { password, code }) => {
      await disableTwoFactor({ password, code });
      return true;
    },
  }),
  regenerateRecoveryCodes: t.field({
    type: ["String"],
    authScopes: { loggedIn: true },
    description:
      "Replace every recovery code with a fresh set, returned once. Requires the password AND a current code.",
    args: {
      password: t.arg.string({ required: true }),
      code: t.arg.string({ required: true }),
    },
    resolve: (_r, { password, code }) =>
      regenerateRecoveryCodes({ password, code }),
  }),
}));
