-- Passkeys: one WebAuthn credential per row, owned by `@better-auth/passkey`.
--
-- Why the table exists: an account could prove itself with a password and,
-- optionally, a TOTP code. A passkey replaces both with a credential the device
-- holds and biometry or a PIN unlocks — unphishable by construction, because the
-- browser refuses to hand it to any origin but the one it was minted for.
--
-- The plugin owns every row here, exactly as the `session`/`account`/
-- `verification`/`two_factor` tables of 0055 and the four `oauth_*` tables of
-- 0101 belong to their plugins. Column names come from the plugin's own field
-- list, and plain `timestamp` matches the rest of the Better Auth tables rather
-- than the control plane's `isoTimestamptz`.
--
-- `credential_id` is UNIQUE, which the plugin's own schema does not declare (it
-- asks only for an index). The authentication path resolves a credential with
-- `findOne({credentialID})`, so a duplicate would make WHICH account a passkey
-- signs in depend on row order. That is not a constraint worth leaving to the
-- application.
--
-- `name` is nullable because the plugin writes `undefined` when the client sent
-- no label. deplo always sends one (prefilled from the browser's user agent),
-- but the column has to allow the shape the library can produce.
--
-- One thing this migration does NOT do: give the `users` row a flag. A passkey's
-- existence is the flag — `lib/membership.ts` asks `exists (select 1 from
-- passkey …)` when it decides whether a member satisfies a team's two-factor
-- mandate. A denormalized boolean would be one more thing to keep true.
--
-- Note for the next person: this touches neither `teams`/`users`/`memberships`
-- nor `api_tokens`, so the hand-maintained `preSeed` predicates in
-- `notification-channels-migration.test.ts` and `shared-env-migration.test.ts`
-- need no change. `lib/db/schema.test.ts` does: "passkey" joins PRE_EXISTING.

CREATE TABLE IF NOT EXISTS "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text,
	CONSTRAINT "passkey_credential_id_unique" UNIQUE ("credential_id"),
	CONSTRAINT "passkey_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_user_id_idx" ON "passkey" ("user_id");
