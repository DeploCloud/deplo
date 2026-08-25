import "server-only";

import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned } from "better-auth/plugins/haveibeenpwned";
import { twoFactor } from "better-auth/plugins/two-factor";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { getDb, hasTestDb, type DrizzleClient } from "@/lib/db/client";
import { isPostgresEnabled } from "@/lib/db/pg";
import { schema } from "@/lib/db/schema";
import {
  deriveKey,
  hashPassword,
  sha256Hex,
  verifyPassword,
} from "@/lib/crypto";
import { PWNED_PASSWORD_MESSAGE } from "@/lib/pwned-password";
import { newId } from "@/lib/ids";
import {
  cookiesAreSecure,
  passkeyRelyingParty,
  publicBaseUrl,
} from "@/lib/public-url";
import { MCP_RESOURCE_PATH } from "@/lib/auth/oauth-metadata";

/**
 * Better Auth configuration — the LIVE login path since ADR-0014. The secret is
 * DERIVED from `DEPLO_SECRET` rather than being it, so the TOTP secrets the
 * twoFactor plugin encrypts are not sealed under the same key as `*_enc`.
 */

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** The session cookie's base name. Better Auth prefixes `__Secure-` when secure. */
export const SESSION_COOKIE_NAME = "deplo.session_token";

/** The prefix a browser only accepts on a cookie set over https. */
export const SECURE_COOKIE_PREFIX = "__Secure-";

/**
 * Whether the session cookie may carry the `__Secure-` prefix.
 */
function secureCookies(): boolean {
  return cookiesAreSecure();
}

/** Both names the session cookie can have, in the order a reader should try them. */
export function sessionCookieNames(): [string, string] {
  return [SESSION_COOKIE_NAME, `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_NAME}`];
}

/**
 * Refuse every `/two-factor/*` endpoint that arrived over HTTP. So the endpoints
 * are closed to the network and reachable only from `lib/data/two-factor.ts`,
 * which verifies a TOTP or recovery code first.
 */
const twoFactorGate = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith("/two-factor/") || !ctx.request) return;
  throw new APIError("FORBIDDEN", {
    message:
      "Two-factor settings are changed through deplo, which asks for a code first.",
    code: "TWO_FACTOR_STEP_UP_REQUIRED",
  });
});

/**
 * Refuse every `/passkey/*` endpoint that arrived over HTTP. Leaving the endpoint
 * open would be a second front door with none of the locks.
 */
const passkeyGate = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith("/passkey/") || !ctx.request) return;
  throw new APIError("FORBIDDEN", {
    message:
      "Passkeys are managed through deplo, which asks for your password first.",
    code: "PASSKEY_STEP_UP_REQUIRED",
  });
});

/**
 * Endpoints Better Auth exposes that deplo drives ITSELF, and that must not be a
 * second way in off the network. `app/api/auth/[...all]/route.ts` mounts the
 * plugin whole, because the OAuth surface has to be reachable.
 */
const DEPLO_OWNED_AUTH_PATHS = [
  "/sign-in/",
  "/sign-up/",
  "/change-password",
  "/set-password",
  "/change-email",
  "/update-user",
  "/delete-user",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/forget-password",
  "/reset-password",
  "/request-password-reset",
] as const;

/** Whether Better Auth's own endpoint at `path` is one deplo drives itself.
 *  Exported so the list is exercised without standing up an auth instance. */
export function isDeploOwnedAuthPath(path: string): boolean {
  return DEPLO_OWNED_AUTH_PATHS.some((p) => path.startsWith(p));
}

const deploOwnedGate = createAuthMiddleware(async (ctx) => {
  if (!ctx.request) return;
  if (!isDeploOwnedAuthPath(ctx.path)) return;
  throw new APIError("FORBIDDEN", {
    message:
      "Accounts are managed through deplo, which rate-limits sign-ins per account and records failed attempts. Use the dashboard.",
    code: "DEPLO_OWNED_ENDPOINT",
  });
});

