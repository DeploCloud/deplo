import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";

import { buildSeed } from "../../../seed";
import type { DeploData, Project, Server } from "../../../types";
import {
  deployments,
  deploymentLogs,
  domains,
  domainMiddlewares,
  envVars,
  envVarTargets,
  folders,
  projects,
  projectBuild,
  projectBuildMethodSettings,
  projectDev,
  projectExposes,
  projectMounts,
  projectVolumes,
  servers,
  sharedEnvGroups,
  sharedEnvGroupProjects,
  sharedEnvGroupTargets,
  sharedEnvGroupVars,
  teamFolderOrder,
  teamProjectOrder,
} from "../../schema/control-plane";
import { makeTestDb, type TestDb } from "../../test-harness";
import { buildConfigFor } from "../../../frameworks";
import { runBackfill } from "../engine";
import { projectGraphCutSetCopy, reconcileProjectGraph } from "./project-graph";
import { CUT_SETS, markerExists } from "../markers";

/**
 * Step 4 project-graph backfill test (relational-store PLAN §3 cut-set (c) / §7).
 * Drives the cut-set against pglite: element-granular fidelity across projects +
 * the 6 child tables + deployments + logs + domains + env + shared-env + folders +
 * the ordering junctions, the deleteProject orphan PRUNE, legacy normalization
 * (the dockerfile-source remap, mountless-volume drop, nodeVersion remap), the
 * tri-state `project_dev` (absent ⇒ no row), idempotent re-run, and
 * rollback-on-reconcile-mismatch.
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
      team_project_order, team_folder_order,
      shared_env_group_targets, shared_env_group_projects, shared_env_group_vars, shared_env_groups,
      deployment_logs, deployments, env_var_targets, env_vars,
      domain_middlewares, domains,
      project_mounts, project_volumes, project_exposes, project_dev,
      project_build_method_settings, project_build, projects,
      folders, servers, store_migration, users, teams
    restart identity cascade;
  `);
});

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const T0 = "2026-01-01T00:00:00.000Z";

function server(id: string): Server {
  return {
    id,
    name: id,
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

function baseProject(over: Partial<Project> & { id: string; teamId: string; serverId: string }): Project {
  return {
    name: over.name ?? over.id,
    slug: over.slug ?? over.id,
    folderId: null,
    framework: "nextjs",
    logo: null,
    source: "github",
    repo: null,
    dockerImage: null,
    upload: null,
    compose: null,
    expose: null,
    exposes: null,
    mounts: null,
    volumes: null,
    build: buildConfigFor("nextjs", {}),
    dev: null,
    productionUrl: null,
    status: "active",
    autoDeploy: true,
    latestDeploymentId: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

/** A rich project-graph document covering every child table + the orphan/legacy cases. */
function graphFixture(): DeploData {
  const d = buildSeed();
  d.teams = [{ id: "team_a", name: "Alpha", slug: "alpha", plan: "pro", createdAt: T0 }];
  d.users = [
    {
      id: "user_1", email: "owner@alpha.io", username: "owner", name: "Owner",
      passwordHash: "h", role: "owner", isInstanceAdmin: true, avatarColor: "#abc", createdAt: T0,
    },
  ];
  d.servers = [server("srv_1")];
  d.folders = [
    { id: "fld_1", teamId: "team_a", name: "Group", parentId: null, color: "#112233", createdAt: T0, updatedAt: T0 },
  ];
  d.projects = [
    // p1: rich — exposes, volumes (named + host), mounts, dev enabled, in folder.
    baseProject({
      id: "prj_1", teamId: "team_a", serverId: "srv_1", folderId: "fld_1",
      source: "compose", compose: "services:\n  web: {}\n",
      exposes: [
        { service: "web", port: 3000, host: "web.example.io" },
        { service: "api", port: 4000 },
      ],
      volumes: [
        { id: "vol_1", name: "data", mountPath: "/data", readOnly: false },
        { id: "vol_2", type: "host", name: "logs", hostPath: "/var/log", mountPath: "/logs", readOnly: true },
      ],
      mounts: [{ filePath: "/etc/app.toml", content: "key = \"value\"\n" }],
      dev: {
        enabled: true, status: "running", imageKind: "preset", image: "node",
        devCommand: "next dev", port: 3000, previewEnabled: true, latestStartAt: T0,
      },
      latestDeploymentId: "dpl_1",
    }),
    // p2: minimal single-image, no children, no dev (tri-state absent).
    baseProject({ id: "prj_2", teamId: "team_a", serverId: "srv_1" }),
    // p3: LEGACY dockerfile source + a mountless volume (dropped on normalize).
    baseProject({
      id: "prj_3", teamId: "team_a", serverId: "srv_1",
      source: "dockerfile" as Project["source"],
      repo: { provider: "github", url: "https://github.com/o/r", repo: "o/r", branch: "main" },
      volumes: [
        { id: "vol_bad", name: "", mountPath: "  ", readOnly: false },
        { id: "vol_ok", name: "keep", mountPath: "/keep", readOnly: false },
      ],
    }),
  ];
  d.deployments = [
    {
      id: "dpl_1", projectId: "prj_1", status: "ready", environment: "production",
      commitSha: "abc", commitMessage: "init", commitAuthor: "Owner", branch: "main",
      url: "https://web.example.io", createdAt: T0, readyAt: T0, buildDurationMs: 1000,
      creator: "Owner",
    },
    // orphan deployment — its project doesn't exist; dropped.
    {
      id: "dpl_orphan", projectId: "prj_gone", status: "error", environment: "production",
      commitSha: "", commitMessage: "x", commitAuthor: "Owner", branch: "main",
      url: "https://x", createdAt: T0, readyAt: null, buildDurationMs: null, creator: "Owner",
    },
  ];
  d.logs = {
    dpl_1: [
      { ts: T0, level: "info", text: "line one" },
      { ts: T0, level: "success", text: "line two" },
    ],
    dpl_orphan: [{ ts: T0, level: "error", text: "dropped" }],
  };
  d.envVars = [
    {
      id: "env_1", projectId: "prj_1", key: "API_KEY", valueEnc: "enc", type: "secret",
      targets: ["production", "preview"], createdAt: T0, updatedAt: T0,
    },
  ];
  d.domains = [
    {
      id: "dom_1", projectId: "prj_1", name: "web.example.io", status: "valid",
      primary: true, redirectTo: null, ssl: true, source: "auto", port: 3000,
      middlewares: ["redirect-https", "auth@file"], createdAt: T0,
    },
  ];
  d.sharedEnvGroups = [
    {
      id: "shenv_1", teamId: "team_a", name: "Common", description: "d",
      variables: [{ key: "SHARED", valueEnc: "enc2", type: "plain" }],
      // prj_gone is a DEAD id (the deleteProject orphan leak) — must be pruned.
      projectIds: ["prj_1", "prj_gone"],
      targets: ["production"],
      createdAt: T0, updatedAt: T0,
    },
  ];
  // Ordering arrays carry a dead id (prj_gone) that must drop out.
  d.teams[0]!.projectOrder = ["prj_2", "prj_gone", "prj_1"];
  d.teams[0]!.folderOrder = ["fld_1", "fld_gone"];
  return d;
}

