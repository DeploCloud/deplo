import { builder } from "../builder";
import { ViewerRef } from "./viewer";
import { z } from "zod";
import { cookies, headers } from "next/headers";
import {
  login,
  logout,
  completeSetup,
  createAccountWithTeam,
  createAccountWithTeams,
  startSessionFor,
  verifyTwoFactorCode,
  passkeyChallenge,
  verifyPasskeyLogin,
} from "@/lib/auth";
import { getCurrentUser } from "@/lib/auth";
import {
  consumeRegistrationLink,
  getRegistrationLinkInfo,
  getRegistrationLinkAssignments,
} from "@/lib/data/members";
import { normalizeUsername, validateUsername } from "@/lib/username";
import { rateLimit } from "@/lib/security";
import { noteFailedLogin } from "@/lib/notify/security";
import { sha256Hex } from "@/lib/crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { verification } from "@/lib/db/schema/auth";
import { users } from "@/lib/db/schema/control-plane";

/**
 * Authentication mutations. These are PUBLIC (no auth scope) and run in the
 * route handler, which has cookie write access — so `login`/`completeSetup`/
 * `logout` set the session cookie exactly as the old server actions did. The
 * rate-limiting that lived in lib/actions/auth.ts is preserved here verbatim
 * (the actions' security contract must not regress when they become mutations).
 *
 * Redirects: the old actions called `redirect()`; a mutation cannot redirect, so
 * each returns a payload and the client navigates (router.push) on success.
 */

/** Best-effort client IP — a secondary, spoofable limiter dimension only. */
async function clientKey(scope: string): Promise<string> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "local";
  return `${scope}:${ip}`;
}

/**
 * A limiter bucket for the LOGIN ATTEMPT a two-factor challenge belongs to.
 *
 * Better Auth sets a `two_factor` cookie (under deplo's `cookiePrefix`) once the
 * password half succeeds, so its value names this one pending login. Hashed,
 * because a limiter key ends up in memory next to a token that is still live.
 * Empty when the cookie is absent — there is no challenge to bound, and the
 * verification is about to fail on its own.
 */
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

/**
 * The address behind the two-factor challenge in flight, or null.
 *
 * The 2FA half of a login carries no address of its own, and counting the burst
 * against the CLIENT KEY instead made the alert unreachable twice over: the
 * resolver's own limiter trips one attempt below the burst threshold, and a key
 * that names nobody resolves to no team, so nothing would be told anyway. The
 * `two_factor` cookie names a `verification` row whose value is the user id
 * Better Auth is waiting on, which is the account actually under attack.
 */
async function pendingLoginEmail(): Promise<string | null> {
  const store = await cookies();
  const pending = store
    .getAll()
    .find((c) => c.name.endsWith("two_factor") && c.value);
  if (!pending) return null;
  // A Better Auth signed cookie is `<identifier>.<signature>`, and the
  // identifier it mints (`2fa-<random>`) never contains a dot.
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

/**
 * Returns an error message when any limiter trips, else null.
 *
 * Every check is counted even once one has already failed: they are separate
 * buckets (the address, the client, the pending login) and skipping the rest
 * after the first refusal would let an attacker keep one of them under its
 * limit for free.
 */
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
  email: z.string().email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

const setupSchema = z.object({
  username: z.string().min(3, "Username is required").max(32),
  teamName: z.string().min(1, "Workspace name is required").max(80),
  name: z.string().trim().min(1, "Your name is required").max(80),
  email: z.string().email("Enter a valid email"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(200),
});

const registerSchema = z.object({
  token: z.string().min(8).max(200),
  username: z.string().min(3).max(32),
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  // Optional: only own_team links collect a team name. existing_teams links
  // pre-assign teams, so the registrant never names one and the form sends an
  // explicit `null` (a nullable GraphQL arg). `.nullish()` accepts that null —
  // `.optional()` alone rejects it ("expected string, received null") and blew
  // up existing_teams registration. The team(s) come from the link, not the
  // client, so the value is ignored downstream regardless.
  teamName: z.string().min(1).max(80).nullish(),
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
      const email = parsed.data.email.toLowerCase().trim();
      // No global bucket: a shared fixed-window counter lets an anonymous
      // attacker exhaust it and lock every user out. Limiting is per-email and
      // per-client-IP only.
      const limited = await checkLimits([
        { key: `login:email:${email}`, limit: 8, windowMs: 60_000 },
        { key: await clientKey("login"), limit: 30, windowMs: 60_000 },
      ]);
      if (limited) throw new Error(limited);
      const res = await login(email, parsed.data.password);
      // 2FA is not an error: the password was right, the login is just not
      // finished. Returning a payload (rather than throwing) is what lets the
      // client swap to the code step without treating it as a failed attempt.
      if (res.requiresTwoFactor)
        return { viewer: null, requiresTwoFactor: true };
      if (!res.ok) {
        // Counted here rather than in `lib/auth.ts`: this resolver has the
        // normalised address in scope and already knows a credential rejection
        // from a rate-limit one.
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
      // One mutation, not two: the user pastes whatever they have, and the form
      // says which kind it is. Splitting them would leak nothing extra and would
      // double the public surface.
      recoveryCode: t.arg.boolean({ required: false }),
    },
    resolve: async (_r, args) => {
      const code = args.code.trim();
      if (!code) throw new Error("Enter the code from your authenticator app");
      // The ACCOUNT this challenge belongs to, resolved once: it is both the
      // limiter bucket below and the address the failure notice goes to.
      const who = await pendingLoginEmail();
      // Tighter than the password limiter: a 6-digit code is guessable in a way
      // a password is not, so cap attempts hard.
      //
      // THREE buckets, and only the third actually bounds the search. The
      // address is spoofable (see clientKey). The pending LOGIN is keyed on the
      // cookie Better Auth set when the password was accepted, so it resets the
      // moment the attacker throws the cookie away and re-sends the password —
      // at 8 logins per minute per email that is 40 codes a minute, ~57,600 a
      // day against a space of a million, which is a few percent per day for
      // anyone who already has the password. The twoFactor plugin is configured
      // with its defaults and does NOT lock an account out, so nothing else
      // counts. The ACCOUNT bucket is what survives a re-issued challenge: ten
      // wrong codes an hour is far past a fat-fingered authenticator (or a clock
      // that has drifted) and far below anything that gets anywhere.
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
        // Counted against the ACCOUNT the challenge belongs to, so a burst of
        // wrong codes lands in the same bucket as a burst of wrong passwords and
        // reaches that account's teams. A challenge whose cookie no longer
        // resolves has nobody to warn.
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
      // One bucket, on the client. There is nothing else to key on - the whole
      // point of a discoverable credential is that no account is named until the
      // browser answers - and a challenge is cheap to mint, so the limit is
      // there to stop a flood of `verification` rows, not to protect a secret.
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
      // Looser than the 2FA limiter and with no per-account bucket, both on
      // purpose: an assertion is a signature over a server-chosen challenge, not
      // six digits, so there is nothing to guess - the limit exists to cap the
      // verification work. And nothing names an account until the credential
      // resolves, which is also why no failed-login notice is sent from here:
      // there is no address to warn.
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
      username: t.arg.string({ required: true }),
      teamName: t.arg.string({ required: true }),
      name: t.arg.string({ required: true }),
      email: t.arg.string({ required: true }),
      password: t.arg.string({ required: true }),
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
      if (!res.ok) throw new Error(res.error ?? "Setup failed");
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
      // Optional: only collected/required for own_team links (see resolver).
      teamName: t.arg.string({ required: false }),
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
      // Through `checkLimits` rather than two inline calls, so both buckets are
      // always counted: the `||` short-circuited, which left the token bucket
      // un-incremented whenever the address bucket refused first.
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

      // The team handling is dictated by the link's stored mode — NEVER the
      // client. The token is consumed INSIDE the same atomic db.transaction that
      // creates the account (via the guard), closing the check-create-consume
      // TOCTOU: the conditional UPDATE matches the pending link exactly once.
      const info = await getRegistrationLinkInfo(parsed.data.token);
      if (!info.valid)
        throw new Error("This registration link is no longer valid");
      const guard = (tx: Parameters<typeof consumeRegistrationLink>[0]) =>
        consumeRegistrationLink(tx, parsed.data.token, username);

      let activeTeamId: string;
      if (info.mode === "existing_teams") {
        // Team(s) come from the link; any submitted teamName is ignored.
        const assignments = await getRegistrationLinkAssignments(
          parsed.data.token,
        );
        const res = await createAccountWithTeams(
          {
            username,
            name: parsed.data.name,
            email: parsed.data.email,
            password: parsed.data.password,
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
