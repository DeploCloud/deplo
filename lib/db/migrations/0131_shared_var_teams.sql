-- ADR-0027: a shared variable reaches MANY teams, and the instance-global layer is
-- folded into it. 0131 creates + backfills, 0132 drops - split like 0027/0028 so a
-- parity test can replay to 0130 with the old tables still intact.

CREATE TABLE "shared_env_var_teams" (
	"var_id" text NOT NULL,
	"team_id" text NOT NULL,
	CONSTRAINT "shared_env_var_teams_var_id_team_id_pk" PRIMARY KEY("var_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "shared_env_var_teams" ADD CONSTRAINT "shared_env_var_teams_var_id_shared_env_vars_id_fk" FOREIGN KEY ("var_id") REFERENCES "shared_env_vars"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shared_env_var_teams" ADD CONSTRAINT "shared_env_var_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "shared_env_var_teams_team_idx" ON "shared_env_var_teams" USING btree ("team_id");
--> statement-breakpoint

ALTER TABLE "shared_env_vars" ALTER COLUMN "team_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "shared_env_vars" ADD COLUMN "auto_inject" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- (a) team_wide=true becomes ONE reach row, for its own team. Cardinality 1, so
-- ADR-0012 holds unchanged for them: it suggests, the per-app link still injects.
-- Filtered on team_wide on purpose - backfilling every row would promote every
-- project-scoped variable to team-wide.
INSERT INTO "shared_env_var_teams" ("var_id", "team_id")
SELECT v."id", v."team_id" FROM "shared_env_vars" v WHERE v."team_wide" = true;
--> statement-breakpoint
ALTER TABLE "shared_env_vars" DROP COLUMN "team_wide";
--> statement-breakpoint

-- (b) instance globals -> instance-owned shared vars. `auto_inject` is true
-- UNCONDITIONALLY, never "reaches > 1 team": a single-team instance has one reach
-- row, and a cardinality rule would stop injecting every global it has.
-- Deterministic source-tagged ids, 0027's pattern, tag `ig`.
INSERT INTO "shared_env_vars"
  ("id", "team_id", "key", "value_enc", "type", "auto_inject",
   "created_by_user_id", "updated_by_user_id", "created_at", "updated_at")
SELECT 'svar_' || substr(md5('ig:' || g."id"), 1, 16), NULL, g."key", g."value_enc",
       g."type", true, g."created_by_user_id", g."updated_by_user_id",
       g."created_at", g."updated_at"
FROM "instance_env_vars" g;
--> statement-breakpoint

INSERT INTO "shared_env_var_targets" ("var_id", "target")
SELECT 'svar_' || substr(md5('ig:' || t."env_var_id"), 1, 16), t."target"
FROM "instance_env_var_targets" t;
--> statement-breakpoint

-- A global with NO target row reached every runtime; the shared loader reads an
-- empty set the same way, but write them out so the two can never disagree.
INSERT INTO "shared_env_var_targets" ("var_id", "target")
SELECT 'svar_' || substr(md5('ig:' || g."id"), 1, 16), tt.target
FROM "instance_env_vars" g
CROSS JOIN (VALUES ('production'), ('preview')) AS tt(target)
WHERE NOT EXISTS (
  SELECT 1 FROM "instance_env_var_targets" t WHERE t."env_var_id" = g."id"
);
--> statement-breakpoint

-- (c) reach = every team that exists today. `createTeam` adds a row for every
-- instance-owned variable, so a team made tomorrow gets them too.
INSERT INTO "shared_env_var_teams" ("var_id", "team_id")
SELECT 'svar_' || substr(md5('ig:' || g."id"), 1, 16), t."id"
FROM "instance_env_vars" g CROSS JOIN "teams" t;
