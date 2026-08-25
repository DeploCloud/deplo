-- Two-factor authentication, by making Better Auth the LIVE login path.
--
-- Better Auth has shipped in this repo since 0000 but was never live: its config
-- carried `plugins: []`, its four tables (user/session/account/verification) stayed
-- empty, and the only thing that ever read them was `/api/auth/[...all]`. Login was
-- a hand-rolled stateless HMAC cookie (`deplo_session`) over the control-plane
-- `users` table. Its `twoFactor` plugin binds to Better Auth's own user/session
-- models, so 2FA and a dead auth library could not coexist: one of them had to go.
-- ADR-0014 records the decision to keep the library and retire the hand-rolled path.
--
-- What that costs, stated plainly: the session cookie changes name and becomes a DB
-- row, so EVERY user is signed out once when this lands. Nobody has to reset a
-- password - the backfill below hands Better Auth the existing scrypt hashes, and
-- `emailAndPassword.password.{hash,verify}` is wired to the same
-- `hashPassword`/`verifyPassword` that produced them (lib/crypto.ts).
--
-- The join is done by REMAPPING, not by copying: `users` becomes Better Auth's
-- `user` model (`user: { modelName: "users" }`), so `users.id` stays the identity
-- every FK in the control plane already points at. Nothing is migrated between two
-- user tables, because there is only ever one. The empty `user` table is dropped and
-- the three tables that referenced it are recreated against `users(id)`.
--
-- `password_hash` is dropped rather than dual-written: `account.password` becomes
-- the single source of truth, and two columns holding the same credential is one
-- more place to forget on the next password-touching change.
--
-- `token_version` is deliberately LEFT IN PLACE though nothing reads it after this.
-- Session revocation becomes "delete the user's session rows", which the DB now
-- makes possible; dropping the column belongs in its own migration once a release
-- has proven the new path, so a rollback to the previous control plane still finds
-- the schema it expects.
--
-- The two policy flags (`teams.require_two_factor`, `team_roles.require_two_factor`)
-- ride along because they share the feature, not the mechanism: both default false,
-- so this migration turns nothing on for anyone. `team_roles` is 0054's table and is
-- altered here rather than there so this applies cleanly whether or not an instance
-- has already run 0054.

ALTER TABLE "users" ADD COLUMN "email_verified" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- All four are empty (nothing ever wrote them), so this drops no data. Order matters:
-- the three dependents reference "user".
DROP TABLE IF EXISTS "verification";--> statement-breakpoint
DROP TABLE IF EXISTS "account";--> statement-breakpoint
DROP TABLE IF EXISTS "session";--> statement-breakpoint
DROP TABLE IF EXISTS "user";--> statement-breakpoint

CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token"),
	CONSTRAINT "session_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint

CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "account_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint

CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- The twoFactor plugin's own table. `secret` and `backup_codes` are ciphertext
-- (the plugin encrypts both with the Better Auth secret, which deplo derives from
-- DEPLO_SECRET), so rotating DEPLO_SECRET now also orphans enrolled authenticators,
-- on top of the `*_enc` / session / agent-CA blast radius it already had.
-- `failed_verification_count` + `locked_until` are the plugin's built-in brute-force
-- lockout, which is why deplo hand-rolls no attempt counter of its own.
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp,
	CONSTRAINT "two_factor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX "two_factor_user_id_idx" ON "two_factor" ("user_id");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" ("secret");--> statement-breakpoint

-- Hand every existing account to Better Auth with its password intact. `account_id`
-- is the provider's own subject id, which for the credential provider is the user id.
INSERT INTO "account" ("id", "user_id", "account_id", "provider_id", "password", "created_at", "updated_at")
SELECT 'bacc_' || md5("id"), "id", "id", 'credential', "password_hash", now(), now() FROM "users";--> statement-breakpoint

ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint

ALTER TABLE "teams" ADD COLUMN "require_two_factor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_roles" ADD COLUMN "require_two_factor" boolean DEFAULT false NOT NULL;
