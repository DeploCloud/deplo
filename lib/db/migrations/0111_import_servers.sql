-- A server registered ONLY to import from another platform.
--
-- Migrating off another platform needs an agent on THAT platform's host: a volume
-- is copied by the agent standing on the disk that holds it, and agents cannot
-- dial each other. So the import wizard installs one there - and until now that
-- host became an ordinary member of the fleet the moment it was registered:
-- offered as a deploy target and as a BUILD target (which ships source and
-- decrypted env to it), swept by docker cleanup, eligible as a backup
-- destination, counted in the fleet. It is somebody else's machine.
--
-- `import_only` is the third specialised role, and the narrowest: the host runs
-- nothing, builds nothing, stores nothing, and is swept by nothing. It is born
-- only from the import wizard (granted to the one team that ran it), it cannot be
-- promoted from the panel - re-running the install command is how a box becomes a
-- real server - and it is the only role with a genuine agent-side uninstall, so
-- finishing a migration removes Deplo from that host instead of handing someone a
-- shell command.
--
-- The role CHECK grows from two columns to three. It has to be dropped and
-- recreated: `servers_role_exclusive` already exists from 0096, and adding a
-- constraint of the same name errors rather than replacing it.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "import_only" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

ALTER TABLE "servers" DROP CONSTRAINT IF EXISTS "servers_role_exclusive";
--> statement-breakpoint

ALTER TABLE "servers" ADD CONSTRAINT "servers_role_exclusive"
  CHECK ((("storage_only")::int + ("build_only")::int + ("import_only")::int) <= 1);
