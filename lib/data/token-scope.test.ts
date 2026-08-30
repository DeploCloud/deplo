// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { projects as projectsTable } from "../db/schema/control-plane";
import { runWithIdentity, type TokenGrant } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  USER_1,
} from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { ALL_CAPABILITIES, type Capability } from "../types";

import { listApps, getAppById, getAppBySlug, deleteApps } from "./apps";
import { listDeployments, redeploy } from "./deployments";
import { listDomains } from "./domains";
import { listEnv, listAllAppEnv } from "./env";
import { listActivity, recordActivity } from "./activity";
import { listFolders } from "./folders";
import { listProjects, projectContents } from "./projects";
import { listEnvironmentsForProject } from "./environments";
import { getBreadcrumbGraph } from "./breadcrumb";
import { membershipFor, requireInstanceAdmin } from "../membership";

/**
 * What an API token limited to Projects can actually reach. Fixture: TEAM_A holds
 * `prc_in` and `prc_out`; `prj_in` lives in the first, `prj_out` in the second,
 * and `prj_top` sits at the team top level with no project at all.
 */

let db: TestDb;
let pg: PGlite;

const T0 = "2026-01-01T00:00:00.000Z";
const PRC_IN = "prc_in";
const PRC_OUT = "prc_out";

/** Scoped to the whole of `prc_in`, holding every capability. */
const grant = (over: Partial<TokenGrant> = {}): TokenGrant => ({
  id: "tok_test",
  capabilities: [...ALL_CAPABILITIES],
  scope: {
    teamIds: [TEAM_A],
    wholeTeamIds: [],
    projectIds: [PRC_IN],
    folderIds: [],
    appIds: [],
    appProjectIds: [],
  },
  instanceAdmin: false,
  ...over,
});

/** As the scoped token. */
const scoped = <T>(
  fn: () => Promise<T>,
  over?: Partial<TokenGrant>,
): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A, token: grant(over) }, fn);

/** As the same user over a cookie session - the control for every assertion. */
const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec(
    `truncate table projects, activities restart identity cascade;`,
  );
  await seedIdentity(db);
  await seedServer(db);
  await db.insert(projectsTable).values([
    {
      id: PRC_IN,
      teamId: TEAM_A,
      name: "In",
      slug: "in",
      createdAt: T0,
      updatedAt: T0,
    },
    {
      id: PRC_OUT,
      teamId: TEAM_A,
      name: "Out",
      slug: "out",
      createdAt: T0,
      updatedAt: T0,
    },
  ]);
  await seedApp(db, { id: "prj_in", slug: "in-app", projectId: PRC_IN });
  await seedApp(db, { id: "prj_out", slug: "out-app", projectId: PRC_OUT });
  await seedApp(db, { id: "prj_top", slug: "top-app" });
});

test("listApps shows only the scoped project's apps - a top-level app is outside every scope", async () => {
  const ids = await scoped(async () => (await listApps()).map((a) => a.id));
  assert.deepEqual(ids, ["prj_in"]);

  // The control: the same user over a cookie session still sees all three.
  const all = await asUser(async () => (await listApps()).map((a) => a.id));
  assert.deepEqual(all.sort(), ["prj_in", "prj_out", "prj_top"]);
});

test("an out-of-scope app is NOT FOUND by id or by slug, exactly like one that never existed", async () => {
  await scoped(async () => {
    assert.ok(await getAppById("prj_in"));
    assert.equal(await getAppById("prj_out"), null);
    assert.equal(await getAppById("prj_top"), null);
    assert.equal(await getAppById("prj_nope"), null);
    assert.ok(await getAppBySlug("in-app"));
    assert.equal(await getAppBySlug("out-app"), null);
  });
});

test("a mutation on an out-of-scope app fails with the SAME message as an unknown id", async () => {
  const [outOfScope, unknown] = await scoped(async () => [
    await redeploy("prj_out").then(
      () => "no error",
      (e: Error) => e.message,
    ),
    await redeploy("prj_nope").then(
      () => "no error",
      (e: Error) => e.message,
    ),
  ]);
  assert.equal(
    outOfScope,
    unknown,
    "the scope must not be an existence oracle",
  );
  assert.match(outOfScope, /not found/i);
});

test("the app-scoped reads all come back empty for an out-of-scope app", async () => {
  await scoped(async () => {
    assert.deepEqual(await listEnv("prj_out"), []);
    assert.deepEqual(await listEnv("prj_top"), []);
    assert.ok(Array.isArray(await listEnv("prj_in")));
  });
});

