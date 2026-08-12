# ADR-0022: The OAuth consent screen mints an API token

- **Status**: Accepted — 2026-08-12.
- **Resolves**: [ADR-0021](0021-the-mcp-server-is-a-first-party-route-not-a-plugin.md), "Considered
  options" → *"OAuth 2.1 / Protected Resource Metadata: deferred, not rejected"*. That deferral is
  now closed; everything else ADR-0021 decided stands unchanged.
- **Builds on**: [ADR-0015](0015-an-api-token-is-a-principal-with-its-own-capabilities.md) and
  [ADR-0014](0014-better-auth-is-the-live-auth-path.md).
- **Constrains**: `lib/auth/better-auth.ts`, `lib/auth/oauth-*.ts`, `lib/data/mcp-clients.ts`,
  `lib/data/tokens.ts`, `app/.well-known/*`, `app/oauth/consent/*`, `proxy.ts`.

## Context

deplo's MCP server works with every terminal and IDE agent, because all of them let you paste
`Authorization: Bearer deplo_…`. It does not work from **claude.ai** or **chatgpt.com**, which have
no such field: a web connector discovers its server, registers itself, and sends the user through
an OAuth 2.1 authorization flow. The MCP spec requires that of a protected server — Protected
Resource Metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration
(RFC 7591) and PKCE.

ADR-0021 deferred this on the grounds that "standing up an authorization server next to Better Auth
is a whole subsystem", and noted the 401 already carried a `WWW-Authenticate` challenge so the
discovery flow could be added without breaking a single existing client. Both halves proved true:
the subsystem is real, and nothing that worked before changed.

The subsystem is not ours. `@better-auth/oauth-provider` is the same project as the auth deplo
already runs, its peer dependencies were already installed at the exact pinned versions, and it
brings zero new transitive packages.

## Decision

1. **Approving the consent screen mints an ordinary `api_tokens` row, and the OAuth access token is
   a pointer at it.** This is the whole design. `authenticateToken` gained one branch — a token
   starting `dplo_at_` is looked up through `oauth_access_token` joined to `api_tokens` — and both
   shapes then converge on ONE identity builder. Every gate a `deplo_` token passes therefore
   applies unchanged and cannot drift: the capability clamp, the project scope, the two-factor
   policy, the fail-closed check that the minter is still a member, `lastUsedAt`, revocation.
   ADR-0021 §2's "there is no second authorization path, and there must never be one" is kept true
   by not building one. A static test asserts the consent path mints only through `createToken`,
   and another asserts nothing outside `lib/data/tokens.ts` builds a bearer identity.

   The corollary is that an OAuth connection reaches `/api/graphql` and the deploy hook too. It is
   an API token; pretending otherwise would mean a second kind of principal, which is the thing this
   ADR exists to avoid.

2. **The consent screen is the token-minting form.** Team, capabilities and scope, with the same
   components Settings → API tokens uses and the `MCP & AI agents` preset selected — one click for
   anyone who does not want to think about it, everything else behind an *Advanced* affordance. A
   screen that only said "Allow" could not tell a person what they were handing a third party, and
   what they are handing it is a credential.

3. **Two capabilities open the door: `manage_mcp` and `manage_tokens`.** The first is ADR-0021 §5's
   "may an agent drive this team at all"; the second is what minting a credential has always
   needed. `teams.mcp_enabled` gates the door as well as the request, so turning MCP off does not
   leave connections that resume when it flips back. `instanceAdmin` is unreachable here — the
   token is always scoped, and a scoped token is refused instance administration outright.

4. **Registration is open, bounded, and swept.** RFC 7591 registration must be unauthenticated:
   claude.ai cannot pre-register. Registering buys nothing — a client with no consent holds no
   token, reaches no team and appears nowhere — so the exposure is row creation, bounded by deplo's
   Postgres rate limiter (5/min per IP; the plugin's own limiter is in-memory and forgets on
   restart) and by a maintenance sweep that drops clients with no consent after seven days.

