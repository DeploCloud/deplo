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
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { createApp } from "./apps";

/**
 * The names a stack answers to on its network are minted here: the slug becomes
 * `deplo-<slug>` on the host (ADR-0029), and the compose service names have to be
 * free on the network the app lands on.
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
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("an app named after the proxy keeps its name and takes another deploy key", async () => {
  // `deplo-traefik` is the proxy's own container and its DNS name on every tenant
  // network, so the slug is taken like any other: the deploy used to die with a
  // container-name conflict nobody outside Docker can read.
  const app = await asUser1(() =>
    createApp({
      name: "Traefik",
      source: "docker-image",
      dockerImage: "nginx:1.27",
      repo: null,
      deploy: false,
    }),
  );
  assert.equal(app.name, "Traefik");
  assert.notEqual(app.slug, "traefik");
  assert.match(app.slug, /^traefik-\d+$/);
});

test("two creates racing for one service name: exactly one takes it", async () => {
  // The check and the insert are two statements, and the names live inside a
  // compose file where no unique constraint can catch them - so they run under one
  // lock, or both reads see `db` free and both stacks claim it on the network.
  const compose = "services:\n  db:\n    image: postgres:16\n";
  const results = await Promise.allSettled([
    asUser1(() =>
      createApp({
        name: "one",
        source: "compose",
        repo: null,
        compose,
        deploy: false,
      }),
    ),
    asUser1(() =>
      createApp({
        name: "two",
        source: "compose",
        repo: null,
        compose,
        deploy: false,
      }),
    ),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "both creates took the same name on one network");
  assert.equal(failed.length, 1);
  assert.match(
    String((failed[0] as PromiseRejectedResult).reason),
    /already answered/,
  );
});
