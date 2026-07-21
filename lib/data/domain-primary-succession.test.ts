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
import {
  apps as appsTable,
  domains as domainsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  addDomain,
  removeDomain,
  setPrimaryDomain,
  updateDomain,
  successorPrimary,
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains";
import type { Domain } from "../types";

/**
 * What happens to an app's CANONICAL host when its primary domain is deleted.
 *
 * The primary is what the app card's subtitle, the title-bar link and the first
 * deploy route all read (through `apps.production_url`). Deleting it used to
 * leave the app both primary-less AND still advertising the deleted hostname
 * forever — nothing outside a deploy ever rewrote the URL, and an app whose
 * domain is gone may never deploy again. So: the crown passes to the closest
 * remaining domain, the URL follows it, and it is cleared when the last domain
 * goes.
 */

const SERVER_IP = "10.0.0.1"; // seedServer's ip
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
  await seedIdentity(db, { users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }] });
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

/** The URL as the app card / title bar reads it. */
async function url(): Promise<string | null> {
  const [row] = await db
    .select({ u: appsTable.productionUrl })
    .from(appsTable)
    .where(eq(appsTable.id, "prj_1"));
  return row?.u ?? null;
}

/** Seeding writes rows directly, so start each test from the URL a consistent
 * app would already have (the app row itself is seeded with a null URL). */
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

/* ------------------------------------------------------------------ */
/* The heir: same service, then same port                              */
/* ------------------------------------------------------------------ */

test("deleting the primary hands the crown to the same service, not the oldest sibling", async () => {
  await seedDomains([
    { id: "d_api", name: "api.example.com", service: "api", port: 4000, createdAt: T(1) },
    { id: "d_www", name: "www.example.com", service: "web", port: 3000, createdAt: T(3) },
    { id: "d_pri", name: "example.com", service: "web", port: 3000, primary: true, createdAt: T(2) },
  ]);

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await primaryName(), "www.example.com");
  assert.equal(await url(), "http://www.example.com");
});

test("with no service (single-image app), the same PORT wins", async () => {
  await seedDomains([
    { id: "d_admin", name: "admin.example.com", port: 9000, createdAt: T(1) },
    { id: "d_alt", name: "alt.example.com", port: 3000, createdAt: T(3) },
    { id: "d_pri", name: "example.com", port: 3000, primary: true, createdAt: T(2) },
  ]);

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await primaryName(), "alt.example.com");
});

test("all else equal, a routable host outranks a misconfigured one, then oldest wins", async () => {
  await seedDomains([
    { id: "d_broken", name: "broken.example.com", port: 3000, status: "misconfigured", createdAt: T(1) },
    { id: "d_ok", name: "ok.example.com", port: 3000, status: "valid", createdAt: T(3) },
    { id: "d_ok2", name: "also.example.com", port: 3000, status: "valid", createdAt: T(4) },
    { id: "d_pri", name: "example.com", port: 3000, primary: true, createdAt: T(2) },
  ]);

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await primaryName(), "ok.example.com");
});

test("a misconfigured host still beats no primary at all", async () => {
  await seedDomains([
    { id: "d_broken", name: "broken.example.com", status: "misconfigured", createdAt: T(1) },
    { id: "d_pri", name: "example.com", primary: true, createdAt: T(2) },
  ]);

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await primaryName(), "broken.example.com");
  assert.equal(await url(), "http://broken.example.com");
});

/* ------------------------------------------------------------------ */
/* The URL itself                                                      */
/* ------------------------------------------------------------------ */

test("deleting the LAST domain clears the URL — the card reads 'No domain yet'", async () => {
  await seedDomains([{ id: "d_pri", name: "example.com", primary: true }]);
  assert.equal(await url(), "http://example.com");

  await asUser1(() => removeDomain("d_pri"));

  assert.equal(await url(), null);
  assert.equal(await primaryName(), null);
});

test("the heir's certificate provider decides the scheme", async () => {
  await seedDomains([
    { id: "d_tls", name: "secure.example.com", certProvider: "letsencrypt", createdAt: T(3) },
    { id: "d_pri", name: "example.com", primary: true, certProvider: "none", createdAt: T(2) },
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
  // The first domain of an app IS its canonical URL.
  const first = await asUser1(() => addDomain("prj_1", "first.example.com", {}));
  assert.equal(await url(), "http://first.example.com");

  // A second one doesn't steal the crown...
  const second = await asUser1(() => addDomain("prj_1", "second.example.com", {}));
  assert.equal(await url(), "http://first.example.com");

  // ...until it is made primary.
  await asUser1(() => setPrimaryDomain(second.id));
  assert.equal(await url(), "http://second.example.com");

  // A rename of the primary moves the URL with it.
  await asUser1(() => updateDomain(second.id, { name: "renamed.example.com" }));
  assert.equal(await url(), "http://renamed.example.com");

  // Putting a certificate on it flips the scheme.
  await asUser1(() => updateDomain(second.id, { certProvider: "letsencrypt" }));
  assert.equal(await url(), "https://renamed.example.com");

  assert.equal(first.primary, true, "the first domain was born primary");
});

/* ------------------------------------------------------------------ */
/* The pure ranking                                                    */
/* ------------------------------------------------------------------ */

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

  // A domain with no service/port matches a removed one that had none either.
  const bare = d({ name: "bare.example.com" });
  assert.equal(
    successorPrimary([d({ name: "other.example.com", port: 8080 }), bare], {
      service: null,
      port: null,
    })?.name,
    "bare.example.com",
  );

  // Equal rank ⇒ oldest, then name — never "whatever the table returned".
  const a = d({ name: "a.example.com", createdAt: T(2) });
  const b = d({ name: "b.example.com", createdAt: T(1) });
  assert.equal(successorPrimary([a, b], { service: null, port: null })?.name, "b.example.com");
  assert.equal(successorPrimary([b, a], { service: null, port: null })?.name, "b.example.com");
});
