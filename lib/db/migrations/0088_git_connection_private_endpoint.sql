-- Whether this git connection is allowed to point INSIDE the deployment.
--
-- `git_connections.base_url` is dialed by the control plane itself (proving the
-- token at creation, listing repositories, registering the push webhook) and it
-- is the one user-supplied outbound address that never went through
-- `assertSafeOutboundUrl`. So `http://169.254.169.254/...` was an accepted value,
-- and because the provider's own response body is surfaced back in the error
-- message, the request was readable rather than blind.
--
-- The fix mirrors `backup_destinations.allow_private_endpoint` exactly, because
-- the underlying trade is identical: a self-hosted GitLab or Gitea on the
-- operator's own LAN is an ordinary thing to want on a self-hosting platform, so
-- the answer is not "refuse private addresses" but "refuse them from the
-- ordinary form, and make reaching inside the network a deliberate,
-- instance-admin decision that the connection then carries on its face".
--
-- Default FALSE, and every EXISTING row gets FALSE: an instance that already had
-- a LAN git server keeps working (nothing re-validates a stored base URL), while
-- nothing anyone creates from here on can aim inside the deployment by accident.

ALTER TABLE "git_connections"
  ADD COLUMN IF NOT EXISTS "allow_private_endpoint" boolean DEFAULT false NOT NULL;
