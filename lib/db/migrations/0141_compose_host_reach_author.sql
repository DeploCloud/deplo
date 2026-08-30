-- Who authored a compose that reaches past its container. A deploy has no user of
-- its own, so this is what lets a revoked host grant stop the next one.
ALTER TABLE "apps" ADD COLUMN "host_reach_by" text;
