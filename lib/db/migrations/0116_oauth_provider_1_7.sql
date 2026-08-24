-- Better Auth 1.6.29 -> 1.7.1, the OAuth half. `account.issuer` is 0115; this is
-- everything the `@better-auth/oauth-provider` bump needs, and it is a separate
-- file so 0115 stays a single additive ALTER the partial-replay migration tests
-- can pull forward (see the note there).
--
-- The bump is not optional: GHSA-p2fr-6hmx-4528 (moderate) affects every
-- `@better-auth/oauth-provider` from 1.4.8 up to 1.7.0-beta.4. The plugin
-- validated the RFC 8707 `resource` parameter but never BOUND it to the grant,
-- so an authorization server with two or more valid audiences could hand a
-- client a token aimed at a resource server it was never authorized for. deplo
-- was never exposed - it declares exactly one audience, which is what the
-- advisory's own workaround recommends - but the fix is the version, and the
-- version needs this schema.

--------------------------------------------------------------------------------
-- 1. oauth_client - `type` + `public` become `application_type`.
--------------------------------------------------------------------------------
-- Not a rename. In 1.7.0 `token_endpoint_auth_method` ALONE decides whether a
-- client is confidential ("none" = public, anything else = confidential), and
-- `application_type` decides which redirect URIs are legal. The old `public`
-- flag answered the first question and must NEVER be used to derive the second -
-- the two are unrelated, and conflating them would hand a native client web
-- redirect rules (HTTPS on a non-loopback host) that it cannot satisfy.
--
-- `user-agent-based` has no 1.7.0 equivalent and the upgrade guide says to leave
-- it NULL for manual reclassification. A NULL `type` predates the column being
-- populated at all and takes `web`, which is what 1.7.0 itself defaults an
-- omitted `application_type` to for a dynamic registration.
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "application_type" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "jwks" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "jwks_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "backchannel_logout_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "backchannel_logout_session_required" boolean;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "client_credentials_scopes" text[] DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "client_discovery_id" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN IF NOT EXISTS "dpop_bound_access_tokens" boolean DEFAULT false;--> statement-breakpoint
UPDATE "oauth_client" SET "application_type" = "type" WHERE "application_type" IS NULL AND "type" IN ('web', 'native');--> statement-breakpoint
UPDATE "oauth_client" SET "application_type" = 'web' WHERE "application_type" IS NULL AND "type" IS NULL;--> statement-breakpoint

-- Machine-to-machine authority DENIES on missing, NULL and empty alike. deplo
-- does not advertise `client_credentials` at all, so every existing row is
-- backfilled to the empty array: the explicit "approved for nothing" rather than
-- the ambiguous NULL.
UPDATE "oauth_client" SET "client_credentials_scopes" = '{}' WHERE "client_credentials_scopes" IS NULL;--> statement-breakpoint

-- A client with no consent and no token of either kind is a registration that
-- never completed: it holds nothing, reaches no team and appears nowhere. Rather
-- than guess an `application_type` for a dead row - and rather than leave one
-- that 1.7.0's stricter redirect-URI validation may refuse anyway - it goes.
-- Registration is open by necessity here (claude.ai and ChatGPT cannot
-- pre-register), so a client that still wants in simply registers again.
DELETE FROM "oauth_client" c
 WHERE NOT EXISTS (SELECT 1 FROM "oauth_consent" x WHERE x."client_id" = c."client_id")
   AND NOT EXISTS (SELECT 1 FROM "oauth_access_token" x WHERE x."client_id" = c."client_id")
   AND NOT EXISTS (SELECT 1 FROM "oauth_refresh_token" x WHERE x."client_id" = c."client_id");--> statement-breakpoint

ALTER TABLE "oauth_client" DROP COLUMN IF EXISTS "type";--> statement-breakpoint
ALTER TABLE "oauth_client" DROP COLUMN IF EXISTS "public";--> statement-breakpoint

--------------------------------------------------------------------------------
-- 2. The grant now CARRIES its audiences, and resources become rows.
--------------------------------------------------------------------------------
-- This is the actual fix for the advisory: `resources` on the token and consent
-- rows is the binding that was missing. Existing rows stay NULL, which is
-- correct - they were issued under the old model and there are no live ones on
-- an instance that has not connected an AI client.
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "rotated_at" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "rotation_replay_response" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "rotation_replay_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;--> statement-breakpoint

ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "authorization_code_id" text;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "revoked" timestamp;--> statement-breakpoint
ALTER TABLE "oauth_access_token" ADD COLUMN IF NOT EXISTS "confirmation" jsonb;--> statement-breakpoint

ALTER TABLE "oauth_consent" ADD COLUMN IF NOT EXISTS "resources" text[];--> statement-breakpoint
ALTER TABLE "oauth_consent" ADD COLUMN IF NOT EXISTS "requested_user_info_claims" text[];--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "oauth_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"name" text NOT NULL,
	"access_token_ttl" integer,
	"refresh_token_ttl" integer,
	"signing_algorithm" text,
	"signing_key_id" text,
	"allowed_scopes" text[],
	"custom_claims" jsonb,
	"dpop_bound_access_tokens_required" boolean DEFAULT false,
	"disabled" boolean DEFAULT false,
	"created_at" timestamp,
	"updated_at" timestamp,
	"policy_version" integer DEFAULT 1,
	"metadata" jsonb,
	CONSTRAINT "oauth_resource_identifier_unique" UNIQUE("identifier")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "oauth_client_resource" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp
);--> statement-breakpoint

-- The `jti` replay cache for `private_key_jwt`. Empty on every deplo instance -
-- no client here authenticates with a signed assertion - but the adapter
-- resolves a model to `schema[modelName]`, so a table the plugin declares and
-- the schema omits is a crash, not an unused table.
CREATE TABLE IF NOT EXISTS "oauth_client_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL
);--> statement-breakpoint

ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_client_id_oauth_client_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_client"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_resource" ADD CONSTRAINT "oauth_client_resource_resource_id_oauth_resource_identifier_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."oauth_resource"("identifier") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "oauth_client_resource_client_resource_key" ON "oauth_client_resource" USING btree ("client_id","resource_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_client_resource_resource_id_idx" ON "oauth_client_resource" USING btree ("resource_id");
