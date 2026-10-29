-- The Cloudflare Tunnel the panel is served through; the API token is encrypted with the secrets key.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "panel_tunnel_hostname" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "panel_tunnel_account_id" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "panel_tunnel_zone_id" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "panel_tunnel_id" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "panel_tunnel_dns_record_id" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "panel_tunnel_api_token_enc" text;
