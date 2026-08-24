import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import { users } from "./control-plane";

/**
 * Better Auth tables (session / account / verification / two_factor).
 *
 * Better Auth owns these via its Drizzle adapter. There is deliberately NO `user`
 * table here: since migration 0055 the control-plane `users` table IS Better Auth's
 * `user` model, remapped with `user: { modelName: "users" }` in
 * [../../auth/better-auth.ts](../../auth/better-auth.ts). That keeps `users.id` the
 * one identity every control-plane FK already points at, instead of standing up a
 * second user table to reconcile (ADR-0014).
 *
 * Timestamps here stay plain `timestamp` to match Better Auth's own column types
 * (and the already-applied baseline migration 0000); they are auth bookkeeping,
 * not the control-plane `*_at` columns that the lexicographic-sort modules read.
 */

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  /**
   * deplo's own column, invisible to Better Auth: WHAT this session presented.
   *
   * `"passkey"` means the session was opened by a WebAuthn ceremony the
   * authenticator marked user-verified - possession plus inherence, so two
   * factors - or by registering a passkey on this device, which is the same
   * proof. NULL is everything else, password sign-ins included, and is never
   * treated as a second factor.
   *
   * It exists so a team's two-factor mandate can be judged on what was actually
   * presented rather than on what the account merely owns. Without it the only
   * way to stop one factor clearing a two-factor policy was to refuse the
   * password entirely, which took away ADR-0014 §4's promise that a blocked
   * member can still reach their own settings and unblock themselves.
   */
  authMethod: text("auth_method"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  /**
   * WHICH authority vouched for `accountId` - new and REQUIRED since Better Auth
   * 1.7.0, which keys an account on `(issuer, accountId)` rather than on
   * `providerId` alone. Two upstreams can hand out the same subject id, and
   * before this a second one could land on the first one's row.
   *
   * The value is the library's own, not a string of ours: `local:credential` for
   * a password (`createLocalAccountIssuer`), `local:oauth:<id>` for a social
   * provider. The sign-in path compares it EXACTLY, so a row with the wrong
   * issuer is a credential that silently stops matching - which is why migration
   * 0115 backfills every existing row rather than defaulting the column.
   */
  issuer: text("issuer").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  idToken: text("id_token"),
  /** The credential provider's password. Since 0055 this is the ONLY stored copy —
   *  `users.password_hash` was dropped. Format is unchanged (`scrypt$salt$hash`),
   *  because Better Auth is configured with deplo's own hash/verify pair. */
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * The `twoFactor` plugin's table. `secret` and `backupCodes` are BOTH ciphertext,
 * encrypted by the plugin with the Better Auth secret (which deplo derives from
 * `DEPLO_SECRET`) — never project either into a DTO, exactly like the `*_enc`
 * columns. `failedVerificationCount`/`lockedUntil` are the plugin's own brute-force
 * lockout, which is why nothing in deplo counts TOTP attempts by hand.
 */
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count")
      .notNull()
      .default(0),
    lockedUntil: timestamp("locked_until"),
  },
  (t) => [
    index("two_factor_user_id_idx").on(t.userId),
    index("two_factor_secret_idx").on(t.secret),
  ],
);

/**
 * The `@better-auth/passkey` plugin's table - one WebAuthn credential per row.
 *
 * `publicKey` and `credentialID` are LIBRARY-OWNED and never belong in a DTO.
 * Neither is a secret the way `two_factor.secret` is (a public key is public by
 * construction, and the credential id is what the browser sends in the clear),
 * but both are the credential's identity: shipping them to a client hands an
 * attacker the exact material to correlate one person's device across every
 * account it protects. `PasskeyDTO` in lib/data/passkeys.ts carries `id`, `name`,
 * `createdAt` and whether the credential works on this address, and that is the
 * whole list.
 *
 * `name` is nullable because the plugin writes `undefined` when the client sent
 * no label; deplo always sends one, but the column has to allow the shape.
 *
 * ponytail: `counter` is `integer` (2^31) while WebAuthn defines a uint32. It
 * matches what the Drizzle adapter hands over (a JS `number`) and the ceiling is
 * unreachable in practice - most authenticators report 0 forever and never
 * increment. Widen to `bigint` only if a real device ever gets close.
 */
export const passkey = pgTable(
  "passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // UNIQUE, not merely indexed as the plugin's own schema declares it: the
    // authentication path resolves a credential with `findOne({credentialID})`,
    // so a duplicate would make WHICH account a passkey signs in depend on row
    // order. The database is the right place to make that impossible.
    credentialID: text("credential_id").notNull().unique(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    createdAt: timestamp("created_at"),
    aaguid: text("aaguid"),
    /**
     * deplo's own column, invisible to the plugin: the rpID this credential was
     * minted for, stamped right after registration.
     *
     * WebAuthn welds a credential to one hostname and the browser will not offer
     * it anywhere else. Without recording which one, a panel that moves to a new
     * address would leave every passkey unusable while they all still LOOK like
     * a valid second factor - and an account whose two-factor policy rested on
     * one would be refused its password and unable to complete the ceremony.
     * That is a lockout with no way out but the database.
     *
     * NULL means "minted before this column existed", and it is deliberately
     * treated as NOT satisfying the mandate: the safe direction is the one where
     * the person is asked for another second factor, not the one where they are
     * locked out.
     */
    rpId: text("rp_id"),
  },
  (t) => [index("passkey_user_id_idx").on(t.userId)],
);

