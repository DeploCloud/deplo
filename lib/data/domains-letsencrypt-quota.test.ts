import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { LETSENCRYPT_DOMAINS_PER_TEAM_CAP } from "../deploy/domains";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { ensureAutoDomain, ensureExtraDomain } from "./domains/auto-domains";
import { addDomain, updateDomain } from "./domains/crud";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains/dns-check";
import {
  addImportedDomains,
  applyImportedRoute,
  type ImportedRoute,
} from "./domains/imported-routes";

const IP = "10.0.0.1";

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setDnsResolve4ForTest(async () => [IP]);
});

after(async () => {
  __resetDnsResolve4ForTest();
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
  await seedApp(db, { id: "prj_full", slug: "full" });
  await seedApp(db, { id: "prj_new", slug: "new" });
  await db.insert(domainsTable).values(
    Array.from({ length: LETSENCRYPT_DOMAINS_PER_TEAM_CAP }, (_, i) => ({
      id: `dom_le${i}`,
      appId: "prj_full",
      name: `le-${i}.example.com`,
      status: "valid",
      isPrimary: false,
      ssl: true,
      certProvider: "letsencrypt",
      createdAt: "2026-01-01T00:00:00.000Z",
    })),
  );
});

const asUser1 = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const providerOf = async (appId: string) =>
  (
    await db
      .select({ cert: domainsTable.certProvider, ssl: domainsTable.ssl })
      .from(domainsTable)
      .where(eq(domainsTable.appId, appId))
  ).map((r) => `${r.cert}:${r.ssl}`);

const route = (over: Partial<ImportedRoute> = {}): ImportedRoute => ({
  sourceHost: "web-abc.sslip.io",
  port: 3000,
  pathPrefix: "",
  stripPrefix: false,
  certProvider: "letsencrypt",
  entrypoint: "websecure",
  service: null,
  ...over,
});

test("switching a domain to Let's Encrypt at the cap is refused like adding one", async () => {
  const plain = await asUser1(() =>
    addDomain("prj_new", "plain.example.com", { certProvider: "none" }),
  );
  await assert.rejects(
    asUser1(() => updateDomain(plain.id, { certProvider: "letsencrypt" })),
    /limit of 50 Let's Encrypt domains/,
  );
  await asUser1(() =>
    updateDomain("dom_le0", { port: 8080, certProvider: "letsencrypt" }),
  );
});

test("a template's domains at the cap land with no certificate", async () => {
  await asUser1(async () => {
    await ensureAutoDomain("prj_new", {
      slug: "new",
      ip: IP,
      defaultPort: 3000,
      certProvider: "letsencrypt",
    });
    await ensureExtraDomain("prj_new", "", {
      port: 3000,
      slug: "new",
      ip: IP,
      certProvider: "letsencrypt",
    });
  });
  assert.deepEqual(await providerOf("prj_new"), ["none:false", "none:false"]);
});

test("an import at the cap brings its domains across with no certificate", async () => {
  const notes: string[] = [];
  await addImportedDomains("prj_new", [route()], {
    slug: "new",
    ip: IP,
    notes,
  });
  assert.deepEqual(await providerOf("prj_new"), ["none:false"]);
  assert.match(notes.join(" "), /no certificate/);

  const [row] = await db
    .select({ id: domainsTable.id })
    .from(domainsTable)
    .where(eq(domainsTable.appId, "prj_new"));
  await applyImportedRoute(
    "prj_new",
    row!.id,
    route({ sourceHost: "b.sslip.io" }),
    notes,
  );
  assert.deepEqual(await providerOf("prj_new"), ["none:false"]);
  assert.equal(notes.length, 2);
});
