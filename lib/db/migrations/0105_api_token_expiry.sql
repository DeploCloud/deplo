-- Give an API token an optional expiry.
--
-- Until now a `deplo_` token lived until somebody revoked it, and nothing ever
-- made anybody. A credential that is pasted into a CI secret, a webhook sender
-- and two laptops is exactly the one that outlives the job it was minted for,
-- and "how do I take this access away" then depends on remembering it exists.
--
-- NULL is "never", which is what every existing token keeps: this must not
-- expire a fleet's automation on the migration that adds the column. The choice
-- is made per token when it is minted (or edited), and the enforcement is one
-- comparison in `identityForTokenRow` - the same place the membership and
-- two-factor checks already fail closed - so an expired token stops resolving
-- everywhere at once: GraphQL, MCP, the deploy hook.
--
-- No sweep job: the row stays, visibly expired, until its owner deletes it. A
-- credential that vanished on its own is one nobody can explain afterwards, and
-- the tokens page needs the row to say "this expired on Tuesday".

ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
