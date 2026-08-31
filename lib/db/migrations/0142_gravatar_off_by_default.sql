-- New instances no longer opt every member into handing gravatar.com their IP
-- and an email hash. An instance that already has a row keeps its choice.
ALTER TABLE "instance_settings" ALTER COLUMN "gravatar_enabled" SET DEFAULT false;
