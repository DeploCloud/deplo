import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";

import { buildSeed } from "../../../seed";
import type { DeploData, Server } from "../../../types";
import {
  backups,
  backupRuns,
  databases,
  s3Destination,
  servers,
} from "../../schema/control-plane";
import { makeTestDb, type TestDb } from "../../test-harness";
import { runBackfill } from "../engine";
import { backupsCutSetCopy, reconcileBackups } from "./backups";
import { CUT_SETS, markerExists } from "../markers";
import { teams as teamsTable } from "../../schema/control-plane";
import { seedProject, seedServer } from "../../../data/project-graph-test-helpers";

/**
 * Cut-set (d) runs LAST — identity (b) and the project graph (c) are already
 * relational when it copies. The backfill itself idempotently seeds teams/users/
 * servers (so the copy never relies on this), but a project-target backup FKs the
 * `projects` table (owned by cut-set (c)), so the test seeds that prerequisite the
 * way production ordering provides it: a team row + a server + the project.
 */
async function seedProjectGraphPrereqs(): Promise<void> {
  await db
    .insert(teamsTable)
    .values({ id: "team_a", name: "Alpha", slug: "alpha", plan: "pro", createdAt: T0 })
    .onConflictDoNothing();
  await seedServer(db, "srv_1");
  await seedProject(db, { id: "prj_1", teamId: "team_a", serverId: "srv_1" });
}

/**
 * Step 5 backups backfill test (relational-store PLAN §3 cut-set (d) / §7). Drives
 * the cut-set against pglite: element-granular fidelity across databases + s3 +
 * backups + backup_runs, the orphan PRUNE (a schedule with a dead target/
 * destination is dropped; a run with a dead destination is dropped, a run with a
 * dead target/owning-schedule is kept with those FKs NULLed), seq in source-array
 * order, idempotent re-run, fresh-install-zero, and rollback-on-reconcile-mismatch.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
});

after(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    truncate table
      backup_runs, backups, databases, s3_destination,
      project_build_method_settings, project_build, projects,
      servers, store_migration, users, teams
    restart identity cascade;
  `);
});

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const T0 = "2026-01-01T00:00:00.000Z";

function serverRow(): Server {
  return {
    id: "srv_1",
    name: "srv_1",
    host: "10.0.0.1",
    type: "remote",
    status: "online",
    ip: "10.0.0.1",
    dockerVersion: "27",
    traefikEnabled: true,
    cpuCores: 4,
    memoryMb: 8192,
    diskGb: 100,
    cpuUsage: 1,
    memoryUsage: 1,
    diskUsage: 1,
    createdAt: T0,
  };
}

/** A backups document covering both target kinds + the orphan/prune cases. */
function backupsFixture(): DeploData {
  const d = buildSeed();
  d.teams = [{ id: "team_a", name: "Alpha", slug: "alpha", plan: "pro", createdAt: T0 }];
  d.servers = [serverRow()];
  // A live project (cut-set c is relational; the live JSONB still carries it).
  d.projects = [
    {
      id: "prj_1", name: "p1", slug: "p1", teamId: "team_a", folderId: null,
      serverId: "srv_1", framework: "nextjs", logo: null, source: "github",
      repo: null, dockerImage: null, upload: null, compose: null, expose: null,
      exposes: null, mounts: null, volumes: null,
      build: { framework: "nextjs", buildMethod: "nixpacks", methodSettings: {} } as never,
      dev: null, productionUrl: null, status: "active", autoDeploy: true,
      latestDeploymentId: null, createdAt: T0, updatedAt: T0,
    },
  ];
  d.databases = [
    {
      id: "db_1", teamId: "team_a", name: "main", type: "postgres", version: "16",
      status: "running", serverId: "srv_1", host: "db-main", port: 5432,
      connectionStringEnc: "enc", exposedPublicly: false, sizeMb: 10, createdAt: T0,
    },
  ];
  d.s3Destinations = [
    {
      id: "s3_1", teamId: "team_a", name: "Backblaze", provider: "backblaze-b2",
      endpoint: "https://s3.eu.backblazeb2.com", region: "eu", bucket: "b",
      accessKeyEnc: "ak", secretKeyEnc: "sk", status: "connected", createdAt: T0,
    },
  ];
  d.backups = [
    // b1: live database target → kept.
    {
      id: "bkp_1", teamId: "team_a", name: "nightly-db", targetKind: "database",
      databaseId: "db_1", projectId: null, destinationId: "s3_1",
      schedule: "0 3 * * *", retentionDays: 7, lastRunAt: null, lastStatus: "never",
      enabled: true, createdAt: T0,
    },
    // b2: live project target → kept.
    {
      id: "bkp_2", teamId: "team_a", name: "nightly-prj", targetKind: "project",
      databaseId: null, projectId: "prj_1", destinationId: "s3_1",
      schedule: "0 4 * * *", retentionDays: 14, lastRunAt: null, lastStatus: "never",
      enabled: true, createdAt: T0,
    },
    // b3: DEAD database target (the deleteDatabase orphan leak) → PRUNED.
    {
      id: "bkp_dead_target", teamId: "team_a", name: "dead", targetKind: "database",
      databaseId: "db_gone", projectId: null, destinationId: "s3_1",
      schedule: "0 5 * * *", retentionDays: 7, lastRunAt: null, lastStatus: "never",
      enabled: true, createdAt: T0,
    },
    // b4: DEAD destination (the deleteS3 legacy orphan) → PRUNED.
    {
      id: "bkp_dead_dest", teamId: "team_a", name: "deaddest", targetKind: "database",
      databaseId: "db_1", projectId: null, destinationId: "s3_gone",
      schedule: "0 6 * * *", retentionDays: 7, lastRunAt: null, lastStatus: "never",
      enabled: true, createdAt: T0,
    },
  ];
  d.backupRuns = [
    // r1, r2: live destination, live db target → kept (seq order preserved).
    {
      id: "brun_1", teamId: "team_a", backupId: "bkp_1", targetKind: "database",
      databaseId: "db_1", projectId: null, destinationId: "s3_1",
      objectKey: "deplo/team_a/database/db_1/1-brun_1.dump.gz", sizeBytes: 100,
      status: "success", error: null, startedAt: T0, finishedAt: T0,
    },
    {
      id: "brun_2", teamId: "team_a", backupId: "bkp_1", targetKind: "database",
      databaseId: "db_1", projectId: null, destinationId: "s3_1",
      objectKey: "deplo/team_a/database/db_1/2-brun_2.dump.gz", sizeBytes: 200,
      status: "success", error: null, startedAt: T0, finishedAt: T0,
    },
    // r3: live destination but DEAD db target + DEAD owning schedule → kept, FKs NULLed.
    {
      id: "brun_orphan_target", teamId: "team_a", backupId: "bkp_gone",
      targetKind: "database", databaseId: "db_gone", projectId: null,
      destinationId: "s3_1", objectKey: "deplo/team_a/database/db_gone/x.dump.gz",
      sizeBytes: 50, status: "success", error: null, startedAt: T0, finishedAt: T0,
    },
    // r4: DEAD destination → PRUNED.
    {
      id: "brun_dead_dest", teamId: "team_a", backupId: null, targetKind: "database",
      databaseId: "db_1", projectId: null, destinationId: "s3_gone",
      objectKey: "x", sizeBytes: 1, status: "failed", error: "x",
      startedAt: T0, finishedAt: T0,
    },
  ];
  return d;
}