/**
 * Refuse a ceremony the authenticator did not verify was a PERSON. For an ordinary
 * passkey that would be a shrug; here it is not, because in deplo a passkey
 * SATISFIES a team's two-factor mandate.
 */
const requireUserVerified = ({
  verification,
}: {
  verification: {
    registrationInfo?: { userVerified: boolean };
    authenticationInfo?: { userVerified: boolean };
  };
}): void => {
  const verified =
    verification.authenticationInfo?.userVerified ??
    verification.registrationInfo?.userVerified;
  if (verified) return;
  throw new APIError("UNAUTHORIZED", {
    message:
      "That passkey did not verify it was you. Use one that asks for a PIN, a fingerprint or your face.",
    code: "PASSKEY_USER_VERIFICATION_REQUIRED",
  });
};

/**
 * Refuse `prompt=none` on the authorization endpoint.
 */
const silentAuthorizeGate = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith("/oauth2/authorize") || !ctx.request) return;
  const prompt = new URL(ctx.request.url).searchParams.get("prompt");
  if (!prompt?.split(/\s+/).includes("none")) return;
  throw new APIError("BAD_REQUEST", {
    error: "interaction_required",
    error_description:
      "deplo always asks the person before connecting an app. Retry without prompt=none.",
  });
});

const authorizeGates = createAuthMiddleware(async (ctx) => {
  await twoFactorGate(ctx);
  await passkeyGate(ctx);
  await deploOwnedGate(ctx);
  await silentAuthorizeGate(ctx);
});

/**
 * The OAuth 2.1 provider's configuration.
 */
function oauthProviderOptions() {
  const base = publicBaseUrl() ?? "";
  return {
    loginPage: "/login",
    consentPage: "/oauth/consent",

    // claude.ai and ChatGPT have no way to pre-register, so RFC 7591 registration has
    // to be open.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,

    // An agent always acts FOR A PERSON.
    grantTypes: ["authorization_code" as const, "refresh_token" as const],

    // deplo has no UI for managing OAuth clients and never intended to expose one.
    clientPrivileges: () => false,

    // RFC 8707 resource indicators.
    resources: [`${base}${MCP_RESOURCE_PATH}`],

    // Every client that self-registers is linked to that one resource.
    clientRegistrationDefaultResources: [`${base}${MCP_RESOURCE_PATH}`],

    // Opaque tokens, hashed with the SAME digest `api_tokens.token_hash` uses. deplo is
    // both the authorization server and the only resource server, in one process on one
    // database, so a JWT would save nothing: the `api_tokens` row has to be read on
    // every request anyway for capabilities, scope and the live creator clamp.
    disableJwtPlugin: true,
    storeTokens: { hash: (token: string) => sha256Hex(token) },
    // Client secrets stay at the plugin's default for this mode ("encrypted", symmetric
    // under the Better Auth secret) — the same treatment the twoFactor plugin gives a
    // TOTP secret, keyed the same way.
    prefix: {
      opaqueAccessToken: "dplo_at_",
      refreshToken: "dplo_rt_",
      clientSecret: "dplo_cs_",
    },

    // Never auto-approve.
    cachedTrustedClients: new Set<string>(),

    // An explicit claim set, because Better Auth's `user` model IS the control-plane
    // `users` table (ADR-0014). A generous default here would ship `is_instance_admin`,
    // `suspended` and the rest of that row to every client that ever registered.
    customUserInfoClaims: ({
      user,
    }: {
      user: { id: string; name?: string | null; email?: string | null };
    }) => ({
      sub: user.id,
      name: user.name ?? null,
      email: user.email ?? null,
    }),
  };
}

/**
 * The passkey plugin's configuration. The global alternative (`session.freshAge:
 * 0`) would also unlock `/list-sessions`, which answers with raw session TOKENS.
 */
