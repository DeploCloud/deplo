-- Registration links can be copied again after they are created.
--
-- The token was only ever stored hashed, so a link the admin lost was gone for
-- good — mint another one. Keep the hash (it is what the register page looks up,
-- and what makes a link single-use) and add the encrypted token beside it, read
-- back only through the instance-admin `revealRegistrationLink`.
--
-- Nullable on purpose: links minted before this column keep working, they simply
-- cannot be shown again.
ALTER TABLE "registration_links" ADD COLUMN IF NOT EXISTS "token_enc" text;
