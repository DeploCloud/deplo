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
 *     hash ever written still verifies and nobody had to reset a password -
 *     `scrypt$salt$hash` from before the migration, `scrypt$N$r$p$salt$hash`
 *     since the work factor became a stored parameter. Change this and you
 *     invalidate every credential. Both are async: `verify` sits on the login
 *     path and scrypt at the current cost must not run on the event loop.
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

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** The session cookie's base name. Better Auth prefixes `__Secure-` when secure. */
export const SESSION_COOKIE_NAME = "deplo.session_token";

/** The prefix a browser only accepts on a cookie set over https. */
export const SECURE_COOKIE_PREFIX = "__Secure-";

/**
 * Whether the session cookie may carry the `__Secure-` prefix.
 *
 * Reads the EFFECTIVE address, not the env var: an operator who turned the
 * panel's HTTPS off is served over http from that moment, and a `__Secure-`
 * cookie is one a browser refuses to send there - a panel that loads and can
 * never be logged into. {@link resetAuth} is what makes the change land without
 * a restart.
 *
 * Not named `use*`: it is a plain predicate, and the prefix reads as a React hook.
 */
function secureCookies(): boolean {
  return cookiesAreSecure();
}

/** Both names the session cookie can have, in the order a reader should try them. */
export function sessionCookieNames(): [string, string] {
  return [SESSION_COOKIE_NAME, `${SECURE_COOKIE_PREFIX}${SESSION_COOKIE_NAME}`];
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

/**
 * Refuse every `/passkey/*` endpoint that arrived over HTTP.
 *
 * Same shape and same reason as {@link twoFactorGate}, applied to a plugin whose
 * gate is one notch lower still: registering a passkey asks for a SESSION and
 * nothing else, so a stolen cookie is enough to weld a permanent credential onto
 * somebody's account - one that then signs in with no password at all. deplo
 * asks for the password first (`lib/data/passkeys.ts`), which is the bar the
 * account's other credential changes already clear.
 *
 * The LOGIN endpoints are closed too, which is the part worth explaining. The
 * plugin's `/passkey/verify-authentication` mints a session and sets the cookie,
 * but it does not check `users.suspended`, does not touch the rate limiter and
 * does not record a failed attempt - all three live in the GraphQL resolvers
 * (`lib/graphql/types/auth.ts`) with every other sign-in path. Leaving the
 * endpoint open would be a second front door with none of the locks.
 *
 * All seven endpoints share the `/passkey/` prefix (there is no
 * `/sign-in/passkey`: the client's `signIn.passkey` is a browser-side composite
 * of two of them), so one matcher closes the whole plugin.
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
 * Refuse a ceremony the authenticator did not verify was a PERSON.
 *
 * The plugin hardcodes `requireUserVerification: false` in both verifiers, and
 * `authenticatorSelection.userVerification: "required"` below is only a REQUEST
 * - WebAuthn lets the authenticator answer without it, and the response still
 * verifies. For an ordinary passkey that would be a shrug; here it is not,
 * because in deplo a passkey SATISFIES a team's two-factor mandate. A credential
 * that unlocks with no PIN, no fingerprint and no face is one factor
 * (possession) wearing the badge of two, and the person relying on the policy is
 * the team that turned it on, not the one holding the key.
 *
 * Cost of the guard: a hardware key with no PIN set is refused at registration,
 * with a message that says what to fix.
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
 *
 * The provider honours it: with a consent already on file it answers a
 * top-level GET with a 302 straight back to the client carrying a fresh
 * authorization code, no screen and no click. That is ordinary OAuth silent
 * re-authentication, and it is wrong HERE, because in deplo a consent is not a
 * preference a client re-reads — it is the act that mints an API token, and
 * every one of those has to be somebody deciding on purpose (ADR-0022 §6).
 *
 * `interaction_required` is the spec's own answer, and a client that gets it
 * retries with a normal prompt, which is exactly the screen we want shown.
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
  await silentAuthorizeGate(ctx);
});

/**
 * The OAuth 2.1 provider's configuration.
 *
 * Why deplo runs an authorization server at all: claude.ai and chatgpt.com cannot
 * be handed a bearer token the way a terminal agent can, and the MCP spec requires
 * this flow (RFC 9728 + RFC 8414 + RFC 7591 + PKCE) of a protected MCP server.
 * ADR-0021 recorded it as "deferred, not rejected"; this is that.
 *
 * **The one thing to understand before changing anything here: an OAuth grant is
 * not a new kind of credential.** Approving the consent screen mints an ordinary
 * `api_tokens` row, and the access token issued below is only a pointer at it
 * (`lib/data/tokens.ts`). That is what keeps ADR-0021 §2 true — one authorization
 * path, no second one to drift — and it is why nothing here decides what an agent
 * may DO. An OAuth **scope** and a deplo **Capability** are different concepts and
 * must never share a variable: the scopes below are the standard four, and the
 * Capabilities live on the minted token.
 */
function oauthProviderOptions() {
  const base = publicBaseUrl() ?? "";
  return {
    loginPage: "/login",
    consentPage: "/oauth/consent",

    // claude.ai and ChatGPT have no way to pre-register, so RFC 7591 registration
    // has to be open. Registering buys nothing on its own: a client with no
    // consent holds no token, reaches no team and appears nowhere. It is bounded
    // by deplo's own Postgres rate limiter in app/api/auth/[...all]/route.ts (the
    // plugin's built-in one is in-memory, so it forgets on restart) and swept in
    // lib/notify/maintenance.ts.
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,

    // An agent always acts FOR A PERSON. `client_credentials` has no user, so a
    // token from it could never resolve to a connection anyway — but advertising
    // a grant deplo will not honour only invites a client to try it and fail
    // somewhere less legible than here.
    grantTypes: ["authorization_code" as const, "refresh_token" as const],

    // deplo has no UI for managing OAuth clients and never intended to expose
    // one. Without this hook the plugin's `/oauth2/create-client` (and the rest
    // of that surface) answers to any signed-in session; the hook is skipped for
    // UNauthenticated registration, which is the path claude.ai actually uses,
    // so open DCR keeps working while the session-backed surface closes.
    clientPrivileges: () => false,

    // RFC 8707 resource indicators. An MCP client sends
    // `resource=<base>/api/mcp`, and the token endpoint refuses any audience not
    // listed here — so leaving the MCP resource out makes every exchange fail
    // with "requested resource invalid" while everything else looks healthy.
    //
    // EXACTLY ONE entry, deliberately. GHSA-p2fr-6hmx-4528 (moderate, affects
    // every 1.6.x): the plugin validates the `resource` parameter but does not
    // BIND it to the grant, so with two or more valid audiences a client can
    // obtain a token aimed at a resource server it was not authorised for. The
    // advisory's own first workaround is to allow a single audience, and deplo
    // has exactly one resource worth naming. Belt to that brace: an access token
    // only resolves here by way of the `api_tokens` row its consent minted, so a
    // token with the wrong audience would still reach the same connection and
    // nothing else. Revisit when 1.7.0 ships — the fix needs a schema migration
    // and changes `customAccessTokenClaims`, so it is not a version bump.
    validAudiences: [`${base}${MCP_RESOURCE_PATH}`],

    // Opaque tokens, hashed with the SAME digest `api_tokens.token_hash` uses.
    // deplo is both the authorization server and the only resource server, in one
    // process on one database, so a JWT would save nothing: the `api_tokens` row
    // has to be read on every request anyway for capabilities, scope and the live
    // creator clamp. Opaque instead buys instant revocation by construction, no
    // JWKS table, and no `/api/auth/token` endpoint turning a session cookie into
    // a bearer on instances that will never use MCP.
    disableJwtPlugin: true,
    storeTokens: { hash: (token: string) => sha256Hex(token) },
    // Client secrets stay at the plugin's default for this mode ("encrypted",
    // symmetric under the Better Auth secret) — the same treatment the twoFactor
    // plugin gives a TOTP secret, keyed the same way. A self-registered client has
    // no secret at all: unauthenticated registration forces
    // `token_endpoint_auth_method: "none"`.
    // Prefixes make the two credential families tellable apart in a log, and must
    // NOT begin with `deplo_` — that literal is how `authenticateToken` decides
    // which lookup to run.
    prefix: {
      opaqueAccessToken: "dplo_at_",
      refreshToken: "dplo_rt_",
      clientSecret: "dplo_cs_",
    },

    // Never auto-approve. The authorize leg is a top-level GET navigation, so a
    // SameSite=Lax session cookie IS sent: if an existing consent could
    // short-circuit the screen, any page could navigate a signed-in admin into
    // granting a credential. The click is the security decision.
    cachedTrustedClients: new Set<string>(),

    // An explicit claim set, because Better Auth's `user` model IS the
    // control-plane `users` table (ADR-0014). A generous default here would ship
    // `is_instance_admin`, `suspended` and the rest of that row to every client
    // that ever registered.
    customUserInfoClaims: ({
      user,
    }: {
      user: { id: string; name?: string | null; email?: string | null };
    }) => ({ sub: user.id, name: user.name ?? null, email: user.email ?? null }),

    // The root-path documents live in app/.well-known/*; the plugin's own copies
    // sit under /api/auth and nothing probes them.
    silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
  };
}

/**
 * The passkey plugin's configuration.
 *
 * Registered UNCONDITIONALLY, even on an instance that cannot have passkeys
 * (no address, or plain http): the alternative leaves `auth.api.listPasskeys`
 * undefined and forces every caller in lib/data to branch on it. The ceremony
 * fails clearly instead - with no `origin` the plugin's own verifiers refuse -
 * and the card in Settings → Security is what explains it to the person, which
 * is where an explanation belongs.
 *
 * Three settings are decisions, not defaults:
 *
 *  - **`origin` must be explicit.** Both verifiers do
 *    `options.origin || ctx.headers?.get("origin") || ""` and throw on the empty
 *    string, and `authHeaders()` strips `origin` deliberately (see
 *    ./request-headers.ts). Leave it off and every ceremony 400s.
 *  - **`registration.requireSession: false`** takes `freshSessionMiddleware` off
 *    the two registration endpoints. Its bar is `session.createdAt` newer than
 *    `freshAge`, which defaults to 24 HOURS while deplo's sessions live a week:
 *    with it on, "Add passkey" fails for anyone signed in since yesterday. The
 *    global alternative (`session.freshAge: 0`) would also unlock
 *    `/list-sessions`, which answers with raw session TOKENS. Nothing is lost:
 *    `resolveRegistrationUser` still falls through to the session, and
 *    verify-registration still refuses a credential for another user's id.
 *  - **`residentKey: "required"`** is what makes signing in without typing an
 *    email possible at all (a discoverable credential is one the browser can
 *    offer unprompted). On a hardware key it consumes one of a small number of
 *    resident slots; on a phone or a password manager it costs nothing.
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
    hooks: { before: authorizeGates },
    plugins: [
      // `issuer` is what an authenticator app labels the entry. Backup codes stay
      // at the plugin's default (10 codes, single-use), stored encrypted.
      twoFactor({ issuer: "deplo" }),
      // Breach check on the Better Auth endpoints themselves: `/api/auth/*` is
      // mounted whole (app/api/auth/[...all]/route.ts), so `/change-password`
      // and `/reset-password` are reachable over the network even though the
      // dashboard never uses them. deplo's own writes do not pass through here -
      // they call `assertPasswordNotPwned` in lib/pwned-password.ts, which is
      // where the same check lives for setup, the registration link, the account
      // settings, the admin reset, basic auth and database passwords. Same
      // message from both so the refusal never reads like two different rules.
      haveIBeenPwned({ customPasswordCompromisedMessage: PWNED_PASSWORD_MESSAGE }),
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

/**
 * Drop the memoized instance so the next {@link getAuth} rebuilds it.
 *
 * Called when the panel's address or its scheme changes: both are baked into the
 * instance at construction (`baseURL`, `useSecureCookies`), and without this the
 * running process would keep issuing cookies for the scheme it booted with.
 */
export function resetAuth(): void {
  instance = null;
  instanceDb = null;
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
