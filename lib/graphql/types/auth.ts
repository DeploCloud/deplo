import { GraphQLError } from "graphql";

import { builder } from "../builder";
import { ViewerRef } from "./viewer";
import { z } from "zod";
import { cookies, headers } from "next/headers";
import {
  createAccountWithTeam,
  createAccountWithTeams,
} from "@/lib/auth/create-account";
import { completeSetup } from "@/lib/auth/setup";
import {
  login,
  logout,
  emailForIdentifier,
  startSessionFor,
  verifyTwoFactorCode,
  passkeyChallenge,
  verifyPasskeyLogin,
} from "@/lib/auth/sign-in";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  consumeRegistrationLink,
  getRegistrationLinkInfo,
  getRegistrationLinkAssignments,
} from "@/lib/data/members/registration-redeem";
import {
  normalizeUsername,
  USERNAME_MAX,
  USERNAME_MIN,
  validateUsername,
} from "@/lib/username";
import { MAX_AVATAR_STRING_LEN } from "@/lib/apps/avatar-shared";
import { rateLimit } from "@/lib/security";
import { noteFailedLogin } from "@/lib/notify/security";
import { sha256Hex } from "@/lib/crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { verification } from "@/lib/db/schema/auth";
import { users } from "@/lib/db/schema/control-plane/identity";

async function clientKey(scope: string): Promise<string> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "local";
  return `${scope}:${ip}`;
}

async function pendingLoginKey(): Promise<
  { key: string; limit: number; windowMs: number }[]
> {
  const store = await cookies();
  const pending = store
    .getAll()
    .find((c) => c.name.endsWith("two_factor") && c.value);
  return pending
    ? [
        {
          key: `2fa-attempt:${sha256Hex(pending.value).slice(0, 32)}`,
          limit: 5,
          windowMs: 15 * 60_000,
        },
      ]
    : [];
}

async function pendingLoginEmail(): Promise<string | null> {
  const store = await cookies();
  const pending = store
    .getAll()
    .find((c) => c.name.endsWith("two_factor") && c.value);
  if (!pending) return null;
  const identifier = pending.value.split(".")[0];
  if (!identifier) return null;
  const rows = await getDb()
    .select({ email: users.email })
    .from(verification)
    .innerJoin(users, eq(users.id, verification.value))
    .where(eq(verification.identifier, identifier))
    .limit(1);
  return rows[0]?.email ?? null;
}

// Every bucket counts on every attempt - an `||` chain short-circuited and left one uncounted.
async function checkLimits(
  checks: { key: string; limit: number; windowMs: number }[],
): Promise<string | null> {
  const results = await Promise.all(
    checks.map((c) =>
      rateLimit(c.key, { limit: c.limit, windowMs: c.windowMs }),
    ),
  );
  const worst = results.reduce(
    (w, r) => (r.ok ? w : Math.max(w, r.retryAfterSec)),
    0,
  );
  return worst > 0 ? `Too many attempts. Try again in ${worst}s.` : null;
}

const AuthPayloadRef = builder
  .objectRef<{
    viewer: Awaited<ReturnType<typeof getCurrentUser>>;
    requiresTwoFactor?: boolean;
  }>("AuthPayload")
  .implement({
    fields: (t) => ({
      viewer: t.field({
        type: ViewerRef,
        nullable: true,
        resolve: (p) => p.viewer,
      }),
      requiresTwoFactor: t.boolean({
        description:
          "The password was correct but the account has 2FA: no session yet. Send a code to `verifyTwoFactorLogin`.",
        resolve: (p) => p.requiresTwoFactor ?? false,
      }),
    }),
  });

const loginSchema = z.object({
  email: z.string().trim().min(1, "Enter your email or username"),
  password: z.string().min(1, "Password is required"),
});

const setupSchema = z.object({
  username: z
    .string()
    .min(USERNAME_MIN, "Username is too short")
    .max(USERNAME_MAX)
    .nullish(),
  teamName: z.string().min(1, "Team name is required").max(80),
  name: z.string().trim().min(1, "Your name is required").max(80),
  email: z.string().email("Enter a valid email"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200),
  image: z.string().max(MAX_AVATAR_STRING_LEN).nullish(),
  teamImage: z.string().max(MAX_AVATAR_STRING_LEN).nullish(),
  key: z.string().max(200).nullish(),
});

const registerSchema = z.object({
  token: z.string().min(8).max(200),
  username: z.string().min(USERNAME_MIN).max(USERNAME_MAX),
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  teamName: z.string().min(1).max(80).nullish(),
  image: z.string().max(MAX_AVATAR_STRING_LEN).nullish(),
  teamImage: z.string().max(MAX_AVATAR_STRING_LEN).nullish(),
});