/**
 * The `@better-auth/oauth-provider` plugin's four tables — deplo as an OAuth 2.1
 * authorization server, so claude.ai and ChatGPT can connect to `/api/mcp` (they
 * cannot be handed a bearer token by hand the way a terminal agent can).
 *
 * These are LIBRARY-OWNED, like the four above: the plugin writes and reads every
 * row, and the JS property names below are its field names verbatim — the Drizzle
 * adapter resolves a model field by looking up `schema[modelName][field]`, so
 * renaming one here breaks the adapter, not just a query. Only the SQL column
 * names are ours.
 *
 * Two deliberate exemptions from `AGENTS.md` → "Persistence", both forced and both
 * scoped to these four tables:
 *
 *  - **`text[]` instead of a junction table.** The adapter sets
 *    `supportsArrays: true` for Postgres and hands Drizzle a raw JS array, so a
 *    normalized child table cannot be written by it at all.
 *  - **One `jsonb` column** (`oauth_client.metadata`), for the same reason
 *    (`supportsJSON: true`). It holds RFC 7591 registration metadata deplo never
 *    reads, queries or indexes.
 *
 * Neither is control-plane state. Nothing outside the plugin writes these tables,
 * and the rule they bend stays in force everywhere else.
 *
 * Access and refresh tokens are stored **hashed with deplo's own `sha256Hex`**
 * (wired through `storeTokens` in [../../auth/better-auth.ts]) — the same digest
 * `api_tokens.token_hash` uses. A row here is never a usable credential.
 */
export const oauthClient = pgTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    /** Null for public clients, which is every client that self-registers: an
     *  unauthenticated RFC 7591 registration is forced to
     *  `token_endpoint_auth_method: "none"` by the plugin. */
    clientSecret: text("client_secret"),
    disabled: boolean("disabled").default(false),
    /** Never set by deplo. A consent screen that mints a credential is the
     *  security decision; there is nothing to skip. */
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
    /** Attacker-chosen, free text: a client may register itself as anything.
     *  Show the registered redirect origin next to it, never this alone. */
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    /**
     * RFC 7591 `application_type` - `web` or `native`, and the ONLY thing that
     * decides which redirect URIs are legal (1.7.0: web needs HTTPS on a
     * non-loopback host, native takes a claimed HTTPS URL, an exact loopback, or
     * a reverse-domain private-use scheme).
     *
     * It replaced the 1.6 pair `type` + `public`, and the replacement is not a
     * rename: whether a client is CONFIDENTIAL is now read from
     * `tokenEndpointAuthMethod` alone (`none` = public), so deriving this column
     * from the old `public` flag would conflate two unrelated questions. 0116
     * therefore maps `type` across by value and never consults `public`.
     */
    applicationType: text("application_type"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    /** Client-supplied JWKS for `private_key_jwt`. deplo registers no such
     *  client; the columns exist because the adapter resolves every field the
     *  plugin declares. */
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    /** Where the AS posts an OIDC back-channel logout. Never set: deplo issues
     *  opaque tokens against its own `api_tokens` rows, so ending a session is
     *  already the whole revocation. */
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required",
    ),
    /**
     * Machine-to-machine scope authority, and it DENIES by construction: missing,
     * NULL and empty all refuse `client_credentials`. deplo does not advertise
     * that grant at all (`grantTypes` in ../../auth/better-auth.ts lists
     * authorization_code + refresh_token), so the empty default is the intended
     * resting state and nothing should ever write here - an agent always acts for
     * a person, and a token with no user could not resolve to a connection.
     */
    clientCredentialsScopes: text("client_credentials_scopes")
      .array()
      .default([]),
    /** Provenance when a client was resolved through a discovery (CIMD). NULL for
     *  everything deplo has: plain RFC 7591 registration writes no discovery id. */
    clientDiscoveryId: text("client_discovery_id"),
    /** RFC 9449 sender-constrained tokens. Off: deplo's access token is a pointer
     *  at an `api_tokens` row that is read and re-authorized on every request. */
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (t) => [index("oauth_client_user_id_idx").on(t.userId)],
);

