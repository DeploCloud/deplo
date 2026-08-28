-- `member` was doing five jobs: people, credentials, hosts, third-party
-- connections and instance settings. Four new tokens split the last four off so
-- the Activity page can filter them, and `member` goes back to meaning people.
--
-- Most specific FIRST: every statement is guarded on `type = 'member'`, so a row
-- an earlier pass retyped is out of reach of every later one. That ordering is
-- what makes the loose `Connected %` catch at the end safe. Every pattern is
-- anchored at both ends - a role, token or registry can be NAMED "API token".
--
-- `activities.type` is plain text with no CHECK and no index on it, so this is a
-- pure data pass. Rows a pattern misses stay `member`: an audit row is not
-- rewritten for cosmetics.

-- MCP first: both messages come from the same call site (lib/data/tokens.ts),
-- and only the message tells them apart.
UPDATE "activities" SET "type" = 'mcp'
 WHERE "type" = 'member'
   AND "message" LIKE 'Revoked %''s MCP access';--> statement-breakpoint

UPDATE "activities" SET "type" = 'security'
 WHERE "type" = 'member'
   AND (   "message" LIKE 'Created the % API token'
        OR "message" LIKE 'Updated the % API token'
        OR "message" LIKE 'Revoked the % API token'
        OR "message" LIKE 'Added the % passkey'
        OR "message" LIKE 'Removed the % passkey'
        OR "message" LIKE 'Removed @%''s passkey'
        OR "message" LIKE 'Removed @%''s % passkeys'
        OR "message" LIKE 'Reset two-factor authentication for @%'
        OR "message" LIKE 'Two-factor sign-in is now %' );--> statement-breakpoint

UPDATE "activities" SET "type" = 'server'
 WHERE "type" = 'member'
   AND (   "message" LIKE 'Connected server %'
        OR "message" LIKE 'Reissued install command for server %'
        OR "message" LIKE 'Removed server %'
        OR "message" LIKE '% pending teardown% dropped with the server.'
        OR "message" LIKE 'Uninstalled the agent from %'
        OR "message" LIKE 'Changed server % address to %'
        OR "message" LIKE 'Updated agent on % to v%'
        OR "message" LIKE 'Made server % available to all teams'
        OR "message" LIKE 'Set server % access to % team%'
        OR "message" LIKE 'Set deploy concurrency for server % to %'
        OR "message" LIKE 'Set server % to build only'
        OR "message" LIKE 'Set server % to hold backups only'
        OR "message" LIKE 'Set server % to run apps again'
        OR "message" LIKE 'Set the timezone on % to %'
        OR "message" LIKE 'Restarted % workload% on %'
        OR "message" LIKE 'Restarted Traefik on %'
        OR "message" =    'Restarted the Deplo panel'
        OR "message" LIKE 'Published the Traefik panel for % on %'
        OR "message" LIKE 'Turned off the Traefik panel for %'
        OR "message" LIKE 'Installed a TLS certificate for % on %'
        OR "message" LIKE 'Removed the TLS certificate for % from %'
        OR "message" LIKE 'Could not remove Deplo''s agent from %'
        OR "message" LIKE 'Set the certificate account email to % on % server%' );--> statement-breakpoint

-- A git connection's LABEL is user-supplied, so `Connected <label>` cannot be
-- matched on its text. It does not have to be: `Connected server %` was claimed
-- above, an MCP connect was never `member`, and nothing else `member` ever wrote
-- starts with "Connected ".
UPDATE "activities" SET "type" = 'integration'
 WHERE "type" = 'member'
   AND (   "message" LIKE 'Updated the % git connection'
        OR "message" LIKE 'Disconnected the % git connection'
        OR "message" LIKE 'Installed GitHub App on %'
        OR "message" LIKE 'Removed GitHub App %'
        OR "message" LIKE 'Added registry %'
        OR "message" LIKE 'Removed registry %'
        OR "message" LIKE 'Connected %' );--> statement-breakpoint

UPDATE "activities" SET "type" = 'instance'
 WHERE "type" = 'member'
   AND (   "message" LIKE 'Set the maximum log range to % day%'
        OR "message" =    'Turned on Gravatar profile pictures'
        OR "message" =    'Turned off Gravatar profile pictures'
        OR "message" LIKE 'Set the Deplo panel address to %'
        OR "message" LIKE 'Cleared the Deplo panel address%'
        OR "message" LIKE 'Moved the panel to %'
        OR "message" LIKE '% activity entr% could not be recorded on this instance' );
