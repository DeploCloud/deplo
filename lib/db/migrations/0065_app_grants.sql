-- The App rung of the node-grant ladder (ADR-0016), plus the index the per-user
-- activity feed needs.
--
-- `app_grants` is the level that was missing: `folder_grants` has been live since
-- folders got owners, `project_grants` has been in the schema (unused) since the
-- Project container landed, and an App - the thing people actually want to hand
-- someone one of - had nothing. It is the direct clone of both: one row per
-- (app, user, capability), both FKs CASCADE, so dropping the app or the account
-- drops the grant. That cascade IS the cleanup story, and it is why these stay
-- three tables rather than one polymorphic `(node_kind, node_id)` one.
--
-- Unlike a folder grant this one never makes anything VISIBLE: every member of a
-- team can already see every app, so an app grant only says what the holder may
-- DO to that one app.
CREATE TABLE "app_grants" (
	"app_id" text NOT NULL,
	"user_id" text NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "app_grants_app_id_user_id_capability_pk" PRIMARY KEY("app_id","user_id","capability"),
	CONSTRAINT "app_grants_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "apps"("id") ON DELETE cascade,
	CONSTRAINT "app_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX "app_grants_user_idx" ON "app_grants" ("user_id");
--> statement-breakpoint
-- "What has this person done?" is now a question an account's admin page asks,
-- across every team. Without this the feed seq-scans the whole activity history:
-- the two existing indexes are keyed by team and by app.
CREATE INDEX "activities_actor_created_idx" ON "activities" ("actor_user_id","created_at" DESC);
