-- Root-directory build options on `service_build`:
--   - include_files_outside_root   whether files OUTSIDE the root directory are
--                                  part of the build context (monorepo shared
--                                  packages). Default TRUE — the whole repo is
--                                  available to the build.
--   - skip_unchanged_deployments   skip an auto-deploy when an inbound push left
--                                  the root directory untouched. Default FALSE.
-- Purely additive: existing rows get the defaults (no behaviour change).
ALTER TABLE "service_build" ADD COLUMN "include_files_outside_root" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "service_build" ADD COLUMN "skip_unchanged_deployments" boolean DEFAULT false NOT NULL;
