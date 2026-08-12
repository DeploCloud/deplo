-- deplo becomes an OAuth 2.1 authorization server, so the MCP server can be
-- connected from a web AI client.
--
-- `/api/mcp` (ADR-0021) works with every terminal and IDE agent, because all of
-- them let you paste `Authorization: Bearer deplo_…`. claude.ai and chatgpt.com
-- have no such field: their connectors require the OAuth 2.1 flow the MCP spec
-- mandates — Protected Resource Metadata (RFC 9728), authorization server
-- metadata (RFC 8414), dynamic client registration (RFC 7591) and PKCE.
-- ADR-0021 recorded that as "deferred, not rejected"; this is it landing.
--
-- The four `oauth_*` tables belong to `@better-auth/oauth-provider`, which owns
-- every row in them, exactly as the `session`/`account`/`verification`/
-- `two_factor` tables of 0055 belong to Better Auth. Their column names come from
-- the plugin's own field list, and plain `timestamp` matches the rest of the
-- Better Auth tables rather than the control plane's `isoTimestamptz`.
--
-- Two house rules are bent here, ONLY here, and for a reason that is not a
-- preference. The Drizzle adapter sets `supportsArrays: true` and
-- `supportsJSON: true` for Postgres, so it hands raw JS arrays and objects to
-- Drizzle: a normalized junction table for `scopes`/`redirect_uris` cannot be
-- written by it at all, and `oauth_client.metadata` (RFC 7591 registration
-- metadata deplo never reads, queries or indexes) has to be `jsonb`. Nothing
-- outside the plugin writes these tables; the rules stay in force everywhere else.
--
-- Access and refresh tokens are stored HASHED with deplo's own `sha256Hex`, the
-- same digest `api_tokens.token_hash` uses — wired through the plugin's
-- `storeTokens` option, so a row here is never a usable credential.
--
-- `api_tokens.oauth_client_id` is the whole design in one column. Approving a
-- consent MINTS AN ORDINARY API TOKEN and the OAuth access token is only a
-- pointer at it, which is what keeps ADR-0021 §2 true: there is exactly one
-- authorization path, and every gate a `deplo_` token passes — the capability
-- clamp, the project scope, the two-factor policy, the fail-closed check that
-- the minter is still a member — applies unchanged. It also makes revocation
-- instant: delete the `api_tokens` row and the join that resolves an access
-- token returns nothing, whatever the token's own expiry says.
--
-- Table order matters: `oauth_client` first (three tables reference its unique
-- `client_id`), then `oauth_refresh_token` before `oauth_access_token`, which
-- references it.
--
-- One file, no DDL/backfill split: 0098 and 0099 were split because a backfill
-- reads tables a historical replay may not have created yet. There is nothing to
-- backfill here — four new tables and one nullable column with no default.
--
-- Note for the next person: this touches `api_tokens`, NOT `teams`/`users`/
-- `memberships`, so the hand-maintained `preSeed` predicates in
-- `notification-channels-migration.test.ts` and `shared-env-migration.test.ts`
-- need no change.

CREATE TABLE IF NOT EXISTS "oauth_client" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"disabled" boolean DEFAULT false,
	"skip_consent" boolean,
	"enable_end_session" boolean,
	"subject_type" text,
	"scopes" text[],
	"user_id" text,
	"created_at" timestamp,
	"updated_at" timestamp,
	"name" text,
	"uri" text,
	"icon" text,
	"contacts" text[],
	"tos" text,
	"policy" text,
	"software_id" text,
	"software_version" text,
	"software_statement" text,
	"redirect_uris" text[] NOT NULL,
	"post_logout_redirect_uris" text[],
	"token_endpoint_auth_method" text,
	"grant_types" text[],
	"response_types" text[],
	"public" boolean,
	"type" text,
	"require_pkce" boolean,
	"reference_id" text,
	"metadata" jsonb,
	CONSTRAINT "oauth_client_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "oauth_client_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_user_id_idx" ON "oauth_client" ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_refresh_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"reference_id" text,
	"expires_at" timestamp,
	"created_at" timestamp,
	"revoked" timestamp,
	"auth_time" timestamp,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_refresh_token_token_unique" UNIQUE("token"),
	CONSTRAINT "oauth_refresh_token_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE cascade,
	CONSTRAINT "oauth_refresh_token_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE set null,
	CONSTRAINT "oauth_refresh_token_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_client_id_idx" ON "oauth_refresh_token" ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_session_id_idx" ON "oauth_refresh_token" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_refresh_token_user_id_idx" ON "oauth_refresh_token" ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_access_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text,
	"client_id" text NOT NULL,
	"session_id" text,
	"user_id" text,
	"reference_id" text,
	"refresh_id" text,
	"expires_at" timestamp,
	"created_at" timestamp,
	"scopes" text[] NOT NULL,
	CONSTRAINT "oauth_access_token_token_unique" UNIQUE("token"),
	CONSTRAINT "oauth_access_token_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE cascade,
	CONSTRAINT "oauth_access_token_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "session"("id") ON DELETE set null,
	CONSTRAINT "oauth_access_token_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
	CONSTRAINT "oauth_access_token_refresh_id_fk" FOREIGN KEY ("refresh_id") REFERENCES "oauth_refresh_token"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_client_id_idx" ON "oauth_access_token" ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_session_id_idx" ON "oauth_access_token" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_user_id_idx" ON "oauth_access_token" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_token_refresh_id_idx" ON "oauth_access_token" ("refresh_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_consent" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text,
	"reference_id" text,
	"scopes" text[] NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp,
	CONSTRAINT "oauth_consent_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "oauth_client"("client_id") ON DELETE cascade,
	CONSTRAINT "oauth_consent_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_consent_client_id_idx" ON "oauth_consent" ("client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_consent_user_id_idx" ON "oauth_consent" ("user_id");--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "oauth_client"("client_id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_tokens_oauth_client_user_uq" ON "api_tokens" ("oauth_client_id","user_id") WHERE "oauth_client_id" IS NOT NULL;
