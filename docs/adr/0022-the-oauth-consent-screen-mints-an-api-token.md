# ADR-0022: The OAuth consent screen mints an API token

- **Status**: Accepted - 2026-08-12.
- **Resolves**: [ADR-0021](0021-the-mcp-server-is-a-first-party-route-not-a-plugin.md), "Considered
  options" → _"OAuth 2.1 / Protected Resource Metadata: deferred, not rejected"_. That deferral is
  now closed; everything else ADR-0021 decided stands unchanged.
- **Builds on**: [ADR-0015](0015-an-api-token-is-a-principal-with-its-own-capabilities.md) and
  [ADR-0014](0014-better-auth-is-the-live-auth-path.md).
- **Constrains**: `lib/auth/better-auth.ts`, `lib/auth/oauth-*.ts`, `lib/data/mcp-clients.ts`,
  `lib/data/tokens.ts`, `app/.well-known/*`, `app/oauth/consent/*`, `proxy.ts`.

## Context

deplo's MCP server works with every terminal and IDE agent, because all of them let you paste
`Authorization: Bearer deplo_…`. It does not work from **claude.ai** or **chatgpt.com**, which have
no such field: a web connector discovers its server, registers itself, and sends the user through
an OAuth 2.1 authorization flow. The MCP spec requires that of a protected server - Protected
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
   a pointer at it.** This is the whole design. `authenticateToken` gained one branch - a token
   starting `dplo_at_` is looked up through `oauth_access_token` joined to `api_tokens`, and both
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
   components Settings → API tokens uses and the `MCP & AI agents` preset selected - one click for
   anyone who does not want to think about it, everything else behind an _Advanced_ affordance. A
   screen that only said "Allow" could not tell a person what they were handing a third party, and
   what they are handing it is a credential.