test("team-wide lists never mention an out-of-scope app", async () => {
  await scoped(async () => {
    const deployments = await listDeployments();
    assert.equal(
      deployments.some((d) => d.appId === "prj_out" || d.appId === "prj_top"),
      false,
    );
    const domains = await listDomains();
    assert.equal(
      domains.some((d) => d.appId === "prj_out" || d.appId === "prj_top"),
      false,
    );
    const env = await listAllAppEnv();
    assert.deepEqual(
      env.map((g) => g.app.id),
      ["prj_in"],
    );
    const crumbs = await getBreadcrumbGraph();
    assert.deepEqual(
      crumbs.apps.map((a) => a.id),
      ["prj_in"],
    );
  });
});

test("the activity feed drops other projects' apps AND the team-level rows", async () => {
  await recordActivity("app", "in", "someone", "prj_in");
  await recordActivity("app", "out", "someone", "prj_out");
  await recordActivity("member", "team level", "someone", null, TEAM_A);

  const messages = await scoped(async () =>
    (await listActivity()).map((a) => a.message),
  );
  assert.deepEqual(messages, ["in"]);

  const all = await asUser(async () =>
    (await listActivity()).map((a) => a.message),
  );
  assert.equal(all.length, 3);
});

test("projects, environments and folders follow the same scope", async () => {
  await scoped(async () => {
    assert.deepEqual(
      (await listProjects()).map((p) => p.id),
      [PRC_IN],
    );
    assert.deepEqual(await projectContents(PRC_OUT), { folders: [], apps: [] });
    assert.deepEqual(
      (await projectContents(PRC_IN)).apps.map((a) => a.id),
      ["prj_in"],
    );
    assert.deepEqual(await listEnvironmentsForProject(PRC_OUT), []);
    // This fixture files nothing in a folder, so the project scope reaches none.
    assert.deepEqual(await listFolders(), []);
  });
});

test("a bulk delete silently drops the ids the scope excludes", async () => {
  const n = await scoped(() => deleteApps(["prj_in", "prj_out", "prj_top"]));
  assert.equal(n, 1);
  const left = await asUser(async () => (await listApps()).map((a) => a.id));
  assert.deepEqual(left.sort(), ["prj_out", "prj_top"]);
});

test("a scope with no projects left reaches nothing at all", async () => {
  const ids = await scoped(async () => (await listApps()).map((a) => a.id), {
    scope: {
      teamIds: [TEAM_A],
      wholeTeamIds: [],
      projectIds: [],
      folderIds: [],
      appIds: [],
      appProjectIds: [],
    },
  });
  assert.deepEqual(ids, []);
});

test("an unscoped token, and a cookie session, are both untouched", async () => {
  const viaToken = await scoped(
    async () => (await listApps()).map((a) => a.id),
    { scope: null },
  );
  assert.deepEqual(viaToken.sort(), ["prj_in", "prj_out", "prj_top"]);

  // And a token holding the WHOLE team is not narrowed either - breadth is not
  // depth, so it sees everything and keeps every capability.
  const wholeTeam = await scoped(
    async () => (await listApps()).map((a) => a.id),
    {
      scope: {
        teamIds: [TEAM_A],
        wholeTeamIds: [TEAM_A],
        projectIds: [],
        folderIds: [],
        appIds: [],
        appProjectIds: [],
      },
    },
  );
  assert.deepEqual(wholeTeam.sort(), ["prj_in", "prj_out", "prj_top"]);
});

test("the capability clamp keys on the (user, team) pair, and drops team-wide caps when scoped", async () => {
  await scoped(async () => {
    const m = await membershipFor(USER_1, TEAM_A);
    // Every team-wide capability is gone even though the token was given all 40.
    assert.equal(m!.capabilities.includes("manage_members"), false);
    assert.equal(m!.capabilities.includes("manage_tokens"), false);
    assert.equal(m!.capabilities.includes("create_databases"), false);
    // What survives is the app-shaped half.
    assert.equal(m!.capabilities.includes("deploy_apps"), true);
  });

  // A token that names a NARROW set never gains what the member holds.
  await scoped(
    async () => {
      const m = await membershipFor(USER_1, TEAM_A);
      assert.deepEqual(m!.capabilities, ["view", "view_logs"]);
    },
    { scope: null, capabilities: ["view", "view_logs"] as Capability[] },
  );

  // Outside any identity override the member keeps their real set.
  const full = await asUser(async () => (await membershipFor(USER_1, TEAM_A))!);
  assert.equal(full.capabilities.includes("manage_members"), true);
});

test("instance administration is opt-in per token, even for an admin's token", async () => {
  await scoped(
    async () => {
      await assert.rejects(
        () => requireInstanceAdmin(),
        /Only an instance admin/,
      );
    },
    { scope: null },
  );
  await scoped(
    async () => {
      assert.deepEqual(await requireInstanceAdmin(), { userId: USER_1 });
    },
    { scope: null, instanceAdmin: true },
  );
  // The cookie session of the same (admin) user is unaffected.
  await asUser(async () => {
    assert.deepEqual(await requireInstanceAdmin(), { userId: USER_1 });
  });
});
