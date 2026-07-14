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
 */
const PRE_EXISTING = [
  "account",
  "session",
  "user",
  "verification",
  "scheduler_lease",
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
  "team_project_order",
  "environments",
  "app_environments",
  "memberships",
  "membership_capabilities",
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
  // services
  "apps",
  "app_build",
  "app_build_method_settings",
  "app_dev",
  "app_volumes",
  "app_mounts",
  "deployments",
  "deployment_logs",
  "env_vars",
  "env_var_targets",
  "instance_env_vars",
  "instance_env_var_targets",
  "domains",
  "domain_middlewares",
  "app_basic_auth_users",
  "dev_ssh_user",
  // data
  "databases",
  "s3_destination",
  "backups",
  "backup_runs",
  // per-team leaf
  "api_tokens",
  "activities",
  "notification_settings",
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

test("schema: the three control-plane enums exist with the designed values", async () => {
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
  assert.equal(byName.get("dev_status"), "off,starting,running,stopped,error");
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
  ]) {
    assert.ok(indexes.has(name), `index ${name} should exist`);
  }

  // CHECK constraints (the XOR target + the dev-ssh credential).
  const chk = await pg.query<{ conname: string }>(
    `select conname from pg_constraint where contype='c'`,
  );
  const checks = new Set(chk.rows.map((x) => x.conname));
  assert.ok(checks.has("backups_target_kind_xor"), "backups XOR check");
  assert.ok(checks.has("dev_ssh_user_has_credential"), "dev_ssh credential check");
});

test("schema: the append-only tables carry a bigint identity seq", async () => {
  for (const table of ["activities", "deployments", "backup_runs"]) {
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
