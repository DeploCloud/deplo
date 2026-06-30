ALTER TABLE "teams" ADD COLUMN "founder_user_id" text;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_founder_user_id_users_id_fk" FOREIGN KEY ("founder_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Backfill the founder (absolute owner / "crown") for teams created before this
-- column existed: the EARLIEST `owner` membership of each team is its founder
-- (the original creator), tie-broken by membership id for determinism. Teams
-- with no owner membership (should not occur) keep a NULL founder.
UPDATE "teams" t SET "founder_user_id" = sub.user_id
FROM (
  SELECT DISTINCT ON (m.team_id) m.team_id, m.user_id
  FROM "memberships" m
  WHERE m.role = 'owner'
  ORDER BY m.team_id, m.created_at ASC, m.id ASC
) sub
WHERE t.id = sub.team_id AND t."founder_user_id" IS NULL;