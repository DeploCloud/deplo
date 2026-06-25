import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { count, eq } from "drizzle-orm";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  deployments as deploymentsTable,
  deploymentLogs,
  domains as domainsTable,
  envVars as envVarsTable,
  envVarTargets as envVarTargetsTable,
  projects as projectsTable,
  sharedEnvGroupProjects,
  teamProjectOrder,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedProject,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "./project-graph-test-helpers";
import { __resetDeploymentLogBuffers } from "./deployment-logs";
import {
  listProjects,
  reorderProjects,
  deleteProject,
  createProject,
  summarizeForTeam,
} from "./projects";
import {
  addDomain,
  setPrimaryDomain,
  listDomains,
  ensureAutoDomain,
  ensureExtraDomain,
  uniqueAutoDomainName,
} from "./domains";
import { loadDomainsForProject } from "./project-graph-load";
import { nipEmbeddedIp } from "../deploy/domains";
import { upsertEnv, listEnv } from "./env";
import { saveSharedEnvGroup, setSharedEnvGroupAttachment } from "./shared-env";

/**
 * Step 4 project-graph data-layer tests (relational-store PLAN §3 cut-set (c) /
 * §9 Step 4): the deleteProject CASCADE (no orphaned deployments/logs/env/
 * domains/shared-group attachments), the two-concurrent primary-domain race, the
 * ordering-junction reorder, and the cookie-free summary lookups the SSE
 * generator drives. Seeded relationally via the test-seed helpers.
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  __resetDeploymentLogBuffers();
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/* ------------------------------------------------------------------ */
/* deleteProject CASCADE — the orphan-bug fix                          */
/* ------------------------------------------------------------------ */

test("deleteProject cascades every child + shared-group attachment (no orphans)", async () => {
  await seedProject(db, { id: "prj_1", status: "active" });
  await seedProject(db, { id: "prj_2", status: "active" });
  await seedDeployment(db, { id: "dpl_1", projectId: "prj_1" });
  // A log line on prj_1's deployment.
  await db.insert(deploymentLogs).values({ deploymentId: "dpl_1", ts: "2026-01-01T00:00:00.000Z", level: "info", text: "x" });

  await asUser1(async () => {
    // An env var + a domain on prj_1.
    await upsertEnv({ projectId: "prj_1", key: "K", value: "v", targets: ["production"], type: "plain" });
    await addDomain("prj_1", "app.example.io", {});
    // A shared group attached to BOTH projects (the orphan the old bug leaked).
    await saveSharedEnvGroup({
      name: "Common",
      description: "",
      blob: "SHARED=1",
      projectIds: ["prj_1", "prj_2"],
      targets: ["production"],
    });
    await deleteProject("prj_1");
  });

  // prj_1 and ALL its children are gone; prj_2 untouched.
  assert.equal((await db.select({ n: count() }).from(projectsTable))[0]!.n, 1);
  assert.equal((await db.select({ n: count() }).from(deploymentsTable))[0]!.n, 0, "deployments cascade");
  assert.equal((await db.select({ n: count() }).from(deploymentLogs))[0]!.n, 0, "logs cascade");
  assert.equal((await db.select({ n: count() }).from(envVarsTable))[0]!.n, 0, "env vars cascade");
  assert.equal((await db.select({ n: count() }).from(envVarTargetsTable))[0]!.n, 0, "env targets cascade");
  assert.equal((await db.select({ n: count() }).from(domainsTable))[0]!.n, 0, "domains cascade");
  // The shared-group attachment to prj_1 is GONE (the orphan the JSONB bug
  // leaked); the prj_2 attachment survives.
  const links = await db.select().from(sharedEnvGroupProjects);
  assert.deepEqual(links.map((l) => l.projectId), ["prj_2"], "dead attachment cascaded, live one kept");
});

/* ------------------------------------------------------------------ */
/* setPrimaryDomain — single-UPDATE flip + concurrent race            */
/* ------------------------------------------------------------------ */

test("setPrimaryDomain flips exactly one primary per project", async () => {
  await seedProject(db, { id: "prj_1", status: "active" });
  let domBId = "";
  await asUser1(async () => {
    await addDomain("prj_1", "a.example.io", {}); // first ⇒ primary
    const b = await addDomain("prj_1", "b.example.io", {});
    domBId = b.id;
    await setPrimaryDomain(domBId);
    const list = await listDomains("prj_1");
    const primaries = list.filter((d) => d.primary);
    assert.equal(primaries.length, 1, "exactly one primary");
    assert.equal(primaries[0]!.id, domBId, "the chosen domain is primary");
  });
  // The partial-unique `(project_id) WHERE is_primary` holds at the DB level.
  const dbPrimaries = await db
    .select({ n: count() })
    .from(domainsTable)
    .where(eq(domainsTable.isPrimary, true));
  assert.equal(dbPrimaries[0]!.n, 1);
});