/* ------------------------------------------------------------------ */
/* Element-granular fidelity                                            */
/* ------------------------------------------------------------------ */

test("project-graph backfill: copies projects + every child table with fidelity", async () => {
  const d = graphFixture();
  await runBackfill(db, CUT_SETS.projectGraph, d, projectGraphCutSetCopy);

  assert.equal((await db.select({ n: count() }).from(servers))[0]!.n, 1, "server seeded");
  assert.equal((await db.select({ n: count() }).from(projects))[0]!.n, 3);
  assert.equal((await db.select({ n: count() }).from(projectBuild))[0]!.n, 3);
  assert.equal((await db.select({ n: count() }).from(projectBuildMethodSettings))[0]!.n, 3);

  // p1 children.
  const exposes = await db.select().from(projectExposes).where(eq(projectExposes.projectId, "prj_1")).orderBy(projectExposes.position);
  assert.deepEqual(exposes.map((e) => [e.position, e.service, e.port, e.host]), [
    [0, "web", 3000, "web.example.io"],
    [1, "api", 4000, null],
  ]);

  const vols = await db.select().from(projectVolumes).where(eq(projectVolumes.projectId, "prj_1")).orderBy(projectVolumes.position);
  assert.equal(vols.length, 2);
  assert.equal(vols[0]!.type, null, "named volume stores NULL type");
  assert.equal(vols[1]!.type, "host");
  assert.equal(vols[1]!.hostPath, "/var/log");
  assert.equal(vols[1]!.readOnly, true);

  const mounts = await db.select().from(projectMounts).where(eq(projectMounts.projectId, "prj_1"));
  assert.equal(mounts[0]!.content, "key = \"value\"\n", "mount content byte-equal");

  // project_dev: one row (p1 only — tri-state).
  assert.equal((await db.select({ n: count() }).from(projectDev))[0]!.n, 1);
  const dev = await db.select().from(projectDev).where(eq(projectDev.projectId, "prj_1"));
  assert.equal(dev[0]!.status, "running");
  assert.equal(dev[0]!.enabled, true);

  // latest_deployment_id second pass.
  const p1 = await db.select().from(projects).where(eq(projects.id, "prj_1"));
  assert.equal(p1[0]!.latestDeploymentId, "dpl_1");

  // LEGACY: prj_3 dockerfile source remapped to github (its repo is github).
  const p3 = await db.select().from(projects).where(eq(projects.id, "prj_3"));
  assert.equal(p3[0]!.source, "github", "legacy dockerfile source remapped");
  const p3build = await db.select().from(projectBuild).where(eq(projectBuild.projectId, "prj_3"));
  assert.equal(p3build[0]!.buildMethod, "dockerfile", "legacy source folds into dockerfile build method");
  // The mountless volume dropped, the good one kept.
  const p3vols = await db.select().from(projectVolumes).where(eq(projectVolumes.projectId, "prj_3"));
  assert.equal(p3vols.length, 1);
  assert.equal(p3vols[0]!.name, "keep");

  // deployments: orphan dropped.
  assert.equal((await db.select({ n: count() }).from(deployments))[0]!.n, 1);
  // logs: only dpl_1's lines, in order.
  const logs = await db.select().from(deploymentLogs).orderBy(deploymentLogs.id);
  assert.equal(logs.length, 2);
  assert.deepEqual(logs.map((l) => l.text), ["line one", "line two"]);

  // env + targets.
  assert.equal((await db.select({ n: count() }).from(envVars))[0]!.n, 1);
  assert.equal((await db.select({ n: count() }).from(envVarTargets))[0]!.n, 2);

  // domains + middlewares (ordered).
  assert.equal((await db.select({ n: count() }).from(domains))[0]!.n, 1);
  const mw = await db.select().from(domainMiddlewares).where(eq(domainMiddlewares.domainId, "dom_1")).orderBy(domainMiddlewares.position);
  assert.deepEqual(mw.map((m) => m.name), ["redirect-https", "auth@file"]);
  const dom = await db.select().from(domains).where(eq(domains.id, "dom_1"));
  assert.equal(dom[0]!.isPrimary, true);

  // shared env group: dead project id PRUNED (prj_gone dropped, prj_1 kept).
  assert.equal((await db.select({ n: count() }).from(sharedEnvGroups))[0]!.n, 1);
  assert.equal((await db.select({ n: count() }).from(sharedEnvGroupVars))[0]!.n, 1);
  const links = await db.select().from(sharedEnvGroupProjects);
  assert.deepEqual(links.map((l) => l.projectId), ["prj_1"], "dead projectId pruned");
  assert.equal((await db.select({ n: count() }).from(sharedEnvGroupTargets))[0]!.n, 1);

  // folders.
  assert.equal((await db.select({ n: count() }).from(folders))[0]!.n, 1);

  // ordering junctions: dead ids (prj_gone, fld_gone) excluded; position over survivors.
  const order = await db.select().from(teamProjectOrder).orderBy(teamProjectOrder.position);
  assert.deepEqual(order.map((o) => [o.projectId, o.position]), [
    ["prj_2", 0],
    ["prj_1", 1],
  ]);
  const forder = await db.select().from(teamFolderOrder).orderBy(teamFolderOrder.position);
  assert.deepEqual(forder.map((o) => [o.folderId, o.position]), [["fld_1", 0]]);

  assert.equal(await markerExists(db, CUT_SETS.projectGraph), true);
});

