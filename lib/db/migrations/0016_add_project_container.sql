-- ADR-0008 Phase 2: the Project CONTAINER — a top-level, team-scoped, folder-like
-- grouping that will own Environments (Phase 3). Purely additive: folders and
-- services gain a NULLABLE project_id, so existing top-level items are untouched.
-- Table/junction names (projects, team_project_order) were freed by 0015.

-- 0015 renamed the tables but not their PK constraints, so the old PK *indexes*
-- (schema-global relation names) still sit on the renamed tables and would clash
-- with the reclaimed container names. Rename them to their proper new names
-- (RENAME CONSTRAINT also renames the backing PK index) before reusing the names.
ALTER TABLE "services" RENAME CONSTRAINT "projects_pkey" TO "services_pkey";--> statement-breakpoint
ALTER TABLE "team_service_order" RENAME CONSTRAINT "team_project_order_team_id_project_id_pk" TO "team_service_order_team_id_service_id_pk";--> statement-breakpoint

CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"color" text,
	"owner_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_grants" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "project_grants_project_id_user_id_capability_pk" PRIMARY KEY("project_id","user_id","capability")
);
--> statement-breakpoint
CREATE TABLE "team_project_order" (
	"team_id" text NOT NULL,
	"project_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "team_project_order_team_id_project_id_pk" PRIMARY KEY("team_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_project_order" ADD CONSTRAINT "team_project_order_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_project_order" ADD CONSTRAINT "team_project_order_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_team_slug_uq" ON "projects" USING btree ("team_id","slug");--> statement-breakpoint
CREATE INDEX "projects_owner_idx" ON "projects" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "project_grants_user_idx" ON "project_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "folders_project_idx" ON "folders" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "services_project_idx" ON "services" USING btree ("project_id");