test("two concurrent setPrimaryDomain calls leave exactly one primary", async () => {
  await seedProject(db, { id: "prj_1", status: "active" });
  let aId = "";
  let bId = "";
  await asUser1(async () => {
    const a = await addDomain("prj_1", "a.example.io", {});
    const b = await addDomain("prj_1", "b.example.io", {});
    aId = a.id;
    bId = b.id;
    // Fire both flips "concurrently" (pglite serializes on the event loop, but
    // the single-UPDATE + partial-unique guarantees a consistent end state).
    await Promise.all([setPrimaryDomain(aId), setPrimaryDomain(bId)]);
  });
  const primaries = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.isPrimary, true));
  assert.equal(primaries.length, 1, "exactly one primary survives the race");
});

/* ------------------------------------------------------------------ */
/* Ordering junction — reorderProjects                                 */
/* ------------------------------------------------------------------ */

test("reorderProjects writes the team_project_order junction; dead ids drop", async () => {
  await seedProject(db, { id: "prj_1", status: "active" });
  await seedProject(db, { id: "prj_2", status: "active" });
  await asUser1(async () => {
    // Reorder with a dead id ("ghost") that must be dropped.
    await reorderProjects(["prj_2", "ghost", "prj_1"]);
  });
  const rows = await db
    .select()
    .from(teamProjectOrder)
    .where(eq(teamProjectOrder.teamId, TEAM_A))
    .orderBy(teamProjectOrder.position);
  assert.deepEqual(rows.map((r) => [r.projectId, r.position]), [
    ["prj_2", 0],
    ["prj_1", 1],
  ]);
  // listProjects honours the manual order.
  await asUser1(async () => {
    const list = await listProjects();
    assert.deepEqual(list.map((p) => p.id), ["prj_2", "prj_1"]);
  });
});

/* ------------------------------------------------------------------ */
/* Cookie-free summary lookups (the SSE seam) + team scoping           */
/* ------------------------------------------------------------------ */

test("summarizeForTeam is cookie-free and team-scoped", async () => {
  await seedProject(db, { id: "prj_1", teamId: TEAM_A, status: "active" });
  // No runWithIdentity wrapper — proves it never reads a cookie/active team.
  const mine = await summarizeForTeam("prj_1", TEAM_A);
  assert.ok(mine, "found for the owning team");
  assert.equal(mine!.id, "prj_1");
  const other = await summarizeForTeam("prj_1", TEAM_B);
  assert.equal(other, null, "not visible to another team");
});

test("env vars + targets round-trip through the relational layer", async () => {
  await seedProject(db, { id: "prj_1", status: "active" });
  await asUser1(async () => {
    await upsertEnv({
      projectId: "prj_1",
      key: "API_KEY",
      value: "s3cret",
      targets: ["production", "preview"],
      type: "secret",
    });
    const list = await listEnv("prj_1");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.masked, true, "secret is masked in the DTO");
    assert.deepEqual([...list[0]!.targets].sort(), ["preview", "production"]);
  });
  // The value is stored encrypted (not plaintext).
  const rows = await db.select().from(envVarsTable).where(eq(envVarsTable.projectId, "prj_1"));
  assert.notEqual(rows[0]!.valueEnc, "s3cret");
});

test("shared-group attach/detach toggles the junction", async () => {
  await seedProject(db, { id: "prj_1", status: "active" });
  let groupId = "";
  await asUser1(async () => {
    await saveSharedEnvGroup({
      name: "G",
      description: "",
      blob: "X=1",
      projectIds: [],
      targets: ["production"],
    });
    // The group exists; attach it to prj_1.
    const { listSharedEnvGroups } = await import("./shared-env");
    groupId = (await listSharedEnvGroups())[0]!.id;
    await setSharedEnvGroupAttachment(groupId, "prj_1", true);
  });
  assert.equal((await db.select({ n: count() }).from(sharedEnvGroupProjects))[0]!.n, 1);
  await asUser1(() => setSharedEnvGroupAttachment(groupId, "prj_1", false));
  assert.equal((await db.select({ n: count() }).from(sharedEnvGroupProjects))[0]!.n, 0);
});

/* ------------------------------------------------------------------ */
/* createProject slug uniqueness under concurrency                     */
/* ------------------------------------------------------------------ */

