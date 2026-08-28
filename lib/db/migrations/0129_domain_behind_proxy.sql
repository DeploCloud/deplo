-- A hostname can sit behind a proxy that is not Cloudflare (a CDN, an nginx, a
-- load balancer): its A records answer with the proxy's address, so the DNS check
-- settles on `misconfigured` and the router drops the host entirely. This is the
-- user saying "something else answers for it" - the declared twin of the detected
-- `cloudflare` status.
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "proxied" boolean;
