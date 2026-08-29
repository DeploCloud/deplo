-- The trail says who acted, and a webhook push is an account on a git host, not a
-- member here: the host it belongs to, so the row shows that mark instead of a bare
-- name. NULL ⇒ a person on this instance (or an actor with no host, like `system`).
ALTER TABLE "activities" ADD COLUMN IF NOT EXISTS "actor_provider" text;
--> statement-breakpoint

-- Read back off the deployments, which already carry the answer (0133): an actor
-- that pushed to THIS app is that push's account, whatever else it looks like.
UPDATE "activities" a
SET "actor_provider" = (
  SELECT min(d."creator_provider") FROM "deployments" d
  WHERE d."app_id" = a."app_id"
    AND d."creator" = a."actor"
    AND d."creator_provider" IS NOT NULL
)
WHERE a."actor_provider" IS NULL
  AND a."actor_user_id" IS NULL
  AND a."app_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "deployments" d
    WHERE d."app_id" = a."app_id"
      AND d."creator" = a."actor"
      AND d."creator_provider" IS NOT NULL
  );