/* ------------------------------------------------------------------ */
/* Element-granular fidelity                                            */
/* ------------------------------------------------------------------ */

test("backups backfill: copies databases + s3 + schedules + runs with fidelity", async () => {
  await seedProjectGraphPrereqs(); // cut-set (c) ran first → prj_1 is relational
  const d = backupsFixture();
  await runBackfill(db, CUT_SETS.backups, d, backupsCutSetCopy);

  assert.equal((await db.select({ n: count() }).from(servers))[0]!.n, 1, "server seeded");
  assert.equal((await db.select({ n: count() }).from(databases))[0]!.n, 1);
  assert.equal((await db.select({ n: count() }).from(s3Destination))[0]!.n, 1);

  // backups: b1 + b2 kept; b3 (dead target) + b4 (dead destination) pruned.
  const sched = await db.select().from(backups).orderBy(backups.id);
  assert.deepEqual(sched.map((b) => b.id), ["bkp_1", "bkp_2"]);
  assert.equal(sched.find((b) => b.id === "bkp_2")!.targetKind, "project");

  // backup_runs: r1, r2 kept intact; r3 kept with dead FKs NULLed; r4 pruned.
  const runs = await db.select().from(backupRuns).orderBy(backupRuns.seq);
  assert.deepEqual(runs.map((r) => r.id), ["brun_1", "brun_2", "brun_orphan_target"]);
  // seq reproduces insertion (source-array) order.
  assert.ok(runs[0]!.seq < runs[1]!.seq && runs[1]!.seq < runs[2]!.seq, "seq is ascending in source order");
  // r1/r2 keep their live FKs.
  assert.equal(runs[0]!.databaseId, "db_1");
  assert.equal(runs[0]!.backupId, "bkp_1");
  // r3: dead databaseId + dead backupId NULLed, but the run (history) survives.
  const r3 = runs.find((r) => r.id === "brun_orphan_target")!;
  assert.equal(r3.databaseId, null, "dead databaseId NULLed");
  assert.equal(r3.backupId, null, "dead owning-schedule backupId NULLed");
  assert.equal(r3.destinationId, "s3_1", "live destination kept");

  assert.equal(await markerExists(db, CUT_SETS.backups), true);
});

