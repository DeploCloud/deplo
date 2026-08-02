import { builder } from "../builder";
import {
  confirmTwoFactorEnrolment,
  disableTwoFactor,
  regenerateRecoveryCodes,
  startTwoFactorEnrolment,
} from "@/lib/data/two-factor";

/**
 * Two-factor enrolment and teardown for the CURRENT account.
 *
 * `loggedIn` rather than capability-gated, like sessions: a second factor
 * belongs to a person, not to a team, and the data layer resolves the owner
 * itself. There is no field here that names another user — an instance admin who
 * has to unstick somebody uses `resetUserTwoFactor` on the members path.
 *
 * These mutations are the ONLY way in: `/api/auth/two-factor/*` is closed to the
 * network so the password-only endpoints cannot be called around the code check
 * that lib/data/two-factor.ts performs.
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