/** An opaque refresh token, issued only for the `offline_access` scope. */
export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    /** The authorization code this grant came from, so a replayed code can be
     *  traced to the tokens it already minted. */
    authorizationCodeId: text("authorization_code_id"),
    /** RFC 8707 audiences the grant was authorized for - the whole point of the
     *  1.7.0 change: the resource is now BOUND to the grant instead of merely
     *  validated at request time, which is what GHSA-p2fr-6hmx-4528 was about. */
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at"),
    revoked: timestamp("revoked"),
    /** Rotation bookkeeping: a refresh token that was already exchanged answers
     *  the recorded response until it expires, so a client that retries a lost
     *  reply is not punished for a network failure. */
    rotatedAt: timestamp("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at"),
    authTime: timestamp("auth_time"),
    /** RFC 9449 confirmation claim (`cnf`). NULL while DPoP stays off. */
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_refresh_token_client_id_idx").on(t.clientId),
    index("oauth_refresh_token_session_id_idx").on(t.sessionId),
    index("oauth_refresh_token_user_id_idx").on(t.userId),
  ],
);

/**
 * An opaque access token. This is the credential an AI client actually presents
 * to `/api/mcp`; `lib/data/tokens.ts` resolves it to the `api_tokens` row the
 * consent screen minted, and every gate from there is the one a `deplo_` token
 * already goes through.
 */
export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    /** See the twin on `oauthRefreshToken`: the audiences this token may be
     *  presented to, recorded on the row rather than re-derived per request. */
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at"),
    /** Set when a back-channel logout or an explicit revocation kills the token
     *  before it expires. Introspection answers `{active:false}` from here. */
    revoked: timestamp("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (t) => [
    index("oauth_access_token_client_id_idx").on(t.clientId),
    index("oauth_access_token_session_id_idx").on(t.sessionId),
    index("oauth_access_token_user_id_idx").on(t.userId),
    index("oauth_access_token_refresh_id_idx").on(t.refreshId),
  ],
);

/** What a user has agreed to give a client. Deleting it stops the next refresh;
 *  deleting the minted `api_tokens` row stops the next request. */
export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    /** What the person actually agreed to, audiences included. A consent that
     *  did not name a resource cannot mint a token aimed at it. */
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (t) => [
    index("oauth_consent_client_id_idx").on(t.clientId),
    index("oauth_consent_user_id_idx").on(t.userId),
  ],
);

/**
 * A protected resource the authorization server issues access tokens FOR -
 * RFC 8707's `resource` parameter, promoted in 1.7.0 from a config array
 * (`validAudiences`) to a persisted row with its own token policy.
 *
 * deplo seeds exactly ONE: `<public base>/api/mcp`. That is not a simplification
 * to revisit later, it is the security posture. GHSA-p2fr-6hmx-4528 (moderate,
 * every 1.6.x) was unbound resource indicators - the plugin validated `resource`
 * but did not BIND it to the grant, so with two or more valid audiences a client
 * could obtain a token aimed at a resource server it was never authorized for.
 * 1.7.0 binds it (see `resources` on the token rows); one live resource keeps the
 * blast radius at zero regardless.
 *
 * A panel that changes address gets a NEW identifier, and the old row is
 * DISABLED rather than deleted (`reconcileOAuthResources` in
 * ../../auth/oauth-resources.ts) - the audit answer to "which audience was valid
 * in March" has to survive, but only one may be requestable at a time.
 */
export const oauthResource = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  /** The RFC 8707 `resource` value itself: an absolute URI with no fragment. */
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean(
    "dpop_bound_access_tokens_required",
  ).default(false),
  disabled: boolean("disabled").default(false),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

/**
 * Which clients may request which resources - `enforcePerClientResources` is ON
 * (1.7.0's default), so a client with no row here can request nothing.
 *
 * deplo's registration is open by necessity (claude.ai and ChatGPT cannot
 * pre-register), so every client that self-registers is linked to the one MCP
 * resource automatically via `clientRegistrationDefaultResources`. Without that
 * link the token exchange fails with "requested resource invalid" while
 * registration and consent both look perfectly healthy.
 */
export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at"),
  },
  (t) => [
    // UNIQUE, not merely indexed: 1.7.0 converges concurrent CIMD refreshes on
    // one link rather than letting the second fail, and it can only do that if
    // the database says the pair is singular.
    uniqueIndex("oauth_client_resource_client_resource_key").on(
      t.clientId,
      t.resourceId,
    ),
    index("oauth_client_resource_resource_id_idx").on(t.resourceId),
  ],
);

/**
 * The replay cache for `private_key_jwt` client assertions: one row per `jti`,
 * kept until the assertion would have expired anyway.
 *
 * Empty on every deplo instance - no client here authenticates with a signed
 * assertion. It exists because the Drizzle adapter resolves a model to
 * `schema[modelName]`, so a table the plugin declares and deplo omits is not an
 * unused table, it is a crash the first time anything touches that path.
 */
export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  /** The assertion's `jti` verbatim - the id IS the thing being deduplicated. */
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
});
