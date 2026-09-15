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
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { addDomain, removeDomain, updateDomain } from "./domains/crud";
import {
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains/dns-check";
import { setPrimaryDomain, successorPrimary } from "./domains/primary-domain";
import type { Domain } from "../types/domain";

const SERVER_IP = "10.0.0.1";
const T = (n: number) => `2026-01-0${n}T00:00:00.000Z`;

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  __resetDnsResolve4ForTest();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
  await seedApp(db, { id: "prj_1", status: "active" });
  __setDnsResolve4ForTest(async () => [SERVER_IP]);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

interface SeedDomain {
  id: string;
  name: string;
  primary?: boolean;
  port?: number | null;
  service?: string | null;
  status?: Domain["status"];
  certProvider?: Domain["certProvider"];
  createdAt?: string;
}

async function seedDomains(rows: SeedDomain[]): Promise<void> {
  await db.insert(domainsTable).values(
    rows.map((r) => ({
      id: r.id,
      appId: "prj_1",
      name: r.name,
      status: r.status ?? "valid",
      isPrimary: r.primary ?? false,
      ssl: true,
      source: "custom" as const,
      port: r.port ?? null,
      service: r.service ?? null,
      certProvider: r.certProvider ?? ("none" as const),
      createdAt: r.createdAt ?? T(1),
    })),
  );
  await syncUrlDirect();
}

async function url(): Promise<string | null> {
  const [row] = await db
    .select({ u: appsTable.productionUrl })
    .from(appsTable)
    .where(eq(appsTable.id, "prj_1"));
  return row?.u ?? null;
}

async function syncUrlDirect(): Promise<void> {
  const rows = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, "prj_1"));
  const p = rows.find((r) => r.isPrimary) ?? rows[0];
  await db
    .update(appsTable)
    .set({
      productionUrl: p
        ? `${p.certProvider === "none" ? "http" : "https"}://${p.name}`
        : null,
    })
    .where(eq(appsTable.id, "prj_1"));
}

async function primaryName(): Promise<string | null> {
  const rows = await db
    .select()
    .from(domainsTable)
    .where(eq(domainsTable.appId, "prj_1"));
  return rows.find((r) => r.isPrimary)?.name ?? null;
}

test("deleting the primary hands the crown to the same service, not the oldest sibling", async () => {
  await seedDomains([
    {
      id: "d_api",
      name: "api.example.com",
      service: "api",
      port: 4000,
      createdAt: T(1),
    },
    {
      id: "d_www",
      name: "www.example.com",
      service: "web",
      port: 3000,
      createdAt: T(3),
    },
    {
      id: "d_pri",
      name: "example.com",
      service: "web",
      port: 3000,
      primary: true,
      createdAt: T(2),
    },
  ]);

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await primaryName(), "www.example.com");
  assert.equal(await url(), "http://www.example.com");
});

test("with no service (single-image app), the same PORT wins", async () => {
  await seedDomains([
    { id: "d_admin", name: "admin.example.com", port: 9000, createdAt: T(1) },
    { id: "d_alt", name: "alt.example.com", port: 3000, createdAt: T(3) },
    {
      id: "d_pri",
      name: "example.com",
      port: 3000,
      primary: true,
      createdAt: T(2),
    },
  ]);

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await primaryName(), "alt.example.com");
});

test("all else equal, a routable host outranks a misconfigured one, then oldest wins", async () => {
  await seedDomains([
    {
      id: "d_broken",
      name: "broken.example.com",
      port: 3000,
      status: "misconfigured",
      createdAt: T(1),
    },
    {
      id: "d_ok",
      name: "ok.example.com",
      port: 3000,
      status: "valid",
      createdAt: T(3),
    },
    {
      id: "d_ok2",
      name: "also.example.com",
      port: 3000,
      status: "valid",
      createdAt: T(4),
    },
    {
      id: "d_pri",
      name: "example.com",
      port: 3000,
      primary: true,
      createdAt: T(2),
    },
  ]);

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await primaryName(), "ok.example.com");
});

