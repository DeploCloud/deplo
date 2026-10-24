ALTER TABLE "app_build" ADD COLUMN "build_method_auto" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app_build_method_settings" ADD COLUMN "compose_file" text;--> statement-breakpoint
-- Railpack is the one builder now. A nixpacks app that served a folder keeps serving it, as Railpack's output folder.
UPDATE "app_build" SET "output_directory" = s."nixpacks_publish_directory"
FROM "app_build_method_settings" s
WHERE s."app_id" = "app_build"."app_id" AND "app_build"."build_method" = 'nixpacks'
	AND coalesce(trim(s."nixpacks_publish_directory"), '') <> '' AND "app_build"."output_directory" IS NULL;--> statement-breakpoint
UPDATE "app_build" SET "build_method" = 'railpack' WHERE "build_method" IN ('nixpacks', 'static', 'heroku', 'paketo');
--> statement-breakpoint
-- A repository or upload app's compose column now means "the stack its source carries". It was never read for
-- one before; a github/git row with no repository kept its YAML as a pasted stack and is left alone.
UPDATE "apps" SET "compose" = NULL WHERE "compose" IS NOT NULL AND ("source" = 'upload' OR ("source" IN ('github', 'git') AND "repo_url" IS NOT NULL));
