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

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE_NAME = "deplo.session_token";

export const SECURE_COOKIE_PREFIX = "__Secure-";

function secureCookies(): boolean {
  return cookiesAreSecure();
}

export function sessionCookieNames(): [string, string] {
  return [SESSION_COOKIE_NAME, `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_NAME}`];
}

// Network only: ctx.request is absent for the auth.api.* calls in lib/data/two-factor.ts, which verify a code first.
const twoFactorGate = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith("/two-factor/") || !ctx.request) return;
  throw new APIError("FORBIDDEN", {
    message:
      "Two-factor settings are changed through Deplo, which asks for a code first.",
    code: "TWO_FACTOR_STEP_UP_REQUIRED",
  });
});

const passkeyGate = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith("/passkey/") || !ctx.request) return;
  throw new APIError("FORBIDDEN", {
    message:
      "Passkeys are managed through Deplo, which asks for your password first.",
    code: "PASSKEY_STEP_UP_REQUIRED",
  });
});

// Deplo's own sign-in is the only path that limits per ACCOUNT, raises failed_logins and refuses a suspended account.
const DEPLO_OWNED_AUTH_PATHS = [
  "/sign-in/",
  "/sign-up/",
  "/change-password",
  "/verify-password",
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

export function isDeploOwnedAuthPath(path: string): boolean {
  return DEPLO_OWNED_AUTH_PATHS.some((p) => path.startsWith(p));
}

const deploOwnedGate = createAuthMiddleware(async (ctx) => {
  if (!ctx.request) return;
  if (!isDeploOwnedAuthPath(ctx.path)) return;
  throw new APIError("FORBIDDEN", {
    message:
      "Accounts are managed through Deplo, which rate-limits sign-ins per account and records failed attempts. Use the dashboard.",
    code: "DEPLO_OWNED_ENDPOINT",
  });
});

// A passkey SATISFIES a team's two-factor mandate (ADR-0024), so an unverified ceremony cannot be shrugged off here.
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

const silentAuthorizeGate = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith("/oauth2/authorize") || !ctx.request) return;
  const prompt = new URL(ctx.request.url).searchParams.get("prompt");
  if (!prompt?.split(/\s+/).includes("none")) return;
  throw new APIError("BAD_REQUEST", {
    error: "interaction_required",
    error_description:
      "Deplo always asks the person before connecting an app. Retry without prompt=none.",
  });
});

const authorizeGates = createAuthMiddleware(async (ctx) => {
  await twoFactorGate(ctx);
  await passkeyGate(ctx);
  await deploOwnedGate(ctx);
  await silentAuthorizeGate(ctx);
});

function oauthProviderOptions() {
  const base = publicBaseUrl() ?? "";
  return {
    loginPage: "/login",
    consentPage: "/oauth/consent",

    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,

    grantTypes: ["authorization_code" as const, "refresh_token" as const],

    clientPrivileges: () => false,

    resources: [`${base}${MCP_RESOURCE_PATH}`],

    clientRegistrationDefaultResources: [`${base}${MCP_RESOURCE_PATH}`],

    disableJwtPlugin: true,
    storeTokens: { hash: (token: string) => sha256Hex(token) },
    prefix: {
      opaqueAccessToken: "dplo_at_",
      refreshToken: "dplo_rt_",
      clientSecret: "dplo_cs_",
    },

    cachedTrustedClients: new Set<string>(),

    // The user model IS the users table (ADR-0014), so a default set would leak is_instance_admin and suspended.
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

function passkeyOptions() {
  const rp = passkeyRelyingParty();
  return {
    rpID: rp?.rpId ?? "localhost",
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
      // Better Auth must never INSERT into users: it knows nothing about that table's NOT NULL columns (ADR-0014).
      disableSignUp: true,
      minPasswordLength: 8,
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
    },
    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 60 * 15,
    },
    advanced: {
      useSecureCookies: secureCookies(),
      cookiePrefix: "deplo",
      database: { generateId: () => newId("bas") },
      ipAddress: {
        // Better Auth's x-forwarded-for default returns NO address for a chain over one hop without trustedProxies.
        ipAddressHeaders: ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"],
      },
    },
    hooks: { before: authorizeGates },
    plugins: [
      twoFactor({ issuer: "deplo" }),
      haveIBeenPwned({
        customPasswordCompromisedMessage: PWNED_PASSWORD_MESSAGE,
      }),
      oauthProvider(oauthProviderOptions()),
      passkey(passkeyOptions()),
      // MUST stay last: it is an after hook forwarding Set-Cookie, so anything appended after it is not seen.
      nextCookies(),
    ],
  });
}

let instance: ReturnType<typeof createAuth> | null = null;
let instanceDb: DrizzleClient | null = null;
let instanceEpoch = -1;

const EPOCH_KEY = Symbol.for("deplo.auth.epoch");
const ge = globalThis as unknown as { [EPOCH_KEY]?: number };

export function getAuth(): ReturnType<typeof createAuth> | null {
  if (!isPostgresEnabled() && !hasTestDb()) return null;
  const db = getDb();
  const epoch = ge[EPOCH_KEY] ?? 0;
  if (!instance || instanceDb !== db || instanceEpoch !== epoch) {
    instanceDb = db;
    instanceEpoch = epoch;
    instance = createAuth(db);
  }
  return instance;
}

export function resetAuth(): void {
  ge[EPOCH_KEY] = (ge[EPOCH_KEY] ?? 0) + 1;
  instance = null;
  instanceDb = null;
}

export function requireAuth(): NonNullable<ReturnType<typeof getAuth>> {
  const auth = getAuth();
  if (!auth)
    throw new Error("Authentication is unavailable: no database configured");
  return auth;
}