test("a misconfigured host still beats no primary at all", async () => {
  await seedDomains([
    {
      id: "d_broken",
      name: "broken.example.com",
      status: "misconfigured",
      createdAt: T(1),
    },
    { id: "d_pri", name: "example.com", primary: true, createdAt: T(2) },
  ]);

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await primaryName(), "broken.example.com");
  assert.equal(await url(), "http://broken.example.com");
});

test("deleting the LAST domain clears the URL - the card reads 'No domain yet'", async () => {
  await seedDomains([{ id: "d_pri", name: "example.com", primary: true }]);
  assert.equal(await url(), "http://example.com");

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await url(), null);
  assert.equal(await primaryName(), null);
});

test("the heir's certificate provider decides the scheme", async () => {
  await seedDomains([
    {
      id: "d_tls",
      name: "secure.example.com",
      certProvider: "letsencrypt",
      createdAt: T(3),
    },
    {
      id: "d_pri",
      name: "example.com",
      primary: true,
      certProvider: "none",
      createdAt: T(2),
    },
  ]);

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await url(), "https://secure.example.com");
});

test("deleting a NON-primary domain leaves the primary and the URL alone", async () => {
  await seedDomains([
    { id: "d_pri", name: "example.com", primary: true, createdAt: T(1) },
    { id: "d_extra", name: "extra.example.com", createdAt: T(2) },
  ]);

  await asUser1(() => removeDomain("d_extra"));

  assert.equal(await primaryName(), "example.com");
  assert.equal(await url(), "http://example.com");
});

test("the URL follows every other domain change too (add, rename, set-primary)", async () => {
  const first = await asUser1(() =>
    addDomain("prj_1", "first.example.com", {}),
  );
  assert.equal(await url(), "http://first.example.com");

  const second = await asUser1(() =>
    addDomain("prj_1", "second.example.com", {}),
  );
  assert.equal(await url(), "http://first.example.com");

  await asUser1(() => setPrimaryDomain(second.id));
  assert.equal(await url(), "http://second.example.com");

  await asUser1(() => updateDomain(second.id, { name: "renamed.example.com" }));
  assert.equal(await url(), "http://renamed.example.com");

  await asUser1(() => updateDomain(second.id, { certProvider: "letsencrypt" }));
  assert.equal(await url(), "https://renamed.example.com");

  assert.equal(first.primary, true, "the first domain was born primary");
});

test("successorPrimary is pure, deterministic and null-safe", () => {
  const d = (over: Partial<Domain>): Domain =>
    ({
      id: over.name ?? "x",
      appId: "prj_1",
      name: "x.example.com",
      status: "valid",
      primary: false,
      redirectTo: null,
      ssl: true,
      source: "custom",
      createdAt: T(1),
      ...over,
    }) as Domain;

  assert.equal(successorPrimary([], { service: "web", port: 80 }), null);

  const bare = d({ name: "bare.example.com" });
  assert.equal(
    successorPrimary([d({ name: "other.example.com", port: 8080 }), bare], {
      service: null,
      port: null,
    })?.name,
    "bare.example.com",
  );

  const a = d({ name: "a.example.com", createdAt: T(2) });
  const b = d({ name: "b.example.com", createdAt: T(1) });
  assert.equal(
    successorPrimary([a, b], { service: null, port: null })?.name,
    "b.example.com",
  );
  assert.equal(
    successorPrimary([b, a], { service: null, port: null })?.name,
    "b.example.com",
  );
});

test("changing the build port moves the domains that were routing to the old one", async () => {
  const { updateAppBuild } = await import("./apps/build-settings");
  await seedDomains([
    { id: "d_follows", name: "follows.example.com", primary: true, port: 3000 },
    { id: "d_pinned", name: "pinned.example.com", port: 8080 },
  ]);

  await asUser1(() => updateAppBuild("prj_1", { port: 80 }));

  const rows = await db
    .select({ id: domainsTable.id, port: domainsTable.port })
    .from(domainsTable)
    .where(eq(domainsTable.appId, "prj_1"));
  const portOf = (id: string) => rows.find((r) => r.id === id)?.port;
  assert.equal(portOf("d_follows"), 80, "it was following the build port");
  assert.equal(
    portOf("d_pinned"),
    8080,
    "a hostname pointed somewhere on purpose is left alone",
  );
});
