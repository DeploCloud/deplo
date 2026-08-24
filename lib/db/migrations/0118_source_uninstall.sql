-- Taking Deplo's agent back off a migration source, retried by the system.
--
-- Finishing a migration already uninstalled the agent from the host it read, but
-- the three attempts lived inside one HTTP request: a host that was still busy
-- with the last volume copy, or a process that died mid-finish, ended with the
-- agent still installed and a card asking a person to press the button. It also
-- never tried at all when whoever closed the migration was not an instance admin,
-- which is the common case in a team.
--
-- The intent is durable now, on the row that has to die. `uninstall_next_at` set
-- means Deplo is still trying; NULL with a non-empty `uninstall_error` means it
-- gave up, and that is the only state a person is asked about. Success deletes
-- the row, which drops the intent with it.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "uninstall_next_at" timestamptz;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "uninstall_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "uninstall_error" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "uninstall_run_id" text;
