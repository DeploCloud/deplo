import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "./test-harness";

/**
 * Step 1 schema test (relational-store PLAN §9 Step 1: "a `schema.test.ts`
 * asserts the table set matches the design").
 *
 * It applies the REAL generated migrations (0000…0004) to a fresh pglite via the
 * shared test harness, then reads `information_schema` so the assertions are
 * against the DDL production actually runs — not the Drizzle declarations in
 * isolation. This catches a table/enum/constraint that was declared but never made
 * it into a generated migration (the `db:generate` drift the PLAN §10 guards
 * against), and a stray table a migration created that the design never asked for.
 *
 * Migration 0004 (PLAN Step 7) dropped the legacy `deplo_state` JSONB table and
 * the `store_migration` backfill bookkeeping table; neither is in the expected
 * set below, and the test proves they no longer exist after the journal replays.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  void db;
});

after(async () => {
  await pg.close();
});

/* ------------------------------------------------------------------ */
/* The exact expected table set                                        */
/* ------------------------------------------------------------------ */

/**
 * Better-Auth tables (schema/auth) + the live `scheduler_lease` mutex
 * (schema/scheduler) — the non-control-plane tables that survive. The legacy
 * `deplo_state` JSONB table was dropped in PLAN Step 7 (migration 0004).
 *
 * `user` is absent on purpose: migration 0055 dropped it and remapped Better Auth's
 * `user` model onto the control-plane `users` table (ADR-0014).
 */
const PRE_EXISTING = [
  "account",
  "session",
  "verification",
  "two_factor",
  // One WebAuthn credential per row (migration 0102), owned by
  // @better-auth/passkey. Its presence is what satisfies a team's two-factor
  // mandate for an account with no TOTP - see lib/membership.ts.
  "passkey",
  "scheduler_lease",
  // The OAuth 2.1 provider's four (migration 0101): a registered client, what a
  // person agreed to give it, and the two opaque credentials it presents. Owned
  // by @better-auth/oauth-provider the way the four above are owned by Better
  // Auth — deplo's own half of a connection is a row in `api_tokens`.
  "oauth_client",
  "oauth_consent",
  "oauth_access_token",
  "oauth_refresh_token",
  // Three more from the Better Auth 1.7.0 bump (migration 0116). `oauth_resource`
  // is the RFC 8707 audience list, which used to be a config array
  // (`validAudiences`) and became rows so a grant can RECORD the audience it was
  // issued for - the fix for GHSA-p2fr-6hmx-4528. `oauth_client_resource` is
  // which client may request which of them, and `oauth_client_assertion` is the
  // `jti` replay cache for `private_key_jwt`, empty on every deplo instance but
  // required because the adapter resolves a model to `schema[modelName]`.
  "oauth_resource",
  "oauth_client_resource",
  "oauth_client_assertion",
] as const;

/** The relational control-plane tables added in Step 1 (PLAN §2). */
const CONTROL_PLANE = [
  // identity
  "users",
  "teams",
  "folders",
  "folder_grants",
  "projects",
  "project_grants",
  "app_grants",
  "environment_grants",
  "team_project_order",
  "environments",
  "app_environments",
  "memberships",
  "membership_capabilities",
  // team roles — the named capability sets a member is assigned (three built-ins
  // per team plus the team's own); memberships.role_id points at one.
  "team_roles",
  "team_role_capabilities",
  // …and what a scoped role REACHES, one junction per node kind, mirroring the
  // API token's scope. `team_roles.scoped` is the intent that survives their
  // cascade.
  "team_role_scope_projects",
  "team_role_scope_environments",
  "team_role_scope_folders",
  "team_role_scope_apps",
  "invites",
  "invite_capabilities",
  "registration_links",
  "registration_link_teams",
  "registration_link_team_capabilities",
  "team_app_order",
  "team_folder_order",
  // infra
  "servers",
  "server_teams",
  // docker cleanup — instance-wide (a singleton policy + its scopes, the per-server
  // opt-out list, and one run per server per sweep). Never team-scoped: servers are
  // the one shared cross-team resource.
  "docker_cleanup_policy",
  "docker_cleanup_policy_scopes",
  "docker_cleanup_excluded_servers",
  "docker_cleanup_runs",
  "docker_cleanup_run_items",
  // monitoring — instance-wide singleton (the "save metrics on server" switch);
  // the metrics history itself is process RAM, never a table.
  "monitoring_settings",
  // instance — singleton holding the instance-owner crown (the tier above
  // instance admin, immutable to every other admin).
  "instance_settings",
  // import from Dokploy — one run per import plus its report lines, team-scoped
  // and kept: "what came over from the old platform, and what did not" has to be
  // answerable after the tab that started it is gone. The API key is never
  // stored; it rides each call.
  "dokploy_imports",
  "dokploy_import_items",
  // Where a machine of a given Dokploy is actually REACHED, remembered across
  // attempts. Not on the server row: that row is removed when a migration ends,
  // and the correction went with it - so every retry re-derived the panel's
  // hostname, which behind a proxy is not the machine at all.
  "dokploy_source_addresses",
  // rate limiting - durable fixed-window counters for login, the two-factor
  // challenge and the register link. Un-scoped by design: a bucket is about an
  // ATTEMPT, often against a subject that does not exist, so it has no team and
  // no user FK to cascade from.
  "rate_limits",
  // services
  "apps",
  "app_build",
  "app_build_method_settings",
  "app_volumes",
  "app_mounts",
  "deployments",
  "deployment_logs",
  // pull request previews — one ephemeral stack per open pull request, plus the
  // advanced preview-only variable overrides.
  "app_previews",
  "app_preview_env_vars",
  // stacks a host would not confirm are gone, retried until it does
  "pending_teardowns",
  "env_vars",
  "env_var_targets",
  "instance_env_vars",
  "instance_env_var_targets",
  "domains",
  "domain_middlewares",
  "app_basic_auth_users",
  // data
  "databases",
  // The engine's own config files — the sibling of `app_mounts`, carrying the
  // container path too because a database's compose is rendered by deplo.
  "database_mounts",
  "team_database_order",
  "backup_destination",
  "backups",
  "backup_runs",
  // cron jobs (ADR-0018)
  "cron_jobs",
  "cron_job_env",
  "cron_runs",
  // per-team leaf
  "api_tokens",
  "api_token_capabilities",
  "api_token_teams",
  "api_token_projects",
  "api_token_folders",
  "api_token_apps",
  "activities",
  // One row per CONFIGURED destination — a team may have two Discord rooms.
  "notification_channels",
  // What each of them is subscribed to (a list, so a child table), and the
  // browsers that opted into push, per user and team.
  "notification_alerts",
  "push_subscriptions",
  "registries",
  "installed_plugins",
  // unified shared variables (ADR-0010)
  "shared_env_vars",
  "shared_env_var_targets",
  "shared_env_var_environments",
  "shared_env_var_projects",
  "shared_env_var_apps",
  // integrations
  "github_apps",
  "github_installation",
  // …and one row per team credential for every OTHER git host (GitLab,
  // Bitbucket, Gitea/Forgejo, plain git): they all authenticate the same way, so
  // they share a table with a `provider` discriminator.
  "git_connections",
] as const;

