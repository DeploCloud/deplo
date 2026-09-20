import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import {
  envVars as envVarsTable,
  sharedEnvVarApps as sharedLinksTable,
} from "../db/schema/control-plane/env-vars";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { seedDatabase } from "./backup-test-helpers";
import { createApp } from "./apps/create";
import { saveSharedVar } from "./shared-vars/authoring";
import { loadAppGraph } from "./app-graph-load";

let db: TestDb;
let pg: PGlite;

const COMPOSE =
  'services:\n  web:\n    image: nginx:1.27\n    expose:\n      - "80"\n';

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
      { id: "user_2", teamId: TEAM_B, role: "owner" },
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

const newApp = (
  extra: Parameters<typeof createApp>[0] extends infer T ? Partial<T> : never,
) =>
  createApp({
    name: "shop",
    source: "compose",
    repo: null,
    compose: COMPOSE,
    deploy: false,
    ...extra,
  });

test("extra compose flags are stored the way the deploy edge will send them", async () => {
  const app = await asUser1(() =>
    newApp({ composeUpArgs: "  --pull   always \n --wait " }),
  );
  assert.equal(
    (await loadAppGraph(app.id))?.composeUpArgs,
    "--pull always --wait",
  );
});

test("an app is created with no extra flags by default", async () => {
  const app = await asUser1(() => newApp({}));
  assert.equal((await loadAppGraph(app.id))?.composeUpArgs, null);
});

test("a flag that would repoint the command is refused at creation", async () => {
  await assert.rejects(
    () => asUser1(() => newApp({ composeUpArgs: "-p other" })),
    /Deplo's to set/,
  );
});

test("an initial variable is created secret when the create says so", async () => {
  const app = await asUser1(() =>
    newApp({
      env: [
        { key: "API_URL", value: "https://acme.com", type: "plain" },
        { key: "LICENSE_CODE", value: "abc", type: "secret" },
      ],
    }),
  );
  const rows = await db
    .select({ key: envVarsTable.key, type: envVarsTable.type })
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, app.id));
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.type]));
  assert.equal(byKey.API_URL, "plain");
  assert.equal(byKey.LICENSE_CODE, "secret");
});

test("shared variables are linked as part of the create", async () => {
  const varId = await asUser1(() =>
    saveSharedVar({
      key: "SENTRY_DSN",
      value: "https://sentry.example",
      type: "plain",
      teamIds: [TEAM_A],
      environmentIds: [],
      projectIds: [],
    }),
  );
  const app = await asUser1(() => newApp({ sharedVarIds: [varId] }));
  const links = await db
    .select({ varId: sharedLinksTable.varId })
    .from(sharedLinksTable)
    .where(
      and(
        eq(sharedLinksTable.appId, app.id),
        eq(sharedLinksTable.varId, varId),
      ),
    );
  assert.equal(links.length, 1);
});

test("another team's shared variable is not linkable at creation", async () => {
  const foreign = await runWithIdentity(
    { userId: "user_2", teamId: TEAM_B },
    () =>
      saveSharedVar({
        key: "FOREIGN",
        value: "x",
        type: "plain",
        teamIds: [TEAM_B],
        environmentIds: [],
        projectIds: [],
      }),
  );
  await assert.rejects(
    () => asUser1(() => newApp({ sharedVarIds: [foreign] })),
    /not found/i,
  );
});

test("an extra domain shares the primary's host when it answers on a path", async () => {
  const app = await asUser1(() =>
    newApp({
      compose:
        "services:\n" +
        "  db:\n    image: postgres:17\n" +
        "  backend:\n    image: acme/api\n" +
        '  client:\n    image: acme/web\n    expose:\n      - "80"\n' +
        "    depends_on:\n      - backend\n",
      extraDomains: [
        { service: "backend", port: 3001, host: "", path: "/api" },
      ],
    }),
  );
  const rows = await db
    .select({
      name: domainsTable.name,
      service: domainsTable.service,
      port: domainsTable.port,
      pathPrefix: domainsTable.pathPrefix,
      primary: domainsTable.isPrimary,
    })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));

  const primary = rows.find((r) => r.primary);
  const extra = rows.find((r) => !r.primary);
  assert.equal(primary?.service, "client");
  assert.equal(extra?.service, "backend");
  assert.equal(extra?.pathPrefix, "/api");
  assert.equal(extra?.port, 3001);
  assert.equal(extra?.name, primary?.name);
});