test("two concurrent same-name createProject calls both succeed with distinct slugs", async () => {
  // createProject reads the server picklist from the relational `servers` table;
  // `beforeEach`'s `seedServer(db)` already seeded `srv_1`. "upload" source skips
  // the post-commit deploy (no agent dial), keeping the test hermetic.
  const input = {
    name: "My App",
    framework: "node" as const,
    source: "upload" as const,
    repo: null,
  };
  const [a, b] = await asUser1(() =>
    Promise.all([createProject(input), createProject(input)]),
  );
  // Both persisted, with DISTINCT slugs (the second retried past the unique
  // violation onto the next free suffix).
  assert.notEqual(a.slug, b.slug, "concurrent same-name creates get distinct slugs");
  const rows = await db.select({ slug: projectsTable.slug }).from(projectsTable);
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((r) => r.slug)).size, 2, "two unique slugs persisted");
});

/* ------------------------------------------------------------------ */
/* Generated-domain uniqueness (no duplicate hostnames, globally)      */
/* ------------------------------------------------------------------ */

const IP = "1.2.3.4";

test("uniqueAutoDomainName never returns a host that already exists globally", async () => {
  await seedProject(db, { id: "prj_u", slug: "uniq" });
  // Pre-occupy 25 hosts under the same label+IP so generation must dodge them.
  const taken = new Set<string>();
  await asUser1(async () => {
    for (let i = 0; i < 25; i++) {
      const name = await uniqueAutoDomainName("uniq", IP);
      assert.ok(!taken.has(name), `generated a duplicate: ${name}`);
      taken.add(name);
      // Persist it so the NEXT call must avoid it too (global check).
      await ensureExtraDomain("prj_u", name, { port: 80, service: null, slug: "uniq", ip: IP });
    }
  });
  // Every persisted domain name is distinct.
  const rows = await loadDomainsForProject("prj_u");
  assert.equal(new Set(rows.map((d) => d.name)).size, rows.length);
  assert.equal(rows.length, 25);
});

test("ensureExtraDomain regenerates (not skips) when the template host collides with ANOTHER project", async () => {
  await seedProject(db, { id: "prj_a", slug: "alpha" });
  await seedProject(db, { id: "prj_b", slug: "beta" });
  // Project A claims a host.
  const shared = `shared-charming-otter-${"01020304"}.nip.io`;
  await asUser1(() =>
    ensureExtraDomain("prj_a", shared, { port: 80, service: "web", slug: "alpha", ip: IP }),
  );
  // Project B is handed the SAME host by its (hypothetical) template — it must
  // get a fresh unique host, NOT silently skip and NOT duplicate A's host.
  await asUser1(() =>
    ensureExtraDomain("prj_b", shared, { port: 80, service: "web", slug: "beta", ip: IP }),
  );
  const bDomains = await loadDomainsForProject("prj_b");
  assert.equal(bDomains.length, 1, "B got a domain (regenerated, not dropped)");
  assert.notEqual(bDomains[0].name, shared, "B did not reuse A's colliding host");
  assert.equal(nipEmbeddedIp(bDomains[0].name), IP, "B's host still encodes the IP");
  // A keeps the original; the two never share a name.
  const aDomains = await loadDomainsForProject("prj_a");
  assert.equal(aDomains[0].name, shared);
});

test("ensureExtraDomain is idempotent on the SAME project (re-run does not duplicate)", async () => {
  await seedProject(db, { id: "prj_c", slug: "gamma" });
  const host = `gamma-bold-lynx-${"01020304"}.nip.io`;
  await asUser1(async () => {
    await ensureExtraDomain("prj_c", host, { port: 80, service: "web", slug: "gamma", ip: IP });
    await ensureExtraDomain("prj_c", host, { port: 80, service: "web", slug: "gamma", ip: IP });
  });
  const rows = await loadDomainsForProject("prj_c");
  assert.equal(rows.length, 1, "the same host on the same project is not duplicated");
  assert.equal(rows[0].name, host);
});

test("ensureAutoDomain regenerates when its `preferred` host belongs to another project", async () => {
  await seedProject(db, { id: "prj_x", slug: "xeno" });
  await seedProject(db, { id: "prj_y", slug: "yeti" });
  const preferred = `pref-keen-puma-${"01020304"}.nip.io`;
  // X claims `preferred` as its primary.
  const xName = await asUser1(() =>
    ensureAutoDomain("prj_x", { slug: "xeno", ip: IP, preferred, defaultPort: 80 }),
  );
  assert.equal(xName, preferred);
  // Y is given the SAME preferred — it must regenerate a distinct primary.
  const yName = await asUser1(() =>
    ensureAutoDomain("prj_y", { slug: "yeti", ip: IP, preferred, defaultPort: 80 }),
  );
  assert.notEqual(yName, preferred, "Y regenerated rather than colliding");
  assert.equal(nipEmbeddedIp(yName), IP);
});
