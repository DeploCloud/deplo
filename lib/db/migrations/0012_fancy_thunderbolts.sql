CREATE TABLE "folder_grants" (
	"folder_id" text NOT NULL,
	"user_id" text NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "folder_grants_folder_id_user_id_capability_pk" PRIMARY KEY("folder_id","user_id","capability")
);
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "folder_grants" ADD CONSTRAINT "folder_grants_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_grants" ADD CONSTRAINT "folder_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folder_grants_user_idx" ON "folder_grants" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folders_owner_idx" ON "folders" USING btree ("owner_user_id");--> statement-breakpoint
-- Backfill ownership for folders created under the old `manage_team` gate: the
-- folder's team FOUNDER (teams.founder_user_id) becomes its owner — they held
-- `manage_team` and effectively controlled folders before per-folder ownership.
-- Fall back to the team's earliest `owner`-role member when no founder is
-- recorded; a team with neither leaves the folder owner NULL (= team-managed,
-- visible to manage_team / admins only), which is safe.
UPDATE "folders" f
SET "owner_user_id" = COALESCE(
  t."founder_user_id",
  (SELECT m."user_id" FROM "memberships" m
   WHERE m."team_id" = f."team_id" AND m."role" = 'owner'
   ORDER BY m."created_at" ASC, m."id" ASC LIMIT 1)
)
FROM "teams" t
WHERE t."id" = f."team_id" AND f."owner_user_id" IS NULL;