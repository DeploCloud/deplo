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

/** Returns an error message when any limiter trips, else null. */
function checkLimits(
  checks: { key: string; limit: number; windowMs: number }[],
): string | null {
  let worst = 0;
  for (const c of checks) {
    const r = rateLimit(c.key, { limit: c.limit, windowMs: c.windowMs });
    if (!r.ok) worst = Math.max(worst, r.retryAfterSec);
  }
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
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
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
      const limited = checkLimits([
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
        noteFailedLogin(email);
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
      // Tighter than the password limiter: a 6-digit code is guessable in a way
      // a password is not, so cap attempts hard.
      //
      // TWO buckets, for the reason `login` above gives: an address-only limit
      // is no limit at all against an attacker who rotates addresses, and the
      // twoFactor plugin is configured with its defaults — it does NOT lock an
      // account out after repeated failures, so nothing else here counts. The
      // second bucket is the PENDING LOGIN itself, keyed on the cookie Better
      // Auth set when the password was accepted: it caps the attempts against
      // one challenge no matter how many addresses they arrive from, without
      // this resolver having to learn which account is behind it.
      const limited = checkLimits([
        { key: await clientKey("2fa"), limit: 5, windowMs: 15 * 60_000 },
        ...(await pendingLoginKey()),
      ]);
      if (limited) throw new Error(limited);
      const res = await verifyTwoFactorCode(
        code,
        args.recoveryCode ? "backup" : "totp",
      );
      if (!res.ok) {
        // No address in scope on this half of the flow, so the client key is the
        // subject: it is what the limiter above already counts by.
        noteFailedLogin(await clientKey("2fa"));
        throw new Error(res.error ?? "That code is not valid");
      }
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
      const limited = checkLimits([
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
      const limited =
        !rateLimit(`register:ip:${ip}`, { limit: 10, windowMs: 60_000 }).ok ||
        !rateLimit(`register:token:${parsed.data.token.slice(0, 12)}`, {
          limit: 8,
          windowMs: 60_000,
        }).ok;
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
