import { builder } from "../builder";
import { ViewerRef } from "./viewer";
import { z } from "zod";
import { headers } from "next/headers";
import {
  login,
  logout,
  completeSetup,
  createAccountWithTeam,
  createAccountWithTeams,
  startSessionFor,
} from "@/lib/auth";
import { getCurrentUser } from "@/lib/auth";
import {
  consumeRegistrationLink,
  getRegistrationLinkInfo,
  getRegistrationLinkAssignments,
} from "@/lib/data/members";
import { normalizeUsername, validateUsername } from "@/lib/username";
import { rateLimit } from "@/lib/security";

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
  .objectRef<{ viewer: Awaited<ReturnType<typeof getCurrentUser>> }>(
    "AuthPayload",
  )
  .implement({
    fields: (t) => ({
      viewer: t.field({
        type: ViewerRef,
        nullable: true,
        resolve: (p) => p.viewer,
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
      const limited = checkLimits([
        { key: `login:email:${email}`, limit: 8, windowMs: 60_000 },
        { key: "login:global", limit: 100, windowMs: 60_000 },
        { key: await clientKey("login"), limit: 30, windowMs: 60_000 },
      ]);
      if (limited) throw new Error(limited);
      const res = await login(email, parsed.data.password);
      if (!res.ok) throw new Error(res.error ?? "Invalid email or password");
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

      let userId: string;
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
        userId = res.user.id;
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
        userId = res.user.id;
        activeTeamId = res.team.id;
      }
      await startSessionFor(userId, activeTeamId);
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
