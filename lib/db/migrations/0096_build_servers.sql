-- Build servers: a host that compiles for machines it does not run on.
--
-- Until now every build happened on the host that would run the container, which
-- means a production server has to be sized for the BUILD, not the workload - a
-- Next.js app that serves in 300 MB needs a 4 GB box to compile, and while it does,
-- the apps already running there compete for the same CPU. Five columns break that.
--
-- `servers.build_only` is the twin of `storage_only`: one specialises away the
-- workload (Docker is there, Traefik is not, nothing of any team runs here), the
-- other specialises away Docker itself. Exclusive by CHECK, because a host cannot
-- both have a Docker daemon by design and lack one by design. Two booleans instead
-- of a `role` enum since both are false for the ordinary server that does
-- everything, which is what nearly every row is - and because `storage_only` is
-- already shipped and migrating it would buy nothing.
--
-- `servers.host_arch` is observed from each Hello, exactly like `docker_version`.
-- It is stored rather than read live for one reason: the "Build on" picker must grey
-- out the mismatched hosts, and reading it live would be an agent dial per server on
-- every page render. An amd64 image loaded on an arm64 host starts and dies with
-- `exec format error` at RUN time, long after the deploy reported success, so this
-- is the column that turns a mystery crash loop into a refusal before the build.
-- "" is an agent too old to report it, which can never equal another host's arch and
-- so keeps that server out of the picker rather than guessing.
--
-- `apps.build_server_id` NULL means "Automatic": use a build-only server if the
-- fleet has one this team can reach, otherwise build where the app runs - which is
-- what every existing row did, so NULL is the correct value for all of them and no
-- backfill is needed. "Build on this app's own server" pins that server's id rather
-- than storing a magic word in a column of ids. SET NULL, not RESTRICT: removing a
-- build server must not be blocked by an app that merely preferred it, and falling
-- back to Automatic is always a valid state.
--
-- `deployments.build_server_id` is the historical record of where an app's source
-- and decrypted env actually went, which is why it is FK-less like `server_id`: the
-- audit answer must survive the decommissioning of the host it names.

ALTER TABLE "servers" ADD COLUMN "build_only" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

ALTER TABLE "servers" ADD COLUMN "host_arch" text DEFAULT '' NOT NULL;
--> statement-breakpoint

ALTER TABLE "servers" ADD CONSTRAINT "servers_role_exclusive"
  CHECK (NOT ("storage_only" AND "build_only"));
--> statement-breakpoint

ALTER TABLE "apps" ADD COLUMN "build_server_id" text;
--> statement-breakpoint

ALTER TABLE "apps" ADD CONSTRAINT "apps_build_server_id_servers_id_fk"
  FOREIGN KEY ("build_server_id") REFERENCES "public"."servers"("id")
  ON DELETE set null ON UPDATE no action;
--> statement-breakpoint

ALTER TABLE "apps" ADD COLUMN "build_fallback_local" boolean DEFAULT true NOT NULL;
--> statement-breakpoint

ALTER TABLE "deployments" ADD COLUMN "build_server_id" text;
--> statement-breakpoint

-- The deploy queue drains on the LANE, which is now the build server when there is
-- one. `deployments_queued_server_idx` indexes `server_id` and no longer matches
-- that predicate, so the drain gets its own partial index on the same expression.
-- Partial (queued-only) for the same reason its sibling is: this indexes the live
-- backlog, never the deploy history, which grows without bound.
CREATE INDEX "deployments_queued_lane_idx" ON "deployments"
  (COALESCE("build_server_id", "server_id"), "created_at", "seq")
  WHERE "status" = 'queued';
