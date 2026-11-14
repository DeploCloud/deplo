-- A relay warning that a new Cloudflare token fixes carries the button that asks for one.
ALTER TABLE "cluster_warnings" ADD COLUMN "fix_cloudflare_token" boolean DEFAULT false NOT NULL;
