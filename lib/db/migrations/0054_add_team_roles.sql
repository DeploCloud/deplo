-- Roles become first-class, per-team rows instead of three hardcoded presets.
--
-- Before this, "role" was a label on a membership (owner/member/viewer) and the
-- capability set behind it lived only in TypeScript (CAPABILITY_PRESETS). A team
-- could not rename a role, change what it grants, or invent one of its own - every
-- deviation showed up as a per-member "Custom" set nobody could reuse.
--
-- `team_roles` gives each team its own three built-ins (`builtin_key`, revertible
-- to their preset, never deletable) plus any number of custom roles it authors.
-- `memberships.role_id` is the assignment. What every authorization check reads is
-- UNCHANGED: `membership_capabilities` stays the effective set, and editing a role
-- re-writes those rows for its members inside the same transaction, so this
-- migration alters no permission, and a control plane rolled back to the previous
-- version still enforces exactly what it did before.
--
-- Deliberately no backfill: `ensureTeamRoles()` (lib/data/roles.ts) seeds a team's
-- three built-ins and links the memberships whose capability set matches one of
-- them, on first read, idempotently. That keeps the set-comparison in tested
-- TypeScript rather than in one-shot SQL, and self-heals a team created by any
-- other path. A membership left with `role_id` NULL is a hand-picked "Custom" set -
-- legal, still enforced, and shown as such.
CREATE TABLE "team_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"builtin_key" text,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "team_roles_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade
);
--> statement-breakpoint
-- One row per built-in per team; custom roles (NULL key) escape the predicate.
CREATE UNIQUE INDEX "team_roles_builtin_uq" ON "team_roles" ("team_id","builtin_key") WHERE "builtin_key" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "team_roles_name_uq" ON "team_roles" ("team_id",lower("name"));
--> statement-breakpoint
CREATE TABLE "team_role_capabilities" (
	"role_id" text NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "team_role_capabilities_role_id_capability_pk" PRIMARY KEY("role_id","capability"),
	CONSTRAINT "team_role_capabilities_role_id_team_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "team_roles"("id") ON DELETE cascade
);
--> statement-breakpoint
-- RESTRICT, not SET NULL: a role with members must not be deletable out from under
-- them (the data layer refuses first, naming how many members still hold it).
ALTER TABLE "memberships" ADD COLUMN "role_id" text REFERENCES "team_roles"("id") ON DELETE restrict;
