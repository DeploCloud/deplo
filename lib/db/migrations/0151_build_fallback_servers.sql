-- Which host compiles for an app when its build server cannot.
--
-- `servers.build_fallback` NULL is automatic: the Deplo host and nothing else - the
-- one machine every install has. TRUE/FALSE is the operator's own answer, so a small
-- panel host can leave the pool and a spare server can join it.

ALTER TABLE "servers" ADD COLUMN "build_fallback" boolean;
--> statement-breakpoint

-- The app switch no longer means "build here": it means "build wherever else can",
-- and the app's own server is only the last link of that chain.
ALTER TABLE "apps" RENAME COLUMN "build_fallback_local" TO "build_fallback";
