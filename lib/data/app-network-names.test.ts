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

import {
  activities,
  appMounts,
  domains as domainsTable,
  envVars as envVarsTable,
} from "../db/schema/control-plane";
import { decryptSecret } from "../crypto";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { createApp } from "./apps";
import { loadAppGraph } from "./app-graph-load";

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

/** A plain member: no instance admin, and no grant to reach the server. */
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "member_1", teamId: TEAM_A }, fn);

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

test("`privileged: yes` asks for the host grant, exactly like `true`", () => {
  // End to end, through the real create: the gate reads what compose reads, so the
  // member with no host grant is refused instead of landing a privileged container
  // on a shared machine.
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
  // Installing the same template twice in one Environment is the ordinary case,
  // and refusing the second install lost the whole app. A compose Deplo generated
  // is rewritten instead, the way the import already does it - and the primary
  // route, the extra domain, the env and the config file move with the service.
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
  assert.match(graph.compose!, /^  second-db:/m);
  assert.match(graph.compose!, /^  second-web:/m);
  assert.doesNotMatch(graph.compose!, /^  (db|web):/m);
  assert.match(graph.compose!, /- second-db$/m, "depends_on follows");
  assert.match(
    graph.compose!,
    /DATABASE_URL: postgres:\/\/second-db:5432\/app/,
    "the inline environment follows",
  );
  assert.equal(graph.mounts?.[0]?.content, "proxy_pass http://second-db/;");

  const routes = await db
    .select({ service: domainsTable.service, primary: domainsTable.isPrimary })
    .from(domainsTable)
    .where(eq(domainsTable.appId, second.id));
  assert.equal(routes.find((r) => r.primary)?.service, "second-web");
  assert.equal(routes.find((r) => !r.primary)?.service, "second-db");

  const env = Object.fromEntries(
    (
      await db
        .select({ key: envVarsTable.key, valueEnc: envVarsTable.valueEnc })
        .from(envVarsTable)
        .where(eq(envVarsTable.appId, second.id))
    ).map((r) => [r.key, decryptSecret(r.valueEnc)]),
  );
  assert.equal(env.DB_HOST, "second-db");
  assert.equal(env.URL, "postgres://second-db:5432/x");
  assert.equal(env.POSTGRES_DB, "db", "a database NAME is not a hostname");

  // The trail says it happened, or the compose reads as if the user wrote it so.
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
