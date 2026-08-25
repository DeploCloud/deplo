import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { PGlite, types } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";

import { isoTimestampParser } from "./timestamp-parser";
import { schema } from "./schema";
import { __setTestDb, __resetTestDb } from "./client";
import {
  envVarTargets as envVarTargetsTable,
  apps as appsTable,
} from "./schema/control-plane";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import { loadEnvVarsForApp } from "../data/app-graph-load";
import { loadSharedVarsForApp } from "../data/shared-vars";
import { loadInstanceEnv } from "../data/global-env";
import { resolveEnvEntries } from "../deploy/env-resolve";
import type { EnvTarget } from "../types";

/**
 * Migration-parity test for ADR-0010 (spec §4 "final check"), AMENDED by ADR-0012
 * (shared variables are opt-in per app).
 */

const T0 = "2026-01-01T00:00:00.000Z";
const MIG_DIR = path.join(process.cwd(), "lib", "db", "migrations");

let pg: PGlite;
let db: PgliteDatabase<typeof schema>;

/** Apply one migration file, statement by statement (drizzle's breakpoint split). */
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

  // Replay 0000.. 0026, seed the old world, THEN apply 0027 and EVERYTHING after it.
  const files = readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  // token_version (0043) adds a `users` column that seedIdentity's live-drizzle
  // insert names, so it must exist before the pre-0027 seed.
  const preSeed = (f: string): boolean =>
    Number(f.slice(0, 4)) < 27 ||
    f.startsWith("0043_") ||
    f.startsWith("0054_") ||
    f.startsWith("0055_") ||
    f.startsWith("0064_") ||
    f.startsWith("0071_") ||
    f.startsWith("0085_") ||
    f.startsWith("0098_") ||
    // 0115 is `account.issuer` and nothing else - one additive ALTER plus its backfill,
    // on a table 0055 already created.
    f.startsWith("0115_");
  const pre27 = files.filter(preSeed);
  const from27 = files.filter((f) => !preSeed(f));

  for (const f of pre27) await applyFile(f);

  // Two columns from 0121 (profile pictures) borrowed forward as bare ALTERs rather
  // than by pulling the whole file into `preSeed`: 0121 also alters
  // `instance_settings`, which does not exist yet at this point.
  await pg.exec(`
    alter table teams add column if not exists image text;
    alter table memberships add column if not exists switcher_position integer;
  `);

  // --- Seed old-world fixtures BETWEEN 0026 and 0027 (via the seed helpers so
  // the many required team/app columns stay correct) ---
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  // RAW SQL, not the drizzle `seedServer` helper: the schema is frozen at 0026 here,
  // but drizzle names EVERY column the live `servers` object knows in its INSERT — so
  // the helper reaches for columns a later migration adds (0030's status_checked_at /
  await pg.exec(`
    insert into servers (
      id, name, host, type, status, ip, docker_version, traefik_enabled,
      cpu_cores, memory_mb, disk_gb, cpu_usage, memory_usage, disk_usage,
      all_teams, deploy_concurrency, created_at
    ) values (
      'srv_1', 'srv_1', '10.0.0.1', 'remote', 'online', '10.0.0.1', '27', true,
      4, 8192, 100, 1, 1, 1,
      true, 1, '${T0}'
    ) on conflict do nothing;`);
  // RAW SQL for the same reason as the servers seed above, and now for a second
  // column: drizzle names every column the LIVE table object knows, and
  // `migration_run_id` (0119) does not exist at this 0026 freeze either.
  await pg.exec(`
    insert into projects (id, team_id, name, slug, color, owner_user_id, created_at, updated_at)
    values ('prc_1', '${TEAM_A}', 'P', 'p', null, '${USER_1}', '${T0}', '${T0}');`);
  await pg.exec(`
    insert into environments (id, project_id, name, slug, kind, git_branch, is_default, position, created_at, updated_at)
    values
      ('env_dev',  'prc_1', 'Development', 'development', 'development', '', true,  0, '${T0}', '${T0}'),
      ('env_prod', 'prc_1', 'Production',  'production',  'production',  '', false, 1, '${T0}', '${T0}');`);
  // app_p lives in the project's Development env; app_top is top-level. Only the apps
  // rows (the FK anchors env_vars need) are seeded — the loaders the assertions drive
  // read env/shared vars, never the app_build child.
  await pg.exec(`
    insert into apps (
      id, name, slug, team_id, server_id, source, status, auto_deploy,
      repo_submodules, created_at, updated_at
    ) values
      ('app_p',   'app_p',   'app_p',   '${TEAM_A}', 'srv_1', 'github', 'active', false, false, '${T0}', '${T0}'),
      ('app_top', 'app_top', 'app_top', '${TEAM_A}', 'srv_1', 'github', 'active', false, false, '${T0}', '${T0}');`);
  await db
    .update(appsTable)
    .set({ projectId: "prc_1", environmentId: "env_dev" })
    .where(eq(appsTable.id, "app_p"));
  // app_p's OWN vars: OWN (unique) + DUP (collides with the shared group).
  await pg.exec(`
    insert into env_vars (id, app_id, key, value_enc, type, created_at, updated_at) values
      ('ev_own', 'app_p', 'OWN', 'enc:own', 'plain', '${T0}', '${T0}'),
      ('ev_dup', 'app_p', 'DUP', 'enc:appdup', 'plain', '${T0}', '${T0}');
  `);
  await db.insert(envVarTargetsTable).values([
    { envVarId: "ev_own", target: "production" },
    { envVarId: "ev_dup", target: "production" },
  ]);

  // Legacy tables (dropped in 0028; not in the drizzle schema) — seed via raw SQL.
  await pg.exec(`
    insert into team_global_env_vars (id, team_id, key, value_enc, type, created_at, updated_at)
      values ('tg1', 'team_a', 'TG', 'enc:tg', 'plain', '${T0}', '${T0}');
    insert into team_global_env_var_targets (env_var_id, target) values ('tg1', 'production');

    insert into environment_env_vars (id, environment_id, key, value_enc, type, created_at, updated_at)
      values ('ee1', 'env_dev', 'EE', 'enc:ee', 'plain', '${T0}', '${T0}');

    insert into shared_env_groups (id, team_id, name, description, created_at, updated_at)
      values ('g1', '${TEAM_A}', 'G', '', '${T0}', '${T0}');
    insert into shared_env_group_vars (group_id, key, value_enc, type)
      values ('g1', 'SG', 'enc:sg', 'plain'), ('g1', 'DUP', 'enc:sgdup', 'plain');
    insert into shared_env_group_apps (group_id, app_id) values ('g1', 'app_p');
    insert into shared_env_group_targets (group_id, target) values ('g1', 'production');

    -- g2: a group attached to NO app. It reached nothing before, so it must reach
    -- nothing after (and is the one legitimate mode-less row post-migration).
    insert into shared_env_groups (id, team_id, name, description, created_at, updated_at)
      values ('g2', '${TEAM_A}', 'Unattached', '', '${T0}', '${T0}');
    insert into shared_env_group_vars (group_id, key, value_enc, type)
      values ('g2', 'UNUSED', 'enc:unused', 'plain');
  `);

  // Now run 0027 — it CREATES the new tables and backfills from the seeds above —
  // and every migration after it, to bring the DB up to the live drizzle schema.
  for (const f of from27) await applyFile(f);

  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