/* ------------------------------------------------------------------ */
/* Idempotent re-run + fresh-install                                   */
/* ------------------------------------------------------------------ */

test("project-graph backfill: idempotent re-run is a no-op", async () => {
  const d = graphFixture();
  await runBackfill(db, CUT_SETS.projectGraph, d, projectGraphCutSetCopy);
  // A second run sees the marker and copies nothing (no PK collisions).
  await runBackfill(db, CUT_SETS.projectGraph, d, projectGraphCutSetCopy);
  assert.equal((await db.select({ n: count() }).from(projects))[0]!.n, 3);
});

test("project-graph backfill: fresh install marks done with zero rows", async () => {
  const d = buildSeed(); // empty collections
  await runBackfill(db, CUT_SETS.projectGraph, d, projectGraphCutSetCopy);
  assert.equal((await db.select({ n: count() }).from(projects))[0]!.n, 0);
  assert.equal(await markerExists(db, CUT_SETS.projectGraph), true);
});

/* ------------------------------------------------------------------ */
/* Rollback on reconcile mismatch                                       */
/* ------------------------------------------------------------------ */

test("project-graph backfill: a reconcile mismatch rolls the whole tx back", async () => {
  const d = graphFixture();
  // A copy that inserts the real rows, then re-runs the element-granular reconcile
  // against an INFLATED source (an extra project the copy never inserted) so the
  // count assert throws — proving a mismatch aborts the whole tx (PLAN §7).
  const inflated: DeploData = {
    ...d,
    projects: [...d.projects, baseProject({ id: "prj_ghost", teamId: "team_a", serverId: "srv_1" })],
  };
  await assert.rejects(
    () =>
      runBackfill(db, CUT_SETS.projectGraph, d, async (tx) => {
        await projectGraphCutSetCopy(tx, d); // copies the real 3 projects + reconciles OK
        await reconcileProjectGraph(tx, inflated); // re-reconcile vs tampered source → throws
      }),
    /reconcile mismatch/,
  );
  // Rolled back: nothing committed, marker absent.
  assert.equal((await db.select({ n: count() }).from(projects))[0]!.n, 0);
  assert.equal(await markerExists(db, CUT_SETS.projectGraph), false);
});
