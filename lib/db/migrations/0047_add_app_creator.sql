-- Who created an app. Needed by exactly one flow: permanently deleting a user
-- account (Settings → Users), where the operator can tick "also delete the apps
-- they created". Without the column that checkbox could only ever be a guess.
--
-- Nullable + `ON DELETE SET NULL`, like every other authorship column here (0029,
-- 0045): the migrator runs at boot against live self-hosted DBs whose `apps` is
-- non-empty, and — more importantly — deleting a user must NEVER, on its own,
-- delete an app the team still runs. Destroying a live stack is the operator's
-- explicit choice, not a cascade's.
--
-- BACKFILLED, unlike 0045 — and it is not a fabricated claim. It reads the
-- recorded creation EVENT: the `activities` row that `createApp` writes for this
-- exact app id. `activities.actor_user_id` is only ever set when the actor string
-- matched the user making the request (see resolveActorUserId), so a non-null
-- value there is a real attribution, not an inference. Apps whose creation
-- predates activity attribution (0029 does not backfill it) keep NULL and simply
-- never show up under "apps they created".
ALTER TABLE "apps" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The SET NULL above must not sequentially scan `apps` on every user delete.
CREATE INDEX IF NOT EXISTS "apps_created_by_idx" ON "apps" ("created_by_user_id");--> statement-breakpoint
UPDATE "apps" AS a
SET "created_by_user_id" = c."actor_user_id"
FROM (
  SELECT DISTINCT ON ("app_id") "app_id", "actor_user_id"
  FROM "activities"
  WHERE "app_id" IS NOT NULL
    AND "actor_user_id" IS NOT NULL
    AND "type" = 'app'
    AND "message" LIKE 'Created project %'
  ORDER BY "app_id", "created_at" ASC, "seq" ASC
) AS c
WHERE a."id" = c."app_id" AND a."created_by_user_id" IS NULL;
