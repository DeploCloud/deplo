-- Rollback: put an app back on a previous deployment's image, no rebuild.
--
-- Three columns, and the interesting one is `image_ref`. The tag a build lands on
-- (`deplo/<deploy_key>:<first 12 of the deployment id>`) was until now derivable
-- but never recorded, and deriving it is wrong the moment an app changes source:
-- the rows from its docker-image days would answer with a `deplo/` tag that was
-- never minted. So the deploy writes down what it actually rendered, and only the
-- arms Deplo BUILDS write it - git and upload. A compose stack has no single image
-- and a prebuilt `docker-image` source is a mutable registry tag with no digest
-- behind it, so both leave this NULL, and NOT NULL is exactly "there is an image of
-- ours on that host". No backfill: with the shipped keep-one retention those images
-- are already gone, so a backfill would only manufacture refs that resolve to
-- nothing. Rollback becomes available as new deploys land.

ALTER TABLE "apps" ADD COLUMN "rollback_keep" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint

ALTER TABLE "deployments" ADD COLUMN "image_ref" text;
--> statement-breakpoint

-- The deployment this one went back to. Plain text with NO foreign key, for the
-- same reason `server_id` has none: a deployment is a historical record and has to
-- survive the deletion of what it points at.
ALTER TABLE "deployments" ADD COLUMN "rollback_of" text;
