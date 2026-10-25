-- Security updates now keep only what the team chose (ADR-0038): match every image again
-- on the next tick, so rows the narrower rules drop go now rather than within six hours.
UPDATE "instance_settings" SET "security_checked_at" = NULL;