builder.mutationFields((t) => ({
  login: t.field({
    type: AuthPayloadRef,
    description: "Sign in with email + password. Sets the session cookie.",
    args: {
      email: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
    },
    resolve: async (_r, args) => {
      const parsed = loginSchema.safeParse(args);
      if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
      const email = await emailForIdentifier(parsed.data.email);
      // Per-account AND per-client, never one global counter: that one locks every user out.
      const limited = await checkLimits([
        { key: `login:email:${email}`, limit: 8, windowMs: 60_000 },
        { key: await clientKey("login"), limit: 30, windowMs: 60_000 },
      ]);
      if (limited) throw new Error(limited);
      const res = await login(email, parsed.data.password);
      if (res.requiresTwoFactor)
        return { viewer: null, requiresTwoFactor: true };
      if (!res.ok) {
        void noteFailedLogin(email);
        throw new Error(res.error ?? "Invalid email or password");
      }
      return { viewer: await getCurrentUser() };
    },
  }),
  verifyTwoFactorLogin: t.field({
    type: AuthPayloadRef,
    description:
      "Finish a login that returned `requiresTwoFactor`, with a TOTP code or a recovery code.",
    args: {
      code: t.arg.string({ required: true }),
      recoveryCode: t.arg.boolean({ required: false }),
    },
    resolve: async (_r, args) => {
      const code = args.code.trim();
      if (!code) throw new Error("Enter the code from your authenticator app");
      const who = await pendingLoginEmail();
      const limited = await checkLimits([
        { key: await clientKey("2fa"), limit: 5, windowMs: 15 * 60_000 },
        ...(await pendingLoginKey()),
        ...(who
          ? [
              {
                key: `2fa-account:${sha256Hex(who)}`,
                limit: 10,
                windowMs: 60 * 60_000,
              },
            ]
          : []),
      ]);
      if (limited) throw new Error(limited);
      const res = await verifyTwoFactorCode(
        code,
        args.recoveryCode ? "backup" : "totp",
      );
      if (!res.ok) {
        if (who) void noteFailedLogin(who);
        throw new Error(res.error ?? "That code is not valid");
      }
      return { viewer: await getCurrentUser() };
    },
  }),
  passkeyChallenge: t.field({
    type: "JSON",
    description:
      "Options for `navigator.credentials.get`. Public: this is the START of a sign-in, so there is no session yet.",
    resolve: async () => {
      const limited = await checkLimits([
        { key: await clientKey("passkey"), limit: 20, windowMs: 60_000 },
      ]);
      if (limited) throw new Error(limited);
      return passkeyChallenge();
    },
  }),
  verifyPasskeyLogin: t.field({
    type: AuthPayloadRef,
    description:
      "Finish a passkey sign-in with what the authenticator produced. Sets the session cookie.",
    args: { response: t.arg({ type: "JSON", required: true }) },
    resolve: async (_r, { response }) => {
      const limited = await checkLimits([
        {
          key: await clientKey("passkey-verify"),
          limit: 10,
          windowMs: 15 * 60_000,
        },
      ]);
      if (limited) throw new Error(limited);
      const res = await verifyPasskeyLogin(response);
      if (!res.ok) throw new Error(res.error ?? "That passkey did not work");
      return { viewer: await getCurrentUser() };
    },
  }),
  completeSetup: t.field({
    type: AuthPayloadRef,
    description: "First-run setup: create the first account + team. Signs in.",
    args: {
      username: t.arg.string(),
      teamName: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
      email: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
      image: t.arg.string(),
      teamImage: t.arg.string(),
      key: t.arg.string(),
    },
    resolve: async (_r, args) => {
      const parsed = setupSchema.safeParse(args);
      if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message ?? "Invalid input");
      const limited = await checkLimits([
        { key: "setup:global", limit: 10, windowMs: 60_000 },
      ]);
      if (limited) throw new Error(limited);
      const res = await completeSetup(parsed.data);
      if (!res.ok)
        throw new GraphQLError(res.error ?? "Setup failed", {
          extensions: res.field ? { field: res.field } : undefined,
        });
      return { viewer: await getCurrentUser() };
    },
  }),
  registerThroughLink: t.field({
    type: AuthPayloadRef,
    description:
      "Create a new account + team via a single-use registration link. Signs in.",
    args: {
      token: t.arg.string({ required: true }),
      username: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
      email: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
      teamName: t.arg.string({ required: false }),
      image: t.arg.string(),
      teamImage: t.arg.string(),
    },
    resolve: async (_r, args) => {
      const parsed = registerSchema.safeParse(args);
      if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message ?? "Invalid");
      const h = await headers();
      const ip =
        h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        h.get("x-real-ip") ||
        "local";
      const limited = await checkLimits([
        { key: `register:ip:${ip}`, limit: 10, windowMs: 60_000 },
        {
          key: `register:token:${parsed.data.token.slice(0, 12)}`,
          limit: 8,
          windowMs: 60_000,
        },
      ]);
      if (limited) throw new Error("Too many attempts. Try again shortly.");

      const username = normalizeUsername(parsed.data.username);
      const usernameError = validateUsername(username);
      if (usernameError) throw new Error(usernameError);

      // Team handling follows the link's stored mode, never anything the client sent.
      const info = await getRegistrationLinkInfo(parsed.data.token);
      if (!info.valid)
        throw new Error("This registration link is no longer valid");
      const guard = (tx: Parameters<typeof consumeRegistrationLink>[0]) =>
        consumeRegistrationLink(tx, parsed.data.token, username);

      let activeTeamId: string;
      if (info.mode === "existing_teams") {
        const assignments = await getRegistrationLinkAssignments(
          parsed.data.token,
        );
        const res = await createAccountWithTeams(
          {
            username,
            name: parsed.data.name,
            email: parsed.data.email,
            password: parsed.data.password,
            image: parsed.data.image,
          },
          assignments,
          { guard },
        );
        activeTeamId = res.activeTeamId;
      } else {
        const teamName = parsed.data.teamName?.trim();
        if (!teamName) throw new Error("A team name is required");
        const res = await createAccountWithTeam(
          {
            username,
            name: parsed.data.name,
            email: parsed.data.email,
            password: parsed.data.password,
            teamName,
            image: parsed.data.image,
            teamImage: parsed.data.teamImage,
          },
          { guard },
        );
        activeTeamId = res.team.id;
      }
      await startSessionFor(
        parsed.data.email,
        parsed.data.password,
        activeTeamId,
      );
      return { viewer: await getCurrentUser() };
    },
  }),
  logout: t.field({
    type: "Boolean",
    description: "Clear the session + active-team cookies.",
    resolve: async () => {
      await logout();
      return true;
    },
  }),
}));