/** The resolved key→valueEnc map for one (app, target), exactly like build.ts appEnv. */
async function resolved(
  appId: string,
  target: EnvTarget,
): Promise<Record<string, string>> {
  const [vars, sharedVars, instanceGlobals] = await Promise.all([
    loadEnvVarsForApp(appId),
    loadSharedVarsForApp(appId),
    loadInstanceEnv(),
  ]);
  const out: Record<string, string> = {};
  for (const e of resolveEnvEntries(
    target,
    appId,
    vars,
    sharedVars,
    instanceGlobals,
  )) {
    out[e.key] = e.valueEnc;
  }
  return out;
}

test("backfill produced one shared var per legacy source", async () => {
  const rows = await pg.query<{ key: string }>(
    `select key from shared_env_vars order by key`,
  );
  assert.deepEqual(rows.rows.map((r) => r.key).sort(), [
    "DUP",
    "EE",
    "SG",
    "TG",
    "UNUSED",
  ]);
});

test("the only mode-less/link-less var is the one whose group reached no app", async () => {
  // Spec §4's "no shared var left without a valid sharing mode" — the ONE legitimate
  // exception is a var exploded from a group that was attached to nothing: it
  // injected nowhere before and injects nowhere after, so parity holds and the row is
  const orphans = await pg.query<{ key: string }>(`
    select v.key from shared_env_vars v
    where v.team_wide = false
      and not exists (select 1 from shared_env_var_environments e where e.var_id = v.id)
      and not exists (select 1 from shared_env_var_projects p where p.var_id = v.id)
      and not exists (select 1 from shared_env_var_apps a where a.var_id = v.id)
  `);
  assert.deepEqual(
    orphans.rows.map((r) => r.key),
    ["UNUSED"],
  );
});

test("the unattached group's var reaches nothing, on every app and target", async () => {
  for (const app of ["app_p", "app_top"]) {
    for (const target of ["production", "preview"] as EnvTarget[]) {
      assert.equal(
        (await resolved(app, target)).UNUSED,
        undefined,
        `${app}/${target} must not inherit the unattached group's var`,
      );
    }
  }
});

test("app_p production: linked (old group) vars inject, link overrides app-own; scoped vars don't", async () => {
  assert.deepEqual(await resolved("app_p", "production"), {
    OWN: "enc:own", // app's own var
    DUP: "enc:sgdup", // shared group (now a link) overrides the app's own DUP
    SG: "enc:sg", // shared group var (linked → still injects)
    // NOT here (ADR-0012): TG (team-wide scope) and EE (environment scope) are
    // now opt-in — available on the app's Environment tab, injected only once
    // the app links them.
  });
});

test("app_top production: nothing injects (the team-wide global became opt-in)", async () => {
  // The group is not linked to app_top, and the old team-global no longer
  // auto-applies (ADR-0012).
  assert.deepEqual(await resolved("app_top", "production"), {});
});

test("scope-derived vars remain AVAILABLE: linking one injects it again", async () => {
  // The migration didn't lose the old team-global — it is one opt-in away.
  const tg = await pg.query<{ id: string }>(
    `select id from shared_env_vars where key = 'TG'`,
  );
  await pg.exec(
    `insert into shared_env_var_apps (var_id, app_id) values ('${tg.rows[0]!.id}', 'app_top')`,
  );
  assert.deepEqual(await resolved("app_top", "production"), { TG: "enc:tg" });
  await pg.exec(
    `delete from shared_env_var_apps where var_id = '${tg.rows[0]!.id}'`,
  );
});
