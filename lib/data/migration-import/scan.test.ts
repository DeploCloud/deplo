import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { TEAM_A, TEAM_B } from "../identity-test-helpers";
import { seedApp } from "../app-graph-test-helpers";
import { __setMigrationFetchForTest } from "../../migration/transport";
import { beginMigration } from "./run-lifecycle";
import { listMigrationRuns } from "./run-queries";
import { identifyMigrationSource, scanMigrationSource } from "./scan";
import {
  URL_BASE,
  CONNECT,
  source,
  APPLICATIONS,
  routingFetch,
  asOwner,
  asViewerAdmin,
  importProject,
  openMigrationHarness,
  closeMigrationHarness,
  resetMigrationHarness,
} from "./migration-import-test-helpers";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  await openMigrationHarness(db);
});

after(() => closeMigrationHarness(db, pg));

beforeEach(() => resetMigrationHarness(db));

// A key reads ONE organization, so a panel with three needs three keys - and a full scan per
// key is hundreds of calls against a fresh Dokploy key rate-limited to ten a day.
test("a key says which team it reads, and which it does not", async () => {
  const who = await asOwner(() => identifyMigrationSource(CONNECT));

  assert.equal(who.platform, "dokploy");
  assert.equal(who.teamId, "org_acme");
  assert.equal(who.teamName, "Acme Inc");
  assert.deepEqual(who.otherTeams, ["Side Projects"]);
  assert.deepEqual(await asOwner(() => listMigrationRuns()), []);
});

test("scan names the teams no key covers yet", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  assert.deepEqual(plan.otherTeams, ["Side Projects"]);
});

test("scan describes the whole tree without writing anything", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));

  assert.equal(plan.orgName, "Acme Inc");
  assert.deepEqual(
    plan.projects.map((p) => p.name),
    ["Blink", "Other"],
  );
  assert.deepEqual(
    plan.servers.map((s) => s.name),
    ["The Dokploy host", "eu-1"],
  );
  assert.deepEqual(plan.servers[0].sourceId, "");
  assert.deepEqual(
    plan.servers.map((s) => s.deploServerId),
    [null, null],
  );
  assert.deepEqual(
    plan.members.map((m) => m.email),
    ["owner@acme.test", "dev@acme.test"],
  );

  const blink = plan.projects[0];
  assert.equal(blink.exists, false);
  assert.deepEqual(
    blink.environments[0].services.map(
      (s) => `${s.kind}:${s.name}:${s.status}`,
    ),
    [
      "application:blink-web:new",
      "application:blink-api:new",
      "postgres:blink-db:new",
    ],
  );

  assert.equal((await db.select().from(appsTable)).length, 0);
  assert.equal((await db.select().from(databasesTable)).length, 0);
});

test("a database the tree gives only an id for is still named, not a crash", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const db = plan.projects[0].environments[0].services.find(
    (s) => s.kind === "postgres",
  )!;
  // `project.all` returns `{postgresId}` and nothing else for a database - the "Cannot read
  // properties of undefined (reading 'trim')" crash: the name has to come from the detail row.
  assert.equal(db.name, "blink-db");
  assert.equal(db.targetKind, "database");
});

test("scan marks a libsql database unsupported and never asks for its detail", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const other = plan.projects[1].environments[0].services;
  const libsql = other.find((s) => s.kind === "libsql")!;
  assert.equal(libsql.status, "unsupported");
  assert.equal(libsql.targetKind, null);
  assert.equal(source.calls.includes("libsql.one"), false);
});

test("scan reports the compose rewrite and the missing git credential up front", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const stack = plan.projects[1].environments[0].services[0];
  assert.match(stack.notes.join(" "), /shared network was removed/);

  const web = plan.projects[0].environments[0].services[0];
  assert.match(web.notes.join(" "), /no credential/);
  assert.equal(web.notes.join(" ").includes("8080"), false);
  assert.deepEqual(web.domains, [
    "blink-web-abc.traefik.me",
    "blink.acme.test",
  ]);
  assert.match(web.notes.join(" "), /Dokploy's own temporary address/);
});

test("scan warns when a hostname already belongs to another team", async () => {
  await seedApp(db, { id: "prj_other_team", teamId: TEAM_B, slug: "victim" });
  await db.insert(domainsTable).values({
    id: "dom_victim",
    appId: "prj_other_team",
    name: "blink.acme.test",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    entrypoint: "websecure",
    certProvider: "letsencrypt",
    stripPrefix: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const web = plan.projects[0].environments[0].services[0];
  assert.match(web.notes.join(" "), /already routed by another team/);
});

test("scan surfaces the panel's own words when the key is wrong", async () => {
  source.fixtures["project.all"] = { __status: 401, body: "Invalid API key" };
  await assert.rejects(
    () => asOwner(() => scanMigrationSource(CONNECT)),
    (e: Error) => {
      assert.match(
        e.message,
        /Dokploy request failed \(401\) on project.all: Invalid API key/,
      );
      assert.match(e.message, /could not read/);
      return true;
    },
  );
});

test("a named platform is taken, not re-detected", async () => {
  source.fixtures["project.all"] = { __status: 401, body: "Invalid API key" };
  await assert.rejects(
    () => asOwner(() => scanMigrationSource({ ...CONNECT, kind: "dokploy" })),
    /(Dokploy request failed \(401\)|stopped accepting this API key) on project.all/,
  );
  assert.equal(source.calls.filter((c) => c === "project.all").length, 1);
});

test("a service on the second machine says so in the plan", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const services = plan.projects[0].environments[0].services;
  const byName = new Map(services.map((s) => [s.name, s]));
  assert.equal(byName.get("blink-api")!.sourceServerId, "dok-srv-1");
  assert.equal(byName.get("blink-web")!.sourceServerId, "");
});

test("a scan reports which product answered", async () => {
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  assert.equal(plan.platform, "dokploy");
});

test("the plan for a team not made yet counts nothing as already here", async () => {
  await seedApp(db, { id: "prj_here", teamId: TEAM_A, slug: "blink-web" });
  await db.insert(domainsTable).values({
    id: "dom_here",
    appId: "prj_here",
    name: "blink.acme.test",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    entrypoint: "websecure",
    certProvider: "letsencrypt",
    stripPrefix: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const into = await asOwner(() => scanMigrationSource(CONNECT));
  const wasHere = into.projects.find((p) => p.sourceId === "dok-prj-blink")!;
  assert.equal(wasHere.exists, true);
  assert.doesNotMatch(
    wasHere.environments[0].services[0].notes.join(" "),
    /already routed by another team/,
  );

  const fresh = await asViewerAdmin(() =>
    scanMigrationSource(CONNECT, { newTeam: true }),
  );
  const blink = fresh.projects.find((p) => p.sourceId === "dok-prj-blink")!;
  assert.equal(blink.exists, false);
  for (const env of blink.environments) {
    assert.equal(env.exists, false);
    for (const svc of env.services) assert.notEqual(svc.status, "exists");
  }
  assert.match(
    blink.environments[0].services[0].notes.join(" "),
    /already routed by another team/,
  );
});

test("a machine nothing importable lives on is not a machine to install on", async () => {
  const api = { ...(APPLICATIONS["dok-app-api"] as object), serverId: null };
  __setMigrationFetchForTest(
    routingFetch({ applications: { "dok-app-api": api } }),
  );
  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  assert.deepEqual(
    plan.servers.map((s) => s.name),
    ["The Dokploy host"],
    "eu-1 holds nothing of this team",
  );
});