async function publicTables(): Promise<Set<string>> {
  const r = await pg.query<{ table_name: string }>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  return new Set(r.rows.map((x) => x.table_name));
}

test("schema: every designed table exists and there are no extras", async () => {
  const expected = new Set<string>([...PRE_EXISTING, ...CONTROL_PLANE]);
  // The drizzle migrator also creates its bookkeeping table; exclude it.
  const got = await publicTables();
  got.delete("__drizzle_migrations");

  const missing = [...expected].filter((t) => !got.has(t)).sort();
  const extra = [...got].filter((t) => !expected.has(t)).sort();

  assert.deepEqual(missing, [], `missing tables: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `unexpected tables: ${extra.join(", ")}`);
});

test("schema: the two control-plane enums exist with the designed values", async () => {
  const r = await pg.query<{ enum_name: string; values: string }>(
    `select t.typname as enum_name,
            string_agg(e.enumlabel, ',' order by e.enumsortorder) as values
       from pg_type t
       join pg_enum e on e.enumtypid = t.oid
      group by t.typname`,
  );
  const byName = new Map(r.rows.map((x) => [x.enum_name, x.values]));

  assert.equal(
    byName.get("deployment_log_level"),
    "info,warn,error,debug,command,success",
  );
  assert.equal(byName.get("github_account_type"), "User,Organization");
});

test("schema: the load-bearing constraints from PLAN §2 are present", async () => {
  // Partial-unique / expression-unique indexes (the concurrency backstops).
  const idx = await pg.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname='public'`,
  );
  const indexes = new Set(idx.rows.map((x) => x.indexname));
  for (const name of [
    "domains_one_primary_uq", // partial UNIQUE WHERE is_primary
    "invites_team_email_pending_uq", // partial UNIQUE WHERE status='pending'
    "users_email_lower_uq", // expression UNIQUE lower(email)
    "domains_name_pathprefix_uq", // expression UNIQUE name + coalesce(path_prefix)
    "servers_cert_fingerprint_uq", // partial UNIQUE excluding ''/NULL
    "backup_runs_running_idx", // partial index WHERE status='running'
    "cron_runs_running_idx", // the cron reaper's working set, same shape
    "cron_runs_dedupe_uq", // UNIQUE(job_id, dedupe_key) - the double-fire guard
    "cron_jobs_enabled_idx", // partial index WHERE enabled
    "git_connections_webhook_token_uq", // UNIQUE - the webhook's routing key
  ]) {
    assert.ok(indexes.has(name), `index ${name} should exist`);
  }

  // CHECK constraints (the XOR target).
  const chk = await pg.query<{ conname: string }>(
    `select conname from pg_constraint where contype='c'`,
  );
  const checks = new Set(chk.rows.map((x) => x.conname));
  assert.ok(checks.has("backups_target_kind_xor"), "backups XOR check");
  assert.ok(checks.has("cron_jobs_target_kind_xor"), "cron jobs XOR check");
  // The server ROLE flags are exclusive in the database, not just in the UI. It
  // has been rewritten once already (two columns to three, in 0111): a migration
  // that adds a fourth role and forgets to widen it would let a host be two
  // things at once, and `serverRole` would silently answer with whichever it
  // checks first.
  assert.ok(
    checks.has("servers_role_exclusive"),
    "server role exclusivity check",
  );
});

test("schema: the append-only tables carry a bigint identity seq", async () => {
  for (const table of [
    "activities",
    "deployments",
    "backup_runs",
    "cron_runs",
  ]) {
    const r = await pg.query<{ is_identity: string; data_type: string }>(
      `select is_identity, data_type from information_schema.columns
        where table_schema='public' and table_name=$1 and column_name='seq'`,
      [table],
    );
    assert.equal(r.rows[0]?.is_identity, "YES", `${table}.seq is identity`);
    assert.equal(r.rows[0]?.data_type, "bigint", `${table}.seq is bigint`);
  }
  // deployment_logs reproduces Array.push order via its bigint identity id.
  const logs = await pg.query<{ is_identity: string }>(
    `select is_identity from information_schema.columns
      where table_schema='public' and table_name='deployment_logs' and column_name='id'`,
  );
  assert.equal(logs.rows[0]?.is_identity, "YES");
});
