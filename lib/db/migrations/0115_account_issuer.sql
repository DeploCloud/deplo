-- Better Auth 1.6.29 -> 1.7.1, the identity half.
--
-- The bump is not optional: GHSA-p2fr-6hmx-4528 (moderate) affects every
-- `@better-auth/oauth-provider` from 1.4.8 up to 1.7.0-beta.4. The plugin
-- validated the RFC 8707 `resource` parameter but never BOUND it to the grant,
-- so an authorization server with two or more valid audiences could hand a
-- client a token aimed at a resource server it was never authorized for. deplo
-- was never exposed - it declares exactly one audience, which is what the
-- advisory's own workaround recommends - but the fix is the version, and the
-- version needs this schema.
--
-- This half is ONLY `account.issuer` - the one change that can lock every person
-- out of their own instance. It is split from the OAuth half (0116) for the same
-- reason 0098 was split from 0099: the two partial-replay migration tests
-- (lib/db/{shared-env,notification-channels}-migration.test.ts) seed identity at
-- an OLD schema point through `seedIdentity`, which writes this column. A file
-- they can pull forward has to be one additive, self-contained ALTER - not one
-- that also drops columns and creates tables.

--------------------------------------------------------------------------------
-- account.issuer - REQUIRED, and load-bearing on the sign-in path.
--------------------------------------------------------------------------------
-- 1.7.0 keys an account on `(issuer, accountId)` rather than on `providerId`
-- alone, because two upstream authorities can issue the same subject id and the
-- second one used to land on the first one's row.
--
-- The sign-in path compares the value EXACTLY:
--
--   accounts.find(a => a.providerId === "credential"
--                   && a.issuer === createLocalAccountIssuer("credential")
--                   && a.accountId === user.id)
--
-- so a row whose issuer is NULL, empty, or spelled any other way is a password
-- that silently stops matching. That is why the column is backfilled with the
-- library's own literal before it is made NOT NULL, and why there is no DEFAULT:
-- a default would let a future INSERT that forgets the field look correct and
-- fail at login instead of at the write.
--
-- `local:credential` is `createLocalAccountIssuer("credential")` verbatim
-- (@better-auth/core/db). deplo configures NO social providers - every row in
-- this table is a password - so the second UPDATE is theoretical and exists only
-- so an instance that grew one out of band is not left with a NULL that fails
-- the NOT NULL below. Its value is `createOAuthAccountIssuer(providerId)`.
ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text;--> statement-breakpoint
UPDATE "account" SET "issuer" = 'local:credential' WHERE "issuer" IS NULL AND "provider_id" = 'credential';--> statement-breakpoint
UPDATE "account" SET "issuer" = 'local:oauth:' || "provider_id" WHERE "issuer" IS NULL;--> statement-breakpoint
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;
