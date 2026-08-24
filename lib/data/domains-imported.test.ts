import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { domains as domainsTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  addImportedDomains,
  dismissImportedDomains,
  type ImportedRoute,
} from "./domains";

/**
 * Re-hosting the addresses an import could not keep.
 *
 * The failure this exists to prevent is arithmetic: an app that answered on two
 * addresses over there must not arrive answering on none. Its old names cannot
 * come across - a throwaway host carries the SOURCE server's IP - so each route
 * is put on an address Deplo mints, and the row remembers what it replaced.
 *
 * Two rules carry the weight and are pinned here: one new address per SOURCE
 * host (not per row, or an address with two paths would silently become two
 * addresses), and a `seed` so a row that shares its source host with the app's
 * primary joins THAT address instead of minting a second one.
 */

let db: TestDb;
let pg: PGlite;

const IP = "10.0.0.1"; // seedServer's ip — what a nip.io host encodes

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
  await seedApp(db, { id: "prj_web", slug: "web" });
});

const route = (over: Partial<ImportedRoute> = {}): ImportedRoute => ({
  sourceHost: "web-abc.sslip.io",
  port: 3000,
  pathPrefix: "",
  stripPrefix: false,
  certProvider: "none",
  entrypoint: "web",
  service: null,
  ...over,
});

const rows = () =>
  db.select().from(domainsTable).where(eq(domainsTable.appId, "prj_web"));

test("each source host is re-hosted once, keeping its whole route", async () => {
  const landed = await addImportedDomains(
    "prj_web",
    [
      route({ sourceHost: "web-abc.sslip.io", port: 3000, service: "web" }),
      route({
        sourceHost: "api-abc.sslip.io",
        port: 8080,
        service: "api",
        pathPrefix: "/api",
        stripPrefix: true,
        certProvider: "letsencrypt",
        entrypoint: "websecure",
      }),
    ],
    { slug: "web", ip: IP },
  );

  assert.equal(landed.size, 2, "two source addresses, two new ones");
  const all = await rows();
  assert.equal(all.length, 2);
  for (const d of all) {
    assert.match(d.name, /\.nip\.io$/, "Deplo mints its own temporary address");
    assert.equal(
      d.status,
      "valid",
      "a nip.io host resolves here by construction",
    );
    assert.equal(d.isPrimary, false);
  }
  // The label carries the service, so which is which is readable in the list.
  const api = all.find((d) => d.importedFrom === "api-abc.sslip.io")!;
  assert.match(api.name, /^web-api-/);
  assert.equal(api.port, 8080);
  assert.equal(api.service, "api");
  assert.equal(api.pathPrefix, "/api");
  assert.equal(api.stripPrefix, true);
  assert.equal(api.certProvider, "letsencrypt");
  assert.equal(api.ssl, true);
});

// Two Dokploy rows on ONE host with different paths were one address with two
// routes. Minting an address per row would hand back a shape the app never had.
test("two routes on the same source host share one new address", async () => {
  await addImportedDomains(
    "prj_web",
    [
      route({ sourceHost: "web-abc.sslip.io", pathPrefix: "", port: 3000 }),
      route({ sourceHost: "web-abc.sslip.io", pathPrefix: "/api", port: 8080 }),
    ],
    { slug: "web", ip: IP },
  );
  const all = await rows();
  assert.equal(all.length, 2);
  assert.equal(
    new Set(all.map((d) => d.name)).size,
    1,
    "one hostname, two rows",
  );
  assert.deepEqual(all.map((d) => d.pathPrefix ?? "").sort(), ["", "/api"]);
});

// The app's primary is minted by createApp before the import can speak, so the
// first source host lands there. A later row on that same host must join it.
test("a row whose source host already landed joins that address", async () => {
  const seed = new Map([["web-abc.sslip.io", "web-existing-0a000001.nip.io"]]);
  await db.insert(domainsTable).values({
    id: "dom_primary",
    appId: "prj_web",
    name: "web-existing-0a000001.nip.io",
    status: "valid",
    isPrimary: true,
    redirectTo: null,
    ssl: false,
    source: "auto",
    port: 3000,
    entrypoint: "web",
    certProvider: "none",
    pathPrefix: null,
    stripPrefix: null,
    service: null,
    importedFrom: "web-abc.sslip.io",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  await addImportedDomains(
    "prj_web",
    [route({ sourceHost: "web-abc.sslip.io", pathPrefix: "/api", port: 8080 })],
    { slug: "web", ip: IP, seed },
  );
  const all = await rows();
  assert.equal(all.length, 2);
  assert.equal(
    new Set(all.map((d) => d.name)).size,
    1,
    "no second address minted",
  );
});

// Re-running an interrupted import must not stack duplicates.
test("re-running writes nothing the second time", async () => {
  const routes = [route({ sourceHost: "web-abc.sslip.io" })];
  const first = await addImportedDomains("prj_web", routes, {
    slug: "web",
    ip: IP,
  });
  const seed = new Map(first);
  await addImportedDomains("prj_web", routes, { slug: "web", ip: IP, seed });
  assert.equal((await rows()).length, 1);
});

test("dismissing clears the provenance and keeps the addresses", async () => {
  await addImportedDomains("prj_web", [route()], { slug: "web", ip: IP });
  const before = await rows();
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    dismissImportedDomains("prj_web"),
  );
  const after = await rows();
  assert.deepEqual(
    after.map((d) => d.importedFrom),
    [null],
  );
  assert.deepEqual(
    after.map((d) => d.name),
    before.map((d) => d.name),
  );
});
