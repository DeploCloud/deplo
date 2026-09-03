-- A team's slug is now its ADDRESS (`/<slug>/apps/...`), and a slug that is also
-- a top-level route would be shadowed by it: that team could never be reached.
-- Only a team named after one of these is touched, which is almost certainly none.
-- ponytail: the list is frozen here; a route added later needs its own migration.

UPDATE "teams" SET "slug" = "slug" || '-2'
WHERE "slug" IN (
  '_next', 'activity', 'api', 'apps', 'deployments', 'engines',
  'install', 'install-agent', 'login', 'logs', 'members', 'migrations',
  'monitoring', 'new', 'oauth', 'projects', 'register', 'servers',
  'settings', 'setup', 'signup', 'storage', 'takeover', 'templates',
  'uninstall', 'variables', 'welcome'
) AND "slug" || '-2' NOT IN (SELECT "slug" FROM "teams");
--> statement-breakpoint

-- Anything the plain suffix could not free (both names already taken) gets one
-- derived from its id, so the second pass always terminates.
UPDATE "teams" SET "slug" = "slug" || '-' || substr(md5("id"), 1, 6)
WHERE "slug" IN (
  '_next', 'activity', 'api', 'apps', 'deployments', 'engines',
  'install', 'install-agent', 'login', 'logs', 'members', 'migrations',
  'monitoring', 'new', 'oauth', 'projects', 'register', 'servers',
  'settings', 'setup', 'signup', 'storage', 'takeover', 'templates',
  'uninstall', 'variables', 'welcome'
);
