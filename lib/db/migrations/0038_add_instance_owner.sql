-- Instance owner — a SINGLETON row (PK fixed at 'default'), the shape of
-- monitoring_settings / docker_cleanup_policy, carrying the one thing that was
-- missing from this schema: who owns the instance.
--
-- WHY. `users.is_instance_admin` is a flat boolean, and updateUserAdmin lets any
-- instance admin write it on any OTHER user. The only guard was "at least one
-- ACTIVE admin must remain" — an invariant the actor satisfies by being that
-- admin. So a single admin you promoted could, in one call per peer, demote every
-- other admin (the very first account included, which had no protection of any
-- kind), suspend them so login fails, and reset their password hash — taking the
-- account outright. There is no user-deletion path and no self-service password
-- reset in the product, so the victim's only way back was hand-written SQL against
-- Postgres: exactly the "you must know the shell" failure the core mission exists
-- to prevent.
--
-- The fix mirrors a decision this schema already made one level down. A team has
-- an absolute owner in `teams.founder_user_id` (the "crown", migration 0011) who
-- cannot be demoted or removed by anyone, instance admins included. This is that,
-- for the instance: the owner is immutable to every hand but their own — no other
-- admin may demote, suspend or password-reset them — and they cannot clear their
-- own admin flag either, matching the founder rule. The crown is not a dead end:
-- it TRANSFERS, but only by the person wearing it.
--
-- Naming: `owner`, not `founder` and not `root`. "Founder" is taken by the
-- team-level crown and reusing it across two scopes would be genuinely ambiguous;
-- "root" is taken by Unix root, which this product talks about constantly (root
-- filesystem headroom, devuser not being root-PID-1, and the host-side recovery
-- CLI that literally runs as root). "Instance owner" sits next to the
-- "instance admin" this schema already uses, and reads as the tier above it.
--
-- NO `ON DELETE` action on the FK, deliberately diverging from
-- `teams.founder_user_id`'s `SET NULL`: nothing in the product deletes a user, and
-- if that ever changes, orphaning the crown should be a loud FK error rather than
-- a silent return to the unowned state this row exists to end.
--
-- BACKFILL: the oldest instance admin, which on every real instance is the account
-- created by first-run setup — the same shape as 0011 backfilling each team's
-- founder to its earliest owner membership. `LIMIT 1` because the row is a
-- singleton; `WHERE EXISTS` so an instance with no admin at all (impossible via
-- the app, reachable via hand-edited SQL) gets no row instead of a NULL-owner one.
-- A missing row is legal and means "unowned".
--
-- Hand-authored: this repo's committed drizzle snapshots stop at 0014, so
-- `drizzle-kit generate` cannot diff against an up-to-date base. The SQL + journal
-- entry are what the boot migrator (lib/db/migrate.ts) and the pglite tests
-- actually replay, matching every migration since 0015.
CREATE TABLE IF NOT EXISTS "instance_settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"owner_user_id" text,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
INSERT INTO "instance_settings" ("id", "owner_user_id", "updated_at")
SELECT 'default', u."id", now()
  FROM "users" u
 WHERE u."is_instance_admin" = true
 ORDER BY u."created_at" ASC
 LIMIT 1
ON CONFLICT ("id") DO NOTHING;