3. **Authority is granted per team; the team is declared per call.** Two separate things, and
   collapsing them is what broke this twice. ADR-0021 §3 rules out a REMEMBERED team - the protocol
   is stateless, there is no session to hold one, and a `switch_team` tool could only rewrite the
   connection's own scope, which is an agent widening the credential it runs on. A team named in the
   call is the opposite of remembered state and fits the protocol exactly.

   So the consent screen has **one control** for "where" (the scope picker: whole teams, or narrower
   inside them) - a separate team dropdown beside it was two controls answering one question, free
   to disagree, and they did: a connection approved for one team was granted four. Every team named
   is gated **in that team** (`manage_mcp`, membership, the team's own switch), because holding a
   capability here says nothing about there. The team a connection is made from is always included.

   Every tool then takes an optional `team`. Omitted, it is the connection's own team. Named, it is
   resolved against the granted set **and refused if absent**, never quietly swapped for another,
   which is precisely how an app was once created in a team nobody had chosen. `X-Deplo-Team` keeps
   its documented lenient behaviour for a `deplo_` token; the strictness belongs to the caller that
   cannot tolerate a fallback, not to the shared resolver.

4. **Two capabilities open the door: `manage_mcp` and `manage_tokens`.** The first is ADR-0021 §5's
   "may an agent drive this team at all"; the second is what minting a credential has always
   needed. `teams.mcp_enabled` gates the door as well as the request, so turning MCP off does not
   leave connections that resume when it flips back. `instanceAdmin` is unreachable here - the
   token is always scoped, and a scoped token is refused instance administration outright.

5. **Registration is open, bounded, and swept.** RFC 7591 registration must be unauthenticated:
   claude.ai cannot pre-register. Registering buys nothing - a client with no consent holds no
   token, reaches no team and appears nowhere, so the exposure is row creation, bounded by deplo's
   Postgres rate limiter (5/min per IP; the plugin's own limiter is in-memory and forgets on
   restart) and by a maintenance sweep that drops clients with no consent after seven days.

6. **Never auto-approve, and the mint requires a fresh approval on file.** No trusted-client cache,
   no consent-skipping, and **`prompt=none` is refused** - the provider honours it, answering a
   top-level GET with a 302 straight back to the client carrying a code, and a `SameSite=Lax`
   session cookie _is_ sent on that navigation. Ordinary OAuth silent re-authentication; wrong here,
   because a consent is not a preference a client re-reads, it is the act that mints a credential.
   `interaction_required` is the spec's own answer and a client retries with a real prompt.

   The same reasoning binds the mint. It used to answer to a `client_id` plus a session and nothing
   else, so a link to `/oauth/consent?client_id=<mine>` was enough to get somebody with the
   capabilities to click Authorize and mint a live API token for a client they had never heard of.
   The page therefore posts the consent FIRST - that endpoint verifies the provider's signature over
   the authorization query before recording anything, and `mintMcpConnection` requires that record,
   fresh within five minutes. The proof is a row rather than a signature deplo re-derives: the
   database already knows what the library verified.

7. **Opaque tokens, hashed with deplo's own `sha256Hex`.** deplo is the authorization server and the
   only resource server, in one process on one database, so a JWT would save nothing - the
   `api_tokens` row is read on every request regardless, for capabilities, scope and the live
   creator clamp. Opaque instead gives instant revocation by construction, no JWKS table, and no
   `/api/auth/token` endpoint turning a session cookie into a bearer on instances that will never
   use MCP.

8. **Scopes are not permissions.** The OAuth scopes stay the standard four
   (`openid`/`profile`/`email`/`offline_access`) and decide nothing. What an agent may do is the
   token's Capabilities. **Capability** is deplo's word and **scope** is OAuth's; they must never
   share a variable.

## Considered options

- **Better Auth's built-in `mcp()` plugin**: rejected. It already serves Protected Resource Metadata
  and the right challenge, and it is installed, but it wraps `oidc-provider`, which Better Auth has
  deprecated with the warning silenced, so the migration cost is paid either way. Its helpers
  (`withMcpAuth`, `getMcpSession`) also bypass deplo's identity resolution entirely, never read
  `client.disabled`, and return the row including the refresh token. A test asserts they are
  imported nowhere.
- **One connection per team, several connectors**: rejected. It gives the same one-team-per-request
  property the design already has, while multiplying the tool surface by the number of teams (76
  tools per connection, so 304 for four), making a cross-team move impossible by construction - it
  needs authority on both sides, and, with the resource in the URL, requiring a per-team audience
  list that the plugin only reads at construction, so a team created after boot would not be
  connectable until a restart. Granting one team per connection is still available: it is what
  ticking one team does.
- **A separate `oauth_grants` table** linking a consent to its token: rejected. Every column it
  would need already exists on `api_tokens`; one nullable `oauth_client_id` column plus a partial
  unique index on `(oauth_client_id, user_id)` says the same thing and keeps one list answering
  "who can act in this team".
- **Better Auth's `referenceId`**: rejected as the carrier. It is populated by a callback that runs
  _before_ the consent form is filled in, so it cannot hold capabilities that have not been chosen
  yet, and it has no cascade.
- **JWT access tokens** (the plugin's default): rejected, see decision 7.
- **A "switch team" tool**: rejected, and it is the thing to reach for when a connection lands in the
  wrong team. There is nowhere to keep an active team between calls (the protocol is stateless), so
  such a tool could only rewrite the connection's own scope - an agent widening the credential it
  runs on, which is exactly why `createToken`/`updateToken` are not tools either. One connection,
  one team; a second team is a second connection.
- **A per-connection "allow writes" switch**: rejected - migration 0100's mistake in OAuth clothing.

## Consequences

- Four library-owned tables (`oauth_client`, `oauth_consent`, `oauth_access_token`,
  `oauth_refresh_token`, migration 0101) join the Better Auth group in `lib/db/schema/auth.ts`. They
  carry `text[]` columns and one `jsonb` - the two exemptions the Drizzle adapter forces
  (`supportsArrays`/`supportsJSON` are not configurable, and declaring `text` makes its inserts
  fail). The rule they bend holds everywhere else.
- **`proxy.ts` had to stop redirecting `/.well-known` to `/login`.** Its matcher excluded `/api` but
  not the discovery paths, so an unauthenticated probe was a 302 and no web client could have
  connected at all. The redirect also now preserves the query for `/oauth/…` only: losing it strands
  someone mid-flow inside a third-party product.
- The consent page lives at `app/oauth/consent`, **not** under `app/(auth)` - that layout redirects
  a signed-in user to the dashboard, which is everyone who reaches consent.
- **deplo mints; the BROWSER posts the consent.** Not a preference: `POST /oauth2/consent` funnels
  into the provider's `authorizeEndpoint`, which opens with
  `if (!ctx.request) throw UNAUTHORIZED("request not found")`, and an in-process
  `auth.api.*({ body, headers })` call has no `ctx.request` by construction. Calling it from a
  resolver fails every time, and fails with an `APIError` whose `message` is **empty**, the reason
  living in `body.error_description`, so a UI showing `e.message` shows an error notification with
  nothing written inside it. Both halves are pinned by a test that asserts the in-process call is
  refused, and one that drives register → sign in → authorize → mint → consent → exchange → tool
  call in production's own order. Anything that reaches `auth.api` from `lib/data/*` on this path is
  the same bug returning.
- **The issuer carries a path, and every document has to say so.** Better Auth builds its issuer as
  `<origin><basePath>`, so deplo's is `https://host/api/auth` and not the bare origin. RFC 8414 §3.3
  makes a client check the `issuer` it reads back against the identifier it built the discovery URL
  from, so advertising the origin made a conformant client refuse outright while a lenient one
  connected by luck. An issuer with a path also moves its metadata (§3.1 inserts the path after the
  well-known segment), which is why `/.well-known/oauth-authorization-server/api/auth` exists beside
  the root copy. `grant_types_supported` is narrowed to what deplo honours: `client_credentials` has
  no user, so it could never resolve to a connection.
- **`/api/mcp` rate-limits requests that never authenticate.** The per-token limit could not: it is
  keyed on a token, and discovery now tells the whole internet the endpoint is there. Registration
  gained a global ceiling beside its per-address limit, because `x-forwarded-for` is a header and an
  instance not behind a proxy that strips it hands out a fresh budget per request.
- **Better Auth's client-management surface is closed.** `clientPrivileges: () => false` - the hook
  is skipped for unauthenticated registration, which is the path a web client actually uses, so open
  DCR keeps working while `/oauth2/create-client` and friends stop answering to any signed-in
  session. deplo has no UI for them and never intended to expose one.
- **A trap worth knowing beyond this feature:** the Better Auth tables use plain `timestamp` WITHOUT
  a time zone (the one exemption `AGENTS.md` grants), and on a naive column the two writers disagree -
  a value the DRIVER writes round-trips as the same instant, while one SQL `now()` writes comes
  back shifted by the server's offset. Measured on a UTC+2 box: 7ms versus a full hour. So an age
  comparison on those columns must happen in JS against a driver-written value, never against SQL
  `now()`, and a test seeding them has to write them the way the application does or it will
  disagree with production for reasons unrelated to the code under test.
- The signed authorization query must survive the round trip **byte for byte**: the provider signs
  the whole query onto the consent URL, and it repeats `ba_param` once per signed parameter, which
  Next hands back as an array. `rebuildOauthQuery` lives in `lib/auth/oauth-query.ts` rather than
  inline in the page so a test can reach it, with a control asserting the mangled form IS refused.
- `app/api/mcp/route.ts` is now genuinely an OAuth resource server: its 401 carries
  `resource_metadata`, and it answers CORS preflights so a browser client can read the challenge.
  Its comment claiming deplo "is not an OAuth resource server" is gone.
- The route gained its first end-to-end tests. `lib/mcp/protocol.test.ts` started from a hand-built
  principal, so the kill switch, the rate limiter, the two-factor catch and the 401 body had never
  been asserted; `lib/mcp/route.test.ts` covers them and doubles as the regression net proving the
  `deplo_` path is unchanged.
- `disableSignUp` is asserted for the first time (`lib/auth/oauth-provider.test.ts`). It was named
  load-bearing in `lib/auth/better-auth.ts` and tested nowhere.
