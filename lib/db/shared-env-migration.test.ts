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
  envVars as envVarsTable,
  envVarTargets as envVarTargetsTable,
  projects as projectsTable,
  environments as environmentsTable,
  apps as appsTable,
} from "./schema/control-plane";
import {
  seedIdentity,
  TEAM_A,
  USER_1,
} from "../data/identity-test-helpers";
import { seedServer, seedApp } from "../data/app-graph-test-helpers";
import { loadEnvVarsForApp } from "../data/app-graph-load";
import { loadSharedVarsForApp } from "../data/shared-vars";
import { loadInstanceEnv } from "../data/global-env";
import { resolveEnvEntries } from "../deploy/env-resolve";
import type { EnvTarget } from "../types";

/**
 * Migration-parity test for ADR-0010 (spec §4 "final check"). It replays the
 * committed migrations up to 0027 ONLY (old tables still present after 0027's
 * backfill, dropped only in 0028), seeds representative old-world data — a team-
 * global, an environment-scoped var, and a shared group attached to an app whose
 * key COLLIDES with the app's own var — then asserts the NEW loader + resolver
 * yields the byte-identical resolved key→value map per (app, target) the old
 * system did. value_enc is compared verbatim (the backfill copies it), so no
 * decryption is needed.
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

  // Replay committed migrations 0000..0027 (STOP before 0028 so the legacy tables
  // the backfill reads still exist and can be seeded/verified).
  const files = readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const upto = files.filter((f) => Number(f.slice(0, 4)) <= 27);
  const pre27 = upto.filter((f) => Number(f.slice(0, 4)) < 27);
  const only27 = upto.filter((f) => Number(f.slice(0, 4)) === 27);

  for (const f of pre27) await applyFile(f);

  // --- Seed old-world fixtures BETWEEN 0026 and 0027 (via the seed helpers so
  // the many required team/app columns stay correct) ---
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
  await seedServer(db);
  await db.insert(projectsTable).values({
    id: "prc_1",
    teamId: TEAM_A,
    name: "P",
    slug: "p",
    color: null,
    ownerUserId: USER_1,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(environmentsTable).values([
    { id: "env_dev", projectId: "prc_1", name: "Development", slug: "development", kind: "development", gitBranch: "", isDefault: true, position: 0, createdAt: T0, updatedAt: T0 },
    { id: "env_prod", projectId: "prc_1", name: "Production", slug: "production", kind: "production", gitBranch: "", isDefault: false, position: 1, createdAt: T0, updatedAt: T0 },
  ]);
  // app_p lives in the project's Development env; app_top is top-level.
  await seedApp(db, { id: "app_p", teamId: TEAM_A });
  await seedApp(db, { id: "app_top", teamId: TEAM_A });
  await db
    .update(appsTable)
    .set({ projectId: "prc_1", environmentId: "env_dev" })
    .where(eq(appsTable.id, "app_p"));
  // app_p's OWN vars: OWN (unique) + DUP (collides with the shared group).
  await db.insert(envVarsTable).values([
    { id: "ev_own", appId: "app_p", key: "OWN", valueEnc: "enc:own", type: "plain", createdAt: T0, updatedAt: T0 },
    { id: "ev_dup", appId: "app_p", key: "DUP", valueEnc: "enc:appdup", type: "plain", createdAt: T0, updatedAt: T0 },
  ]);
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

  // Now run 0027 — it CREATES the new tables and backfills from the seeds above.
  for (const f of only27) await applyFile(f);

  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

/** The resolved key→valueEnc map for one (app, target), exactly like build.ts appEnv. */
async function resolved(appId: string, target: EnvTarget): Promise<Record<string, string>> {
  const [vars, sharedVars, instanceGlobals] = await Promise.all([
    loadEnvVarsForApp(appId),
    loadSharedVarsForApp(appId),
    loadInstanceEnv(),
  ]);
  const out: Record<string, string> = {};
  for (const e of resolveEnvEntries(target, appId, vars, sharedVars, instanceGlobals)) {
    out[e.key] = e.valueEnc;
  }
  return out;
}

test("backfill produced one shared var per legacy source", async () => {
  const rows = await pg.query<{ key: string }>(`select key from shared_env_vars order by key`);
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
  // injected nowhere before and injects nowhere after, so parity holds and the row
  // is kept rather than destroying the user's authored value. It is editable in the
  // Shared tab (assigning it a mode is exactly what saveSharedVar demands).
  const orphans = await pg.query<{ key: string }>(`
    select v.key from shared_env_vars v
    where v.team_wide = false
      and not exists (select 1 from shared_env_var_environments e where e.var_id = v.id)
      and not exists (select 1 from shared_env_var_projects p where p.var_id = v.id)
      and not exists (select 1 from shared_env_var_apps a where a.var_id = v.id)
  `);
  assert.deepEqual(orphans.rows.map((r) => r.key), ["UNUSED"]);
});

test("every var that reached an app before still reaches it (no lost coverage)", async () => {
  // The unattached group's var must reach NOTHING, on every app and every target.
  for (const app of ["app_p", "app_top"]) {
    for (const target of ["production", "preview", "development"] as EnvTarget[]) {
      assert.equal(
        (await resolved(app, target)).UNUSED,
        undefined,
        `${app}/${target} must not inherit the unattached group's var`,
      );
    }
  }
});

test("parity: app_p production resolves identically (env membership + link overrides app-own)", async () => {
  assert.deepEqual(await resolved("app_p", "production"), {
    TG: "enc:tg", // team-global → team-wide
    EE: "enc:ee", // environment membership (targets = all)
    OWN: "enc:own", // app's own var
    DUP: "enc:sgdup", // shared group (now a link) overrides the app's own DUP
    SG: "enc:sg", // shared group var
  });
});

test("parity: app_p development gets only the membership env var", async () => {
  // TG/app-own/group all target production only; the env var (targets=all) reaches dev.
  assert.deepEqual(await resolved("app_p", "development"), { EE: "enc:ee" });
});

test("parity: app_top production gets only the team-wide global", async () => {
  // The group is not linked to app_top; the env var belongs to app_p's env only.
  assert.deepEqual(await resolved("app_top", "production"), { TG: "enc:tg" });
});
