import { test, before, after } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "./test-harness";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  void db;
});

after(async () => {
  await pg.close();
});

const PRE_EXISTING = [
  "account",
  "session",
  "verification",
  "two_factor",
  "passkey",
  "scheduler_lease",
  "oauth_client",
  "oauth_consent",
  "oauth_access_token",
  "oauth_refresh_token",
  "oauth_resource",
  "oauth_client_resource",
  "oauth_client_assertion",
] as const;

const CONTROL_PLANE = [
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
  "team_roles",
  "team_role_capabilities",
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
  "servers",
  "server_teams",
  "docker_cleanup_policy",
  "docker_cleanup_policy_scopes",
  "docker_cleanup_excluded_servers",
  "docker_cleanup_runs",
  "docker_cleanup_run_items",
  "monitoring_settings",
  "instance_settings",
  "migration_runs",
  "migration_run_db_hosts",
  "migration_run_items",
  "migration_run_members",
  "migration_source_addresses",
  "migration_run_targets",
  "migration_run_servers",
  "rate_limits",
  "apps",
  "app_build",
  "app_build_method_settings",
  "app_volumes",
  "app_ports",
  "app_mounts",
  "deployments",
  "deployment_logs",
  "app_previews",
  "app_preview_env_vars",
  "pending_teardowns",
  "env_vars",
  "env_var_targets",
  "domains",
  "domain_middlewares",
  "app_basic_auth_users",
  "databases",
  "database_mounts",
  "team_database_order",
  "backup_destination",
  "backups",
  "backup_runs",
  "cron_jobs",
  "cron_job_env",
  "cron_runs",
  "api_tokens",
  "api_token_capabilities",
  "api_token_teams",
  "api_token_projects",
  "api_token_folders",
  "api_token_apps",
  "activities",
  "notification_channels",
  "notification_alerts",
  "push_subscriptions",
  "registries",
  "installed_plugins",
  "shared_env_vars",
  "shared_env_var_targets",
  "shared_env_var_environments",
  "shared_env_var_projects",
  "shared_env_var_apps",
  "shared_env_var_teams",
  "github_apps",
  "github_installation",
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
  const idx = await pg.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname='public'`,
  );
  const indexes = new Set(idx.rows.map((x) => x.indexname));
  for (const name of [
    "domains_one_primary_uq",
    "invites_team_email_pending_uq",
    "users_email_lower_uq",
    "domains_name_pathprefix_uq",
    "servers_cert_fingerprint_uq",
    "backup_runs_running_idx",
    "cron_runs_running_idx",
    "cron_runs_dedupe_uq",
    "cron_jobs_enabled_idx",
    "git_connections_webhook_token_uq",
  ]) {
    assert.ok(indexes.has(name), `index ${name} should exist`);
  }

  const chk = await pg.query<{ conname: string }>(
    `select conname from pg_constraint where contype='c'`,
  );
  const checks = new Set(chk.rows.map((x) => x.conname));
  assert.ok(checks.has("backups_target_kind_xor"), "backups XOR check");
  assert.ok(checks.has("cron_jobs_target_kind_xor"), "cron jobs XOR check");
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
  const logs = await pg.query<{ is_identity: string }>(
    `select is_identity from information_schema.columns
      where table_schema='public' and table_name='deployment_logs' and column_name='id'`,
  );
  assert.equal(logs.rows[0]?.is_identity, "YES");
});