5. **Never auto-approve.** No trusted-client cache, no consent-skipping, no `prompt=none` shortcut.
   The authorize leg is a top-level GET navigation, so a `SameSite=Lax` session cookie *is* sent: if
   an existing consent could short-circuit the screen, a page could navigate a signed-in admin into
   granting a credential. The click is the security decision.

6. **Opaque tokens, hashed with deplo's own `sha256Hex`.** deplo is the authorization server and the
   only resource server, in one process on one database, so a JWT would save nothing — the
   `api_tokens` row is read on every request regardless, for capabilities, scope and the live
   creator clamp. Opaque instead gives instant revocation by construction, no JWKS table, and no
   `/api/auth/token` endpoint turning a session cookie into a bearer on instances that will never
   use MCP.

7. **Scopes are not permissions.** The OAuth scopes stay the standard four
   (`openid`/`profile`/`email`/`offline_access`) and decide nothing. What an agent may do is the
   token's Capabilities. **Capability** is deplo's word and **scope** is OAuth's; they must never
   share a variable.

## Considered options

- **Better Auth's built-in `mcp()` plugin**: rejected. It already serves Protected Resource Metadata
  and the right challenge, and it is installed — but it wraps `oidc-provider`, which Better Auth has
  deprecated with the warning silenced, so the migration cost is paid either way. Its helpers
  (`withMcpAuth`, `getMcpSession`) also bypass deplo's identity resolution entirely, never read
  `client.disabled`, and return the row including the refresh token. A test asserts they are
  imported nowhere.
- **A separate `oauth_grants` table** linking a consent to its token: rejected. Every column it
  would need already exists on `api_tokens`; one nullable `oauth_client_id` column plus a partial
  unique index on `(oauth_client_id, user_id)` says the same thing and keeps one list answering
  "who can act in this team".
- **Better Auth's `referenceId`**: rejected as the carrier. It is populated by a callback that runs
  *before* the consent form is filled in, so it cannot hold capabilities that have not been chosen
  yet, and it has no cascade.
- **JWT access tokens** (the plugin's default): rejected, see decision 6.
- **A per-connection "allow writes" switch**: rejected — migration 0100's mistake in OAuth clothing.

## Consequences

- Four library-owned tables (`oauth_client`, `oauth_consent`, `oauth_access_token`,
  `oauth_refresh_token`, migration 0101) join the Better Auth group in `lib/db/schema/auth.ts`. They
  carry `text[]` columns and one `jsonb` — the two exemptions the Drizzle adapter forces
  (`supportsArrays`/`supportsJSON` are not configurable, and declaring `text` makes its inserts
  fail). The rule they bend holds everywhere else.
- **`proxy.ts` had to stop redirecting `/.well-known` to `/login`.** Its matcher excluded `/api` but
  not the discovery paths, so an unauthenticated probe was a 302 and no web client could have
  connected at all. The redirect also now preserves the query for `/oauth/…` only: losing it strands
  someone mid-flow inside a third-party product.
- The consent page lives at `app/oauth/consent`, **not** under `app/(auth)` — that layout redirects
  a signed-in user to the dashboard, which is everyone who reaches consent.
- `app/api/mcp/route.ts` is now genuinely an OAuth resource server: its 401 carries
  `resource_metadata`, and it answers CORS preflights so a browser client can read the challenge.
  Its comment claiming deplo "is not an OAuth resource server" is gone.
- The route gained its first end-to-end tests. `lib/mcp/protocol.test.ts` started from a hand-built
  principal, so the kill switch, the rate limiter, the two-factor catch and the 401 body had never
  been asserted; `lib/mcp/route.test.ts` covers them and doubles as the regression net proving the
  `deplo_` path is unchanged.
- `disableSignUp` is asserted for the first time (`lib/auth/oauth-provider.test.ts`). It was named
  load-bearing in `lib/auth/better-auth.ts` and tested nowhere.
