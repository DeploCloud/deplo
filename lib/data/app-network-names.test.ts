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
import { eq } from "drizzle-orm";

import { activities } from "../db/schema/control-plane/activity";
import { appMounts } from "../db/schema/control-plane/apps";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { envVars as envVarsTable } from "../db/schema/control-plane/env-vars";
import { decryptSecret } from "../crypto";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { createApp, composeNameClashes } from "./apps/create";
import { loadAppGraph } from "./app-graph-load";

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
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      {
        id: "member_1",
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "create_apps", "deploy_apps"],
      },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "member_1", teamId: TEAM_A }, fn);

test("an app named after the proxy keeps its name and takes another deploy key", async () => {
  // `deplo-traefik` is the proxy's own DNS name on every tenant network, so the slug is taken.
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
  // The check and the insert are two statements, so they run under one lock.
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

test("`privileged: yes` asks for the host grant, exactly like `true`", () => {
  const compose = "services:\n  a:\n    image: alpine\n    privileged: yes\n";
  return assert.rejects(
    () =>
      asMember(() =>
        createApp({
          name: "sneaky",
          source: "compose",
          repo: null,
          compose,
          deploy: false,
        }),
      ),
    /reach the server/,
  );
});

test("a mount filled in from a variable asks for the same grant", () => {
  const compose =
    'services:\n  a:\n    image: alpine\n    volumes:\n      - "${HOSTPATH}:/host"\n';
  return assert.rejects(
    () =>
      asMember(() =>
        createApp({
          name: "sneaky2",
          source: "compose",
          repo: null,
          compose,
          deploy: false,
        }),
      ),
    /reach the server/,
  );
});

test("a `hostname:` from a variable is refused at the save, not at the deploy", () => {
  const compose = "services:\n  a:\n    image: alpine\n    hostname: ${H}\n";
  return assert.rejects(
    () =>
      asUser1(() =>
        createApp({
          name: "sneaky3",
          source: "compose",
          repo: null,
          compose,
          deploy: false,
        }),
      ),
    /filled in from a variable/,
  );
});

const GENERATED_STACK = `services:
  db:
    image: postgres:17
  web:
    image: nginx:1.27
    depends_on:
      - db
    environment:
      DATABASE_URL: postgres://db:5432/app
`;

test("a generated stack is renamed around a taken name, and what named the service follows", async () => {
  await asUser1(() =>
    createApp({
      name: "first",
      source: "compose",
      repo: null,
      compose: GENERATED_STACK,
      deploy: false,
    }),
  );
  const second = await asUser1(() =>
    createApp({
      name: "second",
      source: "compose",
      repo: null,
      compose: GENERATED_STACK,
      renameClashes: true,
      composeService: "web",
      composePort: 80,
      extraDomains: [{ service: "db", port: 5432, host: "" }],
      env: [
        { key: "DB_HOST", value: "db" },
        { key: "URL", value: "postgres://db:5432/x" },
        { key: "POSTGRES_DB", value: "db" },
      ],
      mounts: [
        {
          filePath: "/etc/nginx/nginx.conf",
          content: "proxy_pass http://db/;",
        },
      ],
      deploy: false,
    }),
  );

  const graph = (await loadAppGraph(second.id))!;
  assert.match(graph.compose!, /^  db-2:/m);
  assert.match(graph.compose!, /^  web-2:/m);
  assert.doesNotMatch(graph.compose!, /^  (db|web):/m);
  assert.match(graph.compose!, /- db-2$/m, "depends_on follows");
  assert.match(
    graph.compose!,
    /DATABASE_URL: postgres:\/\/db-2:5432\/app/,
    "the inline environment follows",
  );
  assert.equal(graph.mounts?.[0]?.content, "proxy_pass http://db-2/;");

  const routes = await db
    .select({ service: domainsTable.service, primary: domainsTable.isPrimary })
    .from(domainsTable)
    .where(eq(domainsTable.appId, second.id));
  assert.equal(routes.find((r) => r.primary)?.service, "web-2");
  assert.equal(routes.find((r) => !r.primary)?.service, "db-2");

  const env = Object.fromEntries(
    (
      await db
        .select({ key: envVarsTable.key, valueEnc: envVarsTable.valueEnc })
        .from(envVarsTable)
        .where(eq(envVarsTable.appId, second.id))
    ).map((r) => [r.key, decryptSecret(r.valueEnc)]),
  );
  assert.equal(env.DB_HOST, "db-2");
  assert.equal(env.URL, "postgres://db-2:5432/x");
  assert.equal(env.POSTGRES_DB, "db", "a database NAME is not a hostname");

  const trail = await db
    .select({ message: activities.message })
    .from(activities)
    .where(eq(activities.appId, second.id));
  assert.ok(
    trail.some((r) => /already answered/.test(r.message)),
    JSON.stringify(trail),
  );
});

test("a generated stack nothing contests is left byte-identical", async () => {
  const app = await asUser1(() =>
    createApp({
      name: "alone",
      source: "compose",
      repo: null,
      compose: GENERATED_STACK,
      renameClashes: true,
      deploy: false,
    }),
  );
  assert.equal((await loadAppGraph(app.id))!.compose, GENERATED_STACK);
  const mounts = await db
    .select({ appId: appMounts.appId })
    .from(appMounts)
    .where(eq(appMounts.appId, app.id));
  assert.equal(mounts.length, 0);
});

test("composeNameClashes says what createApp would refuse, and the name it would use", async () => {
  assert.deepEqual(
    await asUser1(() => composeNameClashes({ compose: GENERATED_STACK })),
    [],
    "nothing there yet, nothing clashes",
  );
  await asUser1(() =>
    createApp({
      name: "first",
      source: "compose",
      repo: null,
      compose: GENERATED_STACK,
      deploy: false,
    }),
  );
  const clashes = await asUser1(() =>
    composeNameClashes({ compose: GENERATED_STACK }),
  );
  assert.deepEqual(clashes, [
    { name: "db", owner: "first", renamedTo: "db-2" },
    { name: "web", owner: "first", renamedTo: "web-2" },
  ]);
  const second = await asUser1(() =>
    createApp({
      name: "second",
      source: "compose",
      repo: null,
      compose: GENERATED_STACK,
      renameClashes: true,
      deploy: false,
    }),
  );
  assert.match((await loadAppGraph(second.id))!.compose!, /^  db-2:/m);
  assert.deepEqual(
    (await asUser1(() => composeNameClashes({ compose: GENERATED_STACK }))).map(
      (c) => c.renamedTo,
    ),
    ["db-3", "web-3"],
  );
  const third = await asUser1(() =>
    createApp({
      name: "third",
      source: "compose",
      repo: null,
      compose: GENERATED_STACK,
      renameClashes: true,
      deploy: false,
    }),
  );
  assert.match((await loadAppGraph(third.id))!.compose!, /^  db-3:/m);
});

test("a stack the user wrote is still refused, with the free name in the message", async () => {
  await asUser1(() =>
    createApp({
      name: "first",
      source: "compose",
      repo: null,
      compose: GENERATED_STACK,
      deploy: false,
    }),
  );
  await assert.rejects(
    () =>
      asUser1(() =>
        createApp({
          name: "second",
          source: "compose",
          repo: null,
          compose: GENERATED_STACK,
          deploy: false,
        }),
      ),
    /`db` is already answered by first[\s\S]*`db-2` is free/,
  );
});
