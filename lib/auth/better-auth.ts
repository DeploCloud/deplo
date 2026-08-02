import "server-only";

import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { getDb, hasTestDb, type DrizzleClient } from "@/lib/db/client";
import { isPostgresEnabled } from "@/lib/db/pg";
import { schema } from "@/lib/db/schema";
import { deriveKey, hashPassword, verifyPassword } from "@/lib/crypto";
import { newId } from "@/lib/ids";

/**
 * Better Auth configuration — the LIVE login path since ADR-0014.
 *
 * Three things here are load-bearing and easy to break:
 *
 *  1. **`user: { modelName: "users" }`.** Better Auth's `user` model is the
 *     control-plane `users` table, not a second user table. Every FK in the
 *     control plane already points at `users.id`, so remapping is what makes this
 *     a config change instead of a data migration. The adapter resolves a model to
 *     `schema[modelName]`, which is why `lib/db/schema.ts` must keep exposing the
 *     table under the key `users`.
 *
 *  2. **`password: { hash, verify }`.** Wired to deplo's own scrypt pair, so every
 *     `scrypt$salt$hash` written before the migration still verifies and nobody
 *     had to reset a password. Change this and you invalidate every credential.
 *
 *  3. **`disableSignUp: true`.** `users` has NOT NULL columns Better Auth knows
 *     nothing about (`username`, `role`, `avatar_color`), so it must never INSERT
 *     there. Accounts are created by `createAccountWithTeam` (lib/auth.ts), which
 *     writes the matching `account` row itself.
 *
 * `nextCookies()` lets `auth.api.*` write cookies through `next/headers`, which is
 * what the GraphQL auth resolvers need — they run inside a route handler. The
 * secret is DERIVED from `DEPLO_SECRET` rather than being it, so the TOTP secrets
 * the twoFactor plugin encrypts are not sealed under the same key as `*_enc`.
 *
 * `getAuth()` returns null only in the test-only in-memory mode (no
 * `DEPLO_DATABASE_URL`), where there is no database to back the auth tables.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** The session cookie's base name. Better Auth prefixes `__Secure-` when secure. */
export const SESSION_COOKIE_NAME = "deplo.session_token";

/** Not named `use*`: it is a plain predicate, and the prefix reads as a React hook. */
function secureCookies(): boolean {
  return (process.env.DEPLO_PUBLIC_URL ?? "").startsWith("https://");
}

/** Both names the session cookie can have, in the order a reader should try them. */
export function sessionCookieNames(): [string, string] {
  return [SESSION_COOKIE_NAME, `__Secure-${SESSION_COOKIE_NAME}`];
}

/**
 * Refuse every `/two-factor/*` endpoint that arrived over HTTP.
 *
 * The plugin gates enrol / disable / regenerate on the PASSWORD alone, which is
 * one factor short of the bar the account itself set: whoever holds a stolen
 * session plus a phished password can turn 2FA off, or call `/two-factor/enable`
 * (which deletes the existing secret and mints a new one) and walk away owning
 * the second factor. `generate-backup-codes` is the quiet one — 2FA stays lit
 * while the attacker leaves with ten durable bypass credentials.
 *
 * So the endpoints are closed to the network and reachable only from
 * `lib/data/two-factor.ts`, which verifies a TOTP or recovery code first. The
 * discriminator is `ctx.request`: better-call's router puts the incoming
 * `Request` on the context (better-call/dist/router.mjs), while a direct
 * `auth.api.*({ body, headers })` call leaves it undefined. A browser cannot
 * manufacture the second shape — reaching it requires already executing in the
 * control plane, at which point 2FA is not what is protecting anything.
 *
 * Login-time verification does not go through here either: it is
 * `verifyTwoFactorCode` in lib/auth.ts, also an in-process call.
 */
const twoFactorGate = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith("/two-factor/") || !ctx.request) return;
  throw new APIError("FORBIDDEN", {
    message:
      "Two-factor settings are changed through deplo, which asks for a code first.",
    code: "TWO_FACTOR_STEP_UP_REQUIRED",
  });
});

function createAuth(db: DrizzleClient) {
  return betterAuth({
    appName: "Deplo",
    secret: deriveKey("better-auth").toString("hex"),
    baseURL: process.env.DEPLO_PUBLIC_URL || undefined,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    user: { modelName: "users" },
    emailAndPassword: {
      enabled: true,
      // Accounts are created via first-run setup / registration links only —
      // never through the public /api/auth/sign-up/email endpoint.
      disableSignUp: true,
      minPasswordLength: 8,
      password: {
        hash: async (password) => hashPassword(password),
        verify: async ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      // Every refresh rewrites `session.updated_at`, which is the ONLY thing the
      // signed-in-devices list can call "last seen". At the default of a day,
      // a device used a minute ago can read "23 hours ago", so the column lies
      // in the exact situation it exists for: deciding whether a session is
      // yours. Fifteen minutes costs one UPDATE per session per quarter hour
      // and makes the number mean what the label says.
      updateAge: 60 * 15,
    },
    advanced: {
      // Cookies are Secure when the instance is actually served over HTTPS.
      useSecureCookies: secureCookies(),
      cookiePrefix: "deplo",
      database: { generateId: () => newId("bas") },
      ipAddress: {
        // Better Auth defaults to `x-forwarded-for` alone, and — this is the
        // part that bites — it REFUSES a forwarded chain with more than one hop
        // unless `trustedProxies` is configured, returning no address at all.
        //
        // A deplo instance is typically Cloudflare -> Traefik -> app, where
        // Traefik appends Cloudflare's edge address and makes that chain two
        // hops long. So the single-valued headers are listed FIRST: they carry
        // the client address unambiguously and need no proxy list, which deplo
        // cannot know for an operator's own topology. Traefik alone still leaves
        // a one-hop `x-forwarded-for`, which resolves fine.
        ipAddressHeaders: ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"],
      },
    },
    hooks: { before: twoFactorGate },
    plugins: [
      // `issuer` is what an authenticator app labels the entry. Backup codes stay
      // at the plugin's default (10 codes, single-use), stored encrypted.
      twoFactor({ issuer: "deplo" }),
      // MUST stay last: it is an `after` hook that forwards Set-Cookie into the
      // Next.js cookie store, so anything appended after it would not be seen.
      nextCookies(),
    ],
  });
}

let instance: ReturnType<typeof createAuth> | null = null;
let instanceDb: DrizzleClient | null = null;

/**
 * The auth instance, or null when there is no database to back it.
 *
 * Memoized against the Drizzle client it was built from, NOT unconditionally:
 * `__setTestDb` hands out a fresh pglite client per test file, and a cached auth
 * instance still holding the previous one would silently query a closed database.
 * Comparing identity re-builds exactly when the client changes and never in
 * production, where `getDb()` returns the same pinned singleton forever.
 */
export function getAuth(): ReturnType<typeof createAuth> | null {
  if (!isPostgresEnabled() && !hasTestDb()) return null;
  const db = getDb();
  if (!instance || instanceDb !== db) {
    instanceDb = db;
    instance = createAuth(db);
  }
  return instance;
}

/** The auth instance, throwing rather than returning null. The login path needs it. */
export function requireAuth(): NonNullable<ReturnType<typeof getAuth>> {
  const auth = getAuth();
  if (!auth) throw new Error("Authentication is unavailable: no database configured");
  return auth;
}

export function isBetterAuthEnabled(): boolean {
  return isPostgresEnabled();
}
