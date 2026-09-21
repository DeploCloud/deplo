-- Better Auth 1.7.3 reverted the 1.7.0 account schema (0115) and keys an account
-- on (providerId, accountId) again. Nothing writes `issuer` now, and 1.7.3's
-- schema validation rejects every auth request while a column it never fills is
-- NOT NULL. https://www.better-auth.com/docs/guides/1-7-upgrade-guide
ALTER TABLE "account" DROP COLUMN IF EXISTS "issuer";
