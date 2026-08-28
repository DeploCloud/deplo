import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { PGlite, types } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import { isoTimestampParser } from "./timestamp-parser";
import { schema } from "./schema";
import { __setTestDb, __resetTestDb } from "./client";
import { loadEnvVarsForApp } from "../data/app-graph-load";
import {
  loadAutoInjectedVarsForApp,
  loadSharedVarsForApp,
} from "../data/shared-vars";
import { resolveEnvEntries } from "../deploy/env-resolve";
import type { EnvTarget } from "../types";

/**
 * Migration parity for ADR-0027: `instance_env_vars` folds into `shared_env_vars`
 * as instance-OWNED rows. Every app must resolve the same key -> valueEnc map, on
 * every target, before and after 0131 + 0132.
 */

const T0 = "2026-01-01T00:00:00.000Z";
const MIG_DIR = path.join(process.cwd(), "lib", "db", "migrations");

let pg: PGlite;
let db: PgliteDatabase<typeof schema>;

async function applyFile(file: string): Promise<void> {
  const sql = readFileSync(path.join(MIG_DIR, file), "utf8");
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const s = chunk.trim();
    if (s) await pg.exec(s);
  }
}

before(async () => {
  pg = new PGlite({
    parsers: {
      [types.TIMESTAMPTZ]: isoTimestampParser,
      [types.TIMESTAMP]: isoTimestampParser,
    },
  });
  db = drizzle(pg, { schema });

  const files = readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const freeze = (f: string) => Number(f.slice(0, 4)) <= 130;
  for (const f of files.filter(freeze)) await applyFile(f);

  // The old world, in raw SQL: `instance_env_vars` is gone from the live drizzle
  // schema, and `shared_env_vars.team_wide` with it.
  await pg.exec(`
    insert into users (id, email, username, name, role, is_instance_admin, suspended, avatar_color, created_at, updated_at)
      values ('user_1', 'u@example.io', 'user_1', 'user_1', 'owner', true, false, '#abc', '${T0}', '${T0}');
    insert into teams (id, name, slug, plan, founder_user_id, created_at)
      values ('team_a', 'alpha', 'alpha', 'pro', 'user_1', '${T0}'),
             ('team_b', 'beta',  'beta',  'pro', null,     '${T0}');

    insert into servers (id, name, host, type, status, ip, docker_version, traefik_enabled,
      cpu_cores, memory_mb, disk_gb, cpu_usage, memory_usage, disk_usage,
      all_teams, deploy_concurrency, created_at)
      values ('srv_1','srv_1','10.0.0.1','remote','online','10.0.0.1','27',true,
              4,8192,100,1,1,1,true,1,'${T0}');

    insert into apps (id, name, slug, team_id, server_id, source, status, auto_deploy,
      repo_submodules, created_at, updated_at)
      values ('app_a','app_a','app_a','team_a','srv_1','github','active',false,false,'${T0}','${T0}'),
             ('app_b','app_b','app_b','team_b','srv_1','github','active',false,false,'${T0}','${T0}');

    -- The app's OWN value for a key an instance global also carries: the global
    -- sits LOWEST, so the app's must keep winning after the fold.
    insert into env_vars (id, app_id, key, value_enc, type, created_at, updated_at)
      values ('ev_1','app_a','G_PLAIN','enc:appwins','plain','${T0}','${T0}');
    insert into env_var_targets (env_var_id, target) values ('ev_1','production'), ('ev_1','preview');

    -- A team-wide shared var: cardinality 1 after the fold, so it must go on
    -- suggesting and NOT start injecting (ADR-0012 preserved).
    insert into shared_env_vars (id, team_id, key, value_enc, type, team_wide, created_at, updated_at)
      values ('svar_tw','team_a','TEAMWIDE','enc:tw','plain',true,'${T0}','${T0}');
    insert into shared_env_var_targets (var_id, target) values ('svar_tw','production'), ('svar_tw','preview');

    -- The four shapes an instance global comes in.
    insert into instance_env_vars (id, key, value_enc, type, created_at, updated_at) values
      ('gv_plain','G_PLAIN','enc:global','plain','${T0}','${T0}'),
      ('gv_secret','G_SECRET','enc:gsecret','secret','${T0}','${T0}'),
      ('gv_prod','G_PROD','enc:gprod','plain','${T0}','${T0}'),
      ('gv_notarget','G_NOTARGET','enc:gnone','plain','${T0}','${T0}');
    insert into instance_env_var_targets (env_var_id, target) values
      ('gv_plain','production'), ('gv_plain','preview'),
      ('gv_secret','production'), ('gv_secret','preview'),
      ('gv_prod','production');
  `);

  for (const f of files.filter((f) => !freeze(f))) await applyFile(f);
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

/** The resolved key -> valueEnc map for one (app, target), exactly like appEnv. */
async function resolved(
  appId: string,
  target: EnvTarget,
): Promise<Record<string, string>> {
  const [vars, sharedVars, autoInjected] = await Promise.all([
    loadEnvVarsForApp(appId),
    loadSharedVarsForApp(appId),
    loadAutoInjectedVarsForApp(appId),
  ]);
  const out: Record<string, string> = {};
  for (const e of resolveEnvEntries(
    target,
    appId,
    vars,
    sharedVars,
    autoInjected,
  ))
    out[e.key] = e.valueEnc;
  return out;
}

test("every instance global still reaches every app, on every target", async () => {
  // Byte-identical to what the instance-global layer resolved at 0130: the same
  // keys, the same ciphertext, in the same lowest-precedence slot.
  assert.deepEqual(await resolved("app_a", "production"), {
    G_PLAIN: "enc:appwins", // the app's own value still outranks the global
    G_SECRET: "enc:gsecret",
    G_PROD: "enc:gprod",
    G_NOTARGET: "enc:gnone",
  });
  assert.deepEqual(await resolved("app_a", "preview"), {
    G_PLAIN: "enc:appwins",
    G_SECRET: "enc:gsecret",
    G_NOTARGET: "enc:gnone",
  });
  // A DIFFERENT team gets them too - that is what instance-wide meant.
  assert.deepEqual(await resolved("app_b", "production"), {
    G_PLAIN: "enc:global",
    G_SECRET: "enc:gsecret",
    G_PROD: "enc:gprod",
    G_NOTARGET: "enc:gnone",
  });
});

test("the migrated globals are instance-OWNED and auto-injecting", async () => {
  const rows = await pg.query<{
    key: string;
    team_id: string | null;
    auto_inject: boolean;
  }>(
    `select key, team_id, auto_inject from shared_env_vars
       where key like 'G_%' order by key`,
  );
  assert.deepEqual(
    rows.rows.map((r) => [r.key, r.team_id, r.auto_inject]),
    [
      ["G_NOTARGET", null, true],
      ["G_PLAIN", null, true],
      ["G_PROD", null, true],
      ["G_SECRET", null, true],
    ],
  );
});

test("auto_inject is unconditional, not `reaches more than one team`", async () => {
  // The single-team instance is the common self-hosted shape: a cardinality rule
  // would silently stop injecting every global it has.
  const one = await pg.query<{ n: number }>(
    `select count(*)::int as n from shared_env_var_teams
       where var_id = (select id from shared_env_vars where key = 'G_PROD')`,
  );
  assert.equal(one.rows[0]!.n, 2, "one reach row per team that existed");
  await pg.exec(`delete from teams where id = 'team_b'`);
  assert.deepEqual(Object.keys(await resolved("app_a", "production")).sort(), [
    "G_NOTARGET",
    "G_PLAIN",
    "G_PROD",
    "G_SECRET",
  ]);
});

test("a target-less global keeps reaching every runtime, explicitly", async () => {
  const t = await pg.query<{ target: string }>(
    `select target from shared_env_var_targets
       where var_id = (select id from shared_env_vars where key = 'G_NOTARGET')
       order by target`,
  );
  assert.deepEqual(
    t.rows.map((r) => r.target),
    ["preview", "production"],
  );
});

test("a migrated team-wide var still does NOT inject without a link", async () => {
  const teams = await pg.query<{ team_id: string }>(
    `select team_id from shared_env_var_teams where var_id = 'svar_tw'`,
  );
  assert.deepEqual(
    teams.rows.map((r) => r.team_id),
    ["team_a"],
    "cardinality 1: it suggests, it does not inject",
  );
  const injected = await loadAutoInjectedVarsForApp("app_a");
  assert.equal(
    injected.some((e) => e.key === "TEAMWIDE"),
    false,
  );
});

test("the old tables are gone", async () => {
  const t = await pg.query<{ tablename: string }>(
    `select tablename from pg_tables where schemaname = 'public'
       and tablename in ('instance_env_vars', 'instance_env_var_targets')`,
  );
  assert.deepEqual(t.rows, []);
});
