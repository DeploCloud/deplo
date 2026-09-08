-- The plate an app's icon needs to be visible on both themes, read from the
-- logo's own pixels. Written ONLY when the logo came from a template: NULL is
-- both "no plate" and "this logo is the user's, leave it alone".
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "logo_tone" text;
