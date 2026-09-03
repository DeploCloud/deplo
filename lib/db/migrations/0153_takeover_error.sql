-- A cutover that rolled back has to say why in the wizard, not only on the host.
ALTER TABLE "instance_settings" ADD COLUMN "takeover_error" text;
