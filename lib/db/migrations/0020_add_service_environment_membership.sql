-- ADR-0009: Projects are "advanced folders" — a project's CONTENTS are scoped
-- per Environment (each environment holds its OWN services, like a sub-folder,
-- selected via a dropdown on the Overview drill-in). This adds the membership
-- axis: `services.environment_id`, the environment a service LIVES in. NULL
-- outside a project; the data layer keeps (project_id, environment_id) coherent.

ALTER TABLE "services" ADD COLUMN "environment_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "services_environment_idx" ON "services" USING btree ("environment_id");--> statement-breakpoint
-- Reconcile pre-0020 DUAL-membership rows to the one-home model first: the old
-- container model allowed folder_id AND project_id together; under ADR-0009 the
-- folder wins (matching moveServiceToFolder, which now pulls a service out of
-- its project when filing it into a folder).
UPDATE "services"
SET "project_id" = NULL
WHERE "folder_id" IS NOT NULL
  AND "project_id" IS NOT NULL;--> statement-breakpoint
-- Backfill: services already attached to a project (the pre-0020 container
-- model had no environment membership) land in that project's DEFAULT
-- environment, so nothing disappears from the project view.
UPDATE "services" s
SET "environment_id" = e."id"
FROM "environments" e
WHERE s."project_id" IS NOT NULL
  AND s."environment_id" IS NULL
  AND e."project_id" = s."project_id"
  AND e."is_default";
