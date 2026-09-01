-- What the provider says the stored token is allowed to do, space-separated.
-- Empty means it does not report scopes (Bitbucket, Gitea), which is why a
-- missing-access warning is never raised from an empty value.
ALTER TABLE "git_connections" ADD COLUMN IF NOT EXISTS "token_scopes" text DEFAULT '' NOT NULL;