test("an extra domain with no host of its own gets one generated", async () => {
  const app = await asUser1(() =>
    newApp({
      compose:
        'services:\n  web:\n    image: nginx\n    expose:\n      - "80"\n' +
        "  admin:\n    image: acme/admin\n",
      extraDomains: [{ service: "admin", port: 3003, host: "" }],
    }),
  );
  const rows = await db
    .select({ name: domainsTable.name, primary: domainsTable.isPrimary })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  const extra = rows.find((r) => !r.primary);
  assert.ok(extra, "the host-less extra was dropped");
  assert.match(extra.name, /^shop-admin-/);
});

test("an extra naming a container the stack does not have is skipped", async () => {
  const app = await asUser1(() =>
    newApp({
      compose:
        'services:\n  web:\n    image: nginx\n    expose:\n      - "80"\n',
      extraDomains: [{ service: "web-ui", port: 3000, host: "" }],
    }),
  );
  const rows = await db
    .select({ name: domainsTable.name })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  assert.equal(rows.length, 1, "only the primary should exist");
});

test("an extra naming a container Deplo answers to is skipped", async () => {
  const app = await asUser1(() =>
    newApp({
      compose:
        'services:\n  web:\n    image: nginx\n    expose:\n      - "80"\n' +
        "  postgres:\n    image: postgres:17\n",
      extraDomains: [{ service: "postgres", port: 5432, host: "" }],
    }),
  );
  const rows = await db
    .select({ name: domainsTable.name })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  assert.equal(rows.length, 1, "only the primary should exist");
});

test("an extra cannot take a hostname another team already serves", async () => {
  await runWithIdentity({ userId: "user_2", teamId: TEAM_B }, () =>
    createApp({
      name: "theirs",
      source: "compose",
      repo: null,
      compose: COMPOSE,
      deploy: false,
      autoDomain: "shared.example.com",
    }),
  );
  const app = await asUser1(() =>
    newApp({
      extraDomains: [
        { service: "web", port: 3001, host: "shared.example.com" },
      ],
    }),
  );
  const rows = await db
    .select({ name: domainsTable.name, primary: domainsTable.isPrimary })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  const extra = rows.find((r) => !r.primary);
  assert.ok(extra, "the extra was dropped");
  assert.notEqual(extra.name, "shared.example.com");
});

test("a member who may not manage domains still gets the generated hosts", async () => {
  const app = await runWithIdentity(
    { userId: "member_1", teamId: TEAM_A },
    () =>
      createApp({
        name: "member app",
        source: "compose",
        repo: null,
        compose: COMPOSE,
        deploy: false,
        extraDomains: [{ service: "web", port: 3001, host: "" }],
      }),
  );
  const rows = await db
    .select({ name: domainsTable.name })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  assert.equal(rows.length, 2);
});

test("but a REAL hostname on an extra is still a claim", async () => {
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "member_1", teamId: TEAM_A }, () =>
        createApp({
          name: "member app 2",
          source: "compose",
          repo: null,
          compose: COMPOSE,
          deploy: false,
          extraDomains: [{ service: "web", port: 3001, host: "api.acme.com" }],
        }),
      ),
    /permission to manage domains/,
  );
});

const ANALYTICS_STACK = `services:
  store_clickhouse:
    image: clickhouse/clickhouse-server:25.5
  store_postgres:
    image: postgres:17.5
  store_redis:
    image: redis:7-alpine
  store_backend:
    image: acme/backend:v2
    depends_on:
      store_clickhouse:
        condition: service_healthy
      store_postgres:
        condition: service_started
  store_client:
    image: acme/client:v2
    ports:
      - "3002:3000"
    depends_on:
      - store_backend
`;

test("a five-service stack routes its frontend, and the API only if asked", async () => {
  const app = await asUser1(() =>
    newApp({
      compose: ANALYTICS_STACK,
      composeService: "store_client",
      composePort: 80,
      extraDomains: [{ service: "store_backend", port: 80, host: "" }],
    }),
  );
  const rows = await db
    .select({
      name: domainsTable.name,
      service: domainsTable.service,
      primary: domainsTable.isPrimary,
    })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));

  const primary = rows.find((r) => r.primary);
  const extra = rows.find((r) => !r.primary);
  assert.equal(primary?.service, "store_client");
  assert.equal(extra?.service, "store_backend");
  assert.notEqual(extra?.name, primary?.name, "each gets its own address");
  assert.equal(rows.length, 2, "the three datastores get no address");
});