/* ------------------------------------------------------------------ */
/* Idempotent re-run + fresh install                                   */
/* ------------------------------------------------------------------ */

test("backups backfill: idempotent re-run is a no-op", async () => {
  await seedProjectGraphPrereqs();
  const d = backupsFixture();
  await runBackfill(db, CUT_SETS.backups, d, backupsCutSetCopy);
  await runBackfill(db, CUT_SETS.backups, d, backupsCutSetCopy);
  assert.equal((await db.select({ n: count() }).from(backups))[0]!.n, 2);
  assert.equal((await db.select({ n: count() }).from(backupRuns))[0]!.n, 3);
});

test("backups backfill: fresh install marks done with zero rows", async () => {
  const d = buildSeed(); // empty collections
  await runBackfill(db, CUT_SETS.backups, d, backupsCutSetCopy);
  assert.equal((await db.select({ n: count() }).from(backups))[0]!.n, 0);
  assert.equal((await db.select({ n: count() }).from(databases))[0]!.n, 0);
  assert.equal(await markerExists(db, CUT_SETS.backups), true);
});

/* ------------------------------------------------------------------ */
/* Rollback on reconcile mismatch                                       */
/* ------------------------------------------------------------------ */

test("backups backfill: a reconcile mismatch rolls the whole tx back", async () => {
  await seedProjectGraphPrereqs();
  const d = backupsFixture();
  // Re-reconcile against an INFLATED source (an extra database the copy never
  // inserted) so the count assert throws → the whole tx rolls back (PLAN §7).
  const inflated: DeploData = {
    ...d,
    databases: [
      ...d.databases,
      { ...d.databases[0]!, id: "db_ghost", name: "ghost" },
    ],
  };
  await assert.rejects(
    () =>
      runBackfill(db, CUT_SETS.backups, d, async (tx) => {
        await backupsCutSetCopy(tx, d); // copies the real rows + reconciles OK
        await reconcileBackups(tx, inflated); // re-reconcile vs tampered → throws
      }),
    /reconcile mismatch/,
  );
  assert.equal((await db.select({ n: count() }).from(databases))[0]!.n, 0);
  assert.equal(await markerExists(db, CUT_SETS.backups), false);
});

/* ------------------------------------------------------------------ */
/* Legacy hardening — a run whose target project is dead keeps its history */
/* ------------------------------------------------------------------ */

test("backups backfill: a project run with a dead target keeps history, NULLs projectId", async () => {
  const d = buildSeed();
  d.teams = [{ id: "team_a", name: "Alpha", slug: "alpha", plan: "pro", createdAt: T0 }];
  d.servers = [serverRow()];
  d.s3Destinations = [
    {
      id: "s3_1", teamId: "team_a", name: "S3", provider: "aws",
      endpoint: "https://s3.amazonaws.com", region: "us-east-1", bucket: "b",
      accessKeyEnc: "ak", secretKeyEnc: "sk", status: "connected", createdAt: T0,
    },
  ];
  // A project run whose project was deleted (prj_gone not in d.projects).
  d.backupRuns = [
    {
      id: "brun_p", teamId: "team_a", backupId: null, targetKind: "project",
      databaseId: null, projectId: "prj_gone", destinationId: "s3_1",
      objectKey: "deplo/team_a/project/prj_gone/x.tar.gz", sizeBytes: 7,
      status: "success", error: null, startedAt: T0, finishedAt: T0,
    },
  ];
  await runBackfill(db, CUT_SETS.backups, d, backupsCutSetCopy);
  const rows = await db.select().from(backupRuns).where(eq(backupRuns.id, "brun_p"));
  assert.equal(rows.length, 1, "the run history survives");
  assert.equal(rows[0]!.projectId, null, "dead projectId NULLed");
});
