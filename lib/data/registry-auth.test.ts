// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  addRegistry,
  dockerConfigKey,
  loadRegistryAuthsForApp,
} from "./registries";

/**
 * The deploy edge's view of a registry credential: decrypted, keyed the way the
 * docker CLI matches an image, and never another team's.
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
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table registries, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

test("the deploy edge gets its own team's credentials, decrypted", async () => {
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    addRegistry({
      name: "GHCR",
      type: "ghcr",
      username: "octocat",
      password: "ghp_secret",
    }),
  );
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });

  assert.deepEqual(await loadRegistryAuthsForApp("prj_1"), [
    { host: "ghcr.io", username: "octocat", password: "ghp_secret" },
  ]);
});

test("another team's credential never reaches this app's deploy", async () => {
  await runWithIdentity({ userId: "user_2", teamId: TEAM_B }, () =>
    addRegistry({
      name: "B-reg",
      type: "ghcr",
      username: "beta",
      password: "beta-token",
    }),
  );
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });

  assert.deepEqual(await loadRegistryAuthsForApp("prj_1"), []);
});

test("an app that no longer exists sends nothing", async () => {
  assert.deepEqual(await loadRegistryAuthsForApp("prj_gone"), []);
});

test("the Hub is keyed the way the docker CLI looks it up", () => {
  // A `docker pull nginx` resolves its credential under this key, NOT "docker.io",
  // so storing the host verbatim would silently never authenticate.
  for (const host of ["docker.io", "index.docker.io", "registry-1.docker.io"]) {
    assert.equal(dockerConfigKey(host), "https://index.docker.io/v1/", host);
  }
  assert.equal(dockerConfigKey("ghcr.io"), "ghcr.io");
  assert.equal(
    dockerConfigKey(" https://harbor.acme.com/ "),
    "harbor.acme.com",
  );
  assert.equal(
    dockerConfigKey("registry.acme.com:5000"),
    "registry.acme.com:5000",
  );
});