test("a service that would take over a database's address is refused", async () => {
  await seedDatabase(db, { id: "db_1", name: "analytics", teamId: TEAM_A });

  for (const [label, svc] of [
    ["the bare name", "db-analytics"],
    ["a case variant, since DNS is case-insensitive", "DB-Analytics"],
  ] as const)
    await assert.rejects(
      () =>
        asUser1(() =>
          newApp({ compose: `services:\n  ${svc}:\n    image: nginx:1.27\n` }),
        ),
      /is already answered by/,
      label,
    );

  await assert.rejects(
    () =>
      asUser1(() =>
        newApp({
          compose:
            "services:\n  web:\n    image: nginx:1.27\n    hostname: db-analytics\n",
        }),
      ),
    /is already answered by/,
    "via hostname",
  );

  const ok = await asUser1(() =>
    newApp({ compose: "services:\n  db-orders:\n    image: nginx:1.27\n" }),
  );
  assert.ok(ok.id);
});

test("another team's database is not a clash - it is on another network", async () => {
  await seedDatabase(db, { id: "db_2", name: "billing", teamId: TEAM_B });
  const ok = await asUser1(() =>
    newApp({ compose: "services:\n  db-billing:\n    image: nginx:1.27\n" }),
  );
  assert.ok(ok.id);
});

test("the service the source named keeps the address even with no port", async () => {
  const app = await asUser1(() =>
    newApp({
      compose: ANALYTICS_STACK,
      composeService: "store_backend",
      composePort: null,
    }),
  );
  const [row] = await db
    .select({ service: domainsTable.service, port: domainsTable.port })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  assert.equal(row.service, "store_backend");
  assert.equal(row.port, 80);
});

test("a service the stack does not have is not taken over a real one", async () => {
  const app = await asUser1(() =>
    newApp({ compose: ANALYTICS_STACK, composeService: "ghost" }),
  );
  const [row] = await db
    .select({ service: domainsTable.service })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  assert.equal(row.service, "store_client");
});

test("a stack with no web service is born without an address", async () => {
  const app = await asUser1(() =>
    newApp({
      compose:
        "services:\n  worker:\n    image: acme/worker\n  db:\n    image: postgres:17\n",
    }),
  );
  const rows = await db
    .select({ name: domainsTable.name })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  assert.equal(rows.length, 0, "nothing serves HTTP, so nothing is addressed");
});

test("a stack that publishes a port is addressed on that service", async () => {
  const app = await asUser1(() =>
    newApp({
      compose:
        "services:\n  db:\n    image: postgres:17\n" +
        '  web:\n    image: acme/web\n    expose:\n      - "8000"\n',
    }),
  );
  const rows = await db
    .select({ service: domainsTable.service, port: domainsTable.port })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  assert.deepEqual(rows, [{ service: "web", port: 8000 }]);
});

test("a stack with no web service still takes the address it asked for", async () => {
  const app = await asUser1(() =>
    newApp({
      compose: "services:\n  worker:\n    image: acme/worker\n",
      autoDomain: "worker-ui.acme.com",
    }),
  );
  const rows = await db
    .select({ name: domainsTable.name })
    .from(domainsTable)
    .where(eq(domainsTable.appId, app.id));
  assert.deepEqual(rows, [{ name: "worker-ui.acme.com" }]);
});

test("a database image gets no address, a web image does", async () => {
  const cache = await asUser1(() =>
    newApp({
      name: "cache",
      source: "docker-image",
      dockerImage: "redis:7",
      compose: null,
      build: { port: 6379 },
    }),
  );
  const site = await asUser1(() =>
    newApp({
      name: "site",
      source: "docker-image",
      dockerImage: "nginx:1.27",
      compose: null,
      build: { port: 80 },
    }),
  );
  const rowsFor = async (id: string) =>
    db
      .select({ name: domainsTable.name })
      .from(domainsTable)
      .where(eq(domainsTable.appId, id));
  assert.equal((await rowsFor(cache.id)).length, 0);
  assert.equal((await rowsFor(site.id)).length, 1);
});
