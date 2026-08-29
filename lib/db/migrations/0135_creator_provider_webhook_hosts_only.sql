-- 0133 read the backfill off `apps.repo_provider`, which also holds `git` - a plain
-- remote with no API and no webhook, so a row it marked cannot have come from a push:
-- it is a deploy by somebody whose account was renamed or deleted. Take those back.
UPDATE "deployments"
SET "creator_provider" = NULL
WHERE "creator_provider" IS NOT NULL
  AND "creator_provider" NOT IN ('github', 'gitlab', 'bitbucket', 'gitea');
