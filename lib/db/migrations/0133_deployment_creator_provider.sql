-- A webhook push credits a git account, not a deplo one: the host it belongs to,
-- so the UI can show that mark and link the profile instead of hunting for a user
-- who does not exist here. NULL ⇒ a person on this instance (or an old row).
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "creator_provider" text;
--> statement-breakpoint

-- Existing history predates the column, so it is read back off the only evidence
-- left: a creator nobody here answers to, on an app wired to a repository.
-- ponytail: a member RENAMED since their deploy reads as a push; cosmetic, and the
-- rows written from now on carry the truth.
UPDATE "deployments" d
SET "creator_provider" = a."repo_provider"
FROM "apps" a
WHERE d."app_id" = a."id"
  AND d."creator_provider" IS NULL
  AND d."creator_user_id" IS NULL
  AND a."repo_provider" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "users" u
    WHERE u."name" = d."creator" OR u."username" = d."creator"
  );