function passkeyOptions() {
  const rp = passkeyRelyingParty();
  return {
    // "localhost" is the plugin's own fallback, and it is only ever reached on
    // an instance that has no usable address, where the ceremony fails anyway.
    rpID: rp?.rpId ?? "localhost",
    // What the authenticator shows the person while it asks for their
    // fingerprint. The instance's own name is not knowable synchronously here.
    rpName: "deplo",
    origin: rp?.origin ?? null,
    authenticatorSelection: {
      residentKey: "required" as const,
      userVerification: "required" as const,
    },
    registration: {
      requireSession: false,
      afterVerification: requireUserVerified,
    },
    authentication: { afterVerification: requireUserVerified },
  };
}

function createAuth(db: DrizzleClient) {
  return betterAuth({
    appName: "Deplo",
    secret: deriveKey("better-auth").toString("hex"),
    baseURL: publicBaseUrl() ?? undefined,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    user: { modelName: "users" },
    emailAndPassword: {
      enabled: true,
      // Accounts are created via first-run setup / registration links only —
      // never through the public /api/auth/sign-up/email endpoint.
      disableSignUp: true,
      minPasswordLength: 8,
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      // Every refresh rewrites `session.updated_at`, which is the ONLY thing the
      // signed-in-devices list can call "last seen".
      updateAge: 60 * 15,
    },
    advanced: {
      // Cookies are Secure when the instance is actually served over HTTPS.
      useSecureCookies: secureCookies(),
      cookiePrefix: "deplo",
      database: { generateId: () => newId("bas") },
      ipAddress: {
        // Better Auth defaults to `x-forwarded-for` alone, and — this is the part that
        // bites — it REFUSES a forwarded chain with more than one hop unless
        // `trustedProxies` is configured, returning no address at all.
        ipAddressHeaders: ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"],
      },
    },
    hooks: { before: authorizeGates },
    plugins: [
      // `issuer` is what an authenticator app labels the entry. Backup codes stay
      // at the plugin's default (10 codes, single-use), stored encrypted.
      twoFactor({ issuer: "deplo" }),
      // Breach check on the Better Auth endpoints themselves: `/api/auth/*` is mounted
      // whole (app/api/auth/[...all]/route.ts), so `/change-password` and
      // `/reset-password` are reachable over the network even though the dashboard never
      // uses them. deplo's own writes do not pass through here - they call
      // `assertPasswordNotPwned` in lib/pwned-password.ts, which is where the same check
      // lives for setup, the registration link, the account settings, the admin reset,
      // basic auth and database passwords.
      haveIBeenPwned({
        customPasswordCompromisedMessage: PWNED_PASSWORD_MESSAGE,
      }),
      // deplo as an OAuth 2.1 authorization server, so a web AI client can reach
      // `/api/mcp`. See the docblock above `oauthProviderOptions`.
      oauthProvider(oauthProviderOptions()),
      // WebAuthn: a sign-in method AND the thing that satisfies a team's
      // two-factor mandate (ADR-0024). See `passkeyOptions` above.
      passkey(passkeyOptions()),
      // MUST stay last: it is an `after` hook that forwards Set-Cookie into the
      // Next.js cookie store, so anything appended after it would not be seen.
      nextCookies(),
    ],
  });
}

let instance: ReturnType<typeof createAuth> | null = null;
let instanceDb: DrizzleClient | null = null;

/**
 * The auth instance, or null when there is no database to back it. Comparing
 * identity re-builds exactly when the client changes and never in production,
 * where `getDb()` returns the same pinned singleton forever.
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

/**
 * Drop the memoized instance so the next {@link getAuth} rebuilds it.
 */
export function resetAuth(): void {
  instance = null;
  instanceDb = null;
}

/** The auth instance, throwing rather than returning null. The login path needs it. */
export function requireAuth(): NonNullable<ReturnType<typeof getAuth>> {
  const auth = getAuth();
  if (!auth)
    throw new Error("Authentication is unavailable: no database configured");
  return auth;
}

export function isBetterAuthEnabled(): boolean {
  return isPostgresEnabled();
}
