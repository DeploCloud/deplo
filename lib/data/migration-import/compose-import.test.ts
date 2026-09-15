import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import yaml from "js-yaml";
import {
  appMounts as appMountsTable,
  appVolumes as appVolumesTable,
  apps as appsTable,
} from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { TEAM_A } from "../identity-test-helpers";
import { seedApp } from "../app-graph-test-helpers";
import { importMigrationProject } from "./project-import";
import { beginMigration } from "./run-lifecycle";
import { createEnvironment } from "../environments";
import { createProject } from "../projects/lifecycle";
import {
  URL_BASE,
  CONNECT,
  source,
  asOwner,
  asMember,
  importProject,
  provisionServer1,
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

function setComposeFile(...lines: string[]): void {
  (source.fixtures["compose.one"] as { composeFile: string }).composeFile =
    lines.join("\n");
}

test("a compose stack's config file shows up in Storage", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-other");
  const apps = await db.select().from(appsTable);
  const stack = apps.find((a) => a.name === "other-stack")!;

  const stored = await db
    .select()
    .from(appMountsTable)
    .where(eq(appMountsTable.appId, stack.id));
  assert.deepEqual(
    stored.map((m) => [m.filePath, m.content]),
    [["nginx.conf", "server { listen 80; }\n"]],
  );

  const vols = await db
    .select()
    .from(appVolumesTable)
    .where(eq(appVolumesTable.appId, stack.id));
  assert.equal(vols.length, 1);
  assert.equal(vols[0]!.type, "app");
  assert.equal(vols[0]!.projectPath, "nginx.conf");
  assert.equal(vols[0]!.mountPath, "/etc/nginx/nginx.conf");
  assert.equal(vols[0]!.service, "web");
  assert.equal(vols[0]!.readOnly, true);
});

test("a Member migrates a stack whose only host-ish key is env_file", async () => {
  setComposeFile(
    "services:",
    "  web:",
    "    image: nginx:1.27",
    "    env_file:",
    "      - .env",
    "    volumes:",
    "      - webdata:/data",
    "volumes:",
    "  webdata:",
  );

  const runId = await asMember(() => beginMigration({ url: URL_BASE }));
  await asMember(() =>
    importMigrationProject({ ...CONNECT, runId, projectId: "dok-prj-other" }),
  );

  const apps = await db.select().from(appsTable);
  const stack = apps.find((a) => a.name === "other-stack");
  assert.ok(stack, apps.map((a) => a.name).join(", "));
  assert.match(stack.compose ?? "", /env_file/);
});

test("a stack a Member may not create says what tripped it, and how", async () => {
  setComposeFile(
    "services:",
    "  ui:",
    "    image: louislam/uptime-kuma:1",
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock:ro",
  );

  const runId = await asMember(() => beginMigration({ url: URL_BASE }));
  await asMember(() =>
    importMigrationProject({ ...CONNECT, runId, projectId: "dok-prj-other" }),
  );

  const rows = await db
    .select()
    .from(itemsTable)
    .where(eq(itemsTable.runId, runId));
  const line = rows.find((r) => r.sourceName === "other-stack");
  assert.ok(line, rows.map((r) => r.sourceName).join(", "));
  assert.equal(line.outcome, "manual");
  assert.match(String(line.message), /bind mount of a folder on the server/);
  assert.match(String(line.message), /Bind server folders/);
});

test("the compose file arrives with Dokploy's network taken out", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-other");

  const apps = await db.select().from(appsTable);
  const stack = apps.find((a) => a.name === "other-stack")!;
  assert.equal(stack.source, "compose");
  const doc = yaml.load(stack.compose!) as {
    services: Record<string, { networks?: unknown; image?: string }>;
    networks?: unknown;
  };
  assert.equal(doc.networks, undefined);
  assert.equal("networks" in doc.services.web, false);
  assert.match(doc.services.web.image ?? "", /nginx/);

  const doms = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, stack.id));
  const primary = doms.find((d) => d.isPrimary)!;
  assert.equal(primary.name, "stack.acme.test");
  assert.equal(primary.certProvider, "letsencrypt");
  assert.equal(primary.service, "web");
  assert.equal(primary.port, 80);
});

test("a stack whose service name is already answered is renamed, not refused", async () => {
  await provisionServer1(db);
  const project = await asOwner(() => createProject("Other"));
  const staging = await asOwner(() => createEnvironment(project.id, "staging"));
  await seedApp(db, {
    id: "prj_neighbour",
    teamId: TEAM_A,
    slug: "neighbour",
    projectId: project.id,
    environmentId: staging.id,
    source: "compose",
    compose: "services:\n  web:\n    image: nginx\n",
  });

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  const result = await importProject(runId, "dok-prj-other");
  assert.equal(
    result.items.some((i) => i.outcome === "failed"),
    false,
    JSON.stringify(result.items.filter((i) => i.outcome === "failed")),
  );

  const stack = (await db.select().from(appsTable)).find(
    (a) => a.name === "other-stack",
  );
  assert.ok(stack, "the stack has to exist at all");
  const doc = yaml.load(stack.compose ?? "") as {
    services: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(doc.services), ["other-stack-web"]);
  const domains = await db.execute(
    `select service from domains where app_id = '${stack.id}'`,
  );
  assert.equal(domains.rows[0]?.service, "other-stack-web");
});
