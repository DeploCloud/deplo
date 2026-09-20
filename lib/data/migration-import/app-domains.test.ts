import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { eq } from "drizzle-orm";
import { decryptSecret } from "../../crypto";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { envVars as envVarsTable } from "../../db/schema/control-plane/env-vars";
import { TEAM_B } from "../identity-test-helpers";
import { seedApp, SERVER_1 } from "../app-graph-test-helpers";
import { dismissImportedDomains } from "../domains/imported-routes";
import { beginMigration, finishMigration } from "./run-lifecycle";
import { getMigrationRun } from "./run-queries";
import { scanMigrationSource } from "./scan";
import {
  URL_BASE,
  CONNECT,
  asOwner,
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

test("a variable that names the old address is moved to the new one", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const apps = await db.select().from(appsTable);
  const web = apps.find((a) => a.name === "blink-web")!;
  const doms = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));
  const rehosted = doms.find((d) => d.importedFrom)!;

  const vars = await db
    .select()
    .from(envVarsTable)
    .where(eq(envVarsTable.appId, web.id));
  const site = vars.find((v) => v.key === "NEXT_PUBLIC_SITE")!;
  assert.equal(decryptSecret(site.valueEnc), "https://blink.acme.test");
  const old = vars.find((v) => v.key === "OLD_ADDRESS")!;
  assert.equal(decryptSecret(old.valueEnc), `https://${rehosted.name}/health`);
  const withCred = vars.find((v) => v.key === "OLD_ADDRESS_URL")!;
  assert.equal(withCred.type, "plain");
  assert.equal(
    decryptSecret(withCred.valueEnc),
    `https://hooker:pw@${rehosted.name}/hook`,
  );
  const run = await asOwner(() => getMigrationRun(runId));
  const said = run!.items
    .filter((i) => i.sourceId === "dok-app-web")
    .map((i) => i.message ?? "")
    .join(" | ");
  assert.match(said, /OLD_ADDRESS, OLD_ADDRESS_URL named the old address/);
});

test("a re-hosted address is one line, not two", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const said = (await asOwner(() => getMigrationRun(runId)))!.items
    .filter((i) => i.sourceId === "dok-app-web")
    .map((i) => i.message ?? "");

  const addressLines = said.filter((m) => /same port, same route/.test(m));
  assert.equal(addressLines.length, 1);
  assert.match(addressLines[0], /open its Console/);
  assert.equal(said.filter((m) => /open its Console/.test(m)).length, 1);
});

test("an app never arrives with fewer addresses than it had", async () => {
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

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  const apps = await db.select().from(appsTable);
  const web = apps.find((a) => a.name === "blink-web")!;
  const doms = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));

  assert.equal(doms.length, 2, "two addresses over there, two here");
  for (const d of doms) assert.match(d.name, /\.deplo\.site$/);
  assert.deepEqual(doms.map((d) => d.importedFrom).sort(), [
    "blink-web-abc.traefik.me",
    "blink.acme.test",
  ]);
  for (const d of doms) assert.equal(d.port, 3000);
});

test("the primary domain is the real hostname, not Dokploy's throwaway one", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const apps = await db.select().from(appsTable);
  const web = apps.find((a) => a.name === "blink-web")!;
  const doms = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));
  const primary = doms.find((d) => d.isPrimary)!;
  assert.equal(primary.name, "blink.acme.test");
  assert.equal(primary.certProvider, "letsencrypt");
  assert.equal(
    doms.some((d) => d.name.endsWith(".traefik.me")),
    false,
  );

  assert.equal(doms.length, 2);
  const rehosted = doms.find((d) => !d.isPrimary)!;
  assert.equal(rehosted.importedFrom, "blink-web-abc.traefik.me");
  assert.match(rehosted.name, /\.deplo\.site$/);
  assert.equal(rehosted.port, 3000);
  assert.equal(rehosted.status, "valid");
  assert.equal(rehosted.certProvider, "none");
  const report = await asOwner(() => getMigrationRun(runId));
  assert.match(
    report!.items.map((i) => i.message ?? "").join(" "),
    /blink-web-abc\.traefik\.me was Dokploy's own temporary address/,
  );
});

test("on a takeover the throwaway address stays, because it names this machine", async () => {
  const { servers: serversTable } =
    await import("../../db/schema/control-plane/servers");
  const { eq } = await import("drizzle-orm");
  await db
    .update(serversTable)
    .set({ ip: "dokploy.acme.test", host: "dokploy.acme.test" })
    .where(eq(serversTable.id, SERVER_1));

  const plan = await asOwner(() => scanMigrationSource(CONNECT));
  const line = plan.projects
    .flatMap((p) => p.environments)
    .flatMap((e) => e.services)
    .find((s) => s.name === "blink-web")!;
  assert.match(line.notes.join(" "), /stays when the app lands here/);

  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");

  const apps = await db.select().from(appsTable);
  const web = apps.find((a) => a.name === "blink-web")!;
  const doms = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));
  assert.ok(
    doms.some((d) => d.name === "blink-web-abc.traefik.me"),
    doms.map((d) => d.name).join(", "),
  );
  assert.equal(
    doms.some((d) => d.name.endsWith(".deplo.site")),
    false,
  );
  const report = await asOwner(() => getMigrationRun(runId));
  assert.doesNotMatch(
    report!.items.map((i) => i.message ?? "").join(" "),
    /temporary address/,
  );
});

test("dismissing the notice clears it for that app only", async () => {
  const runId = await asOwner(() => beginMigration({ url: URL_BASE }));
  await importProject(runId, "dok-prj-blink");
  await asOwner(() => finishMigration(runId));
  const apps = await db.select().from(appsTable);
  const web = apps.find((a) => a.name === "blink-web")!;

  const before = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));
  assert.equal(before.filter((d) => d.importedFrom).length, 1);

  await asOwner(() => dismissImportedDomains(web.id));
  const after = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, web.id));
  assert.equal(after.filter((d) => d.importedFrom).length, 0);
  assert.deepEqual(
    after.map((d) => d.name).sort(),
    before.map((d) => d.name).sort(),
  );
});
