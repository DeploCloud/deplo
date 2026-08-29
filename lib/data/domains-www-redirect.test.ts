import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane";
import { eq } from "drizzle-orm";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  addDomain,
  updateDomain,
  removeDomain,
  setPrimaryDomain,
  listDomains,
  routableRoutes,
  __setDnsResolve4ForTest,
  __resetDnsResolve4ForTest,
} from "./domains";

/**
 * The `www` ⇄ non-`www` pairing: one hostname serves the app, the other answers a
 * permanent 301 to it. The resolver is stubbed ({@link __setDnsResolve4ForTest});
 * the seeded server's IP is 10.0.0.1, so that is the "points here" answer.
 */

const SERVER_IP = "10.0.0.1";

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
  // Every hostname in these tests already points at the server, so the pairing
  // is what is under test rather than DNS propagation.
  __setDnsResolve4ForTest(async () => [SERVER_IP]);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const byName = async (name: string) =>
  (await asUser1(() => listDomains("prj_1"))).find((d) => d.name === name);

const productionUrl = async (): Promise<string | null> =>
  (
    await db
      .select({ url: appsTable.productionUrl })
      .from(appsTable)
      .where(eq(appsTable.id, "prj_1"))
  )[0].url;

/* ------------------------------------------------------------------ */
/* Creating the pair                                                    */
/* ------------------------------------------------------------------ */

test("adding a domain with www:toThis registers the counterpart as a redirect", async () => {
  await asUser1(() =>
    addDomain("prj_1", "example.com", {
      port: 3000,
      certProvider: "letsencrypt",
      www: "toThis",
    }),
  );
  const www = await byName("www.example.com");
  assert.ok(www, "the counterpart is added as a domain of the app");
  assert.equal(www.redirectTo, "example.com");
  assert.equal(
    www.primary,
    false,
    "a redirecting host is never the canonical one",
  );
  // Provenance: only a companion Deplo generated may be deleted when the pair is
  // broken, so it is marked as one.
  assert.equal(www.source, "redirect");
  // The 301 answers on https://www, which needs a certificate THERE, or the
  // browser hits a certificate error before it is ever told where to go.
  assert.equal(www.certProvider, "letsencrypt");
  assert.equal(www.port, 3000, "same container port as the host it points at");
  assert.equal(www.status, "valid", "its own DNS is checked at write time");
});

test("the app's URL carries the path its primary answers on", async () => {
  // A stack whose UI lives under `/app` (a template may declare it): the bare
  // host answers nothing, so the canonical URL must not stop at the hostname.
  await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000, pathPrefix: "/app" }),
  );
  assert.equal(await productionUrl(), "http://example.com/app");
});

test("the pair is derived, so re-saving the same config writes nothing new", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000, www: "toThis" }),
  );
  await asUser1(() => updateDomain(d.id, { www: "toThis" }));
  const all = await asUser1(() => listDomains("prj_1"));
  assert.equal(all.length, 2, "no duplicate companion");
});

test("pairing an app's only domain leaves the canonical host primary", async () => {
  await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000, www: "toThis" }),
  );
  assert.equal((await byName("example.com"))!.primary, true);
  assert.equal(await productionUrl(), "http://example.com");
});

/* ------------------------------------------------------------------ */
/* Flipping which half serves                                           */
/* ------------------------------------------------------------------ */

test("www:toCounterpart makes www serve and moves primary (and the URL) with it", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", {
      port: 3000,
      certProvider: "letsencrypt",
    }),
  );
  await asUser1(() => updateDomain(d.id, { www: "toCounterpart" }));

  const apex = await byName("example.com");
  const www = await byName("www.example.com");
  assert.equal(apex!.redirectTo, "www.example.com", "the apex now redirects");
  assert.equal(www!.redirectTo, null, "the www host serves the app");
  // The canonical host is the one that serves - the badge, and the app's
  // production URL, follow it rather than advertising a hostname that 301s.
  assert.equal(www!.primary, true);
  assert.equal(apex!.primary, false);
  assert.equal(await productionUrl(), "https://www.example.com");
});

test("flipping a pair back turns the redirect around without losing a hostname", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000, www: "toThis" }),
  );
  await asUser1(() => updateDomain(d.id, { www: "toCounterpart" }));
  assert.equal((await byName("example.com"))!.redirectTo, "www.example.com");
  assert.equal((await byName("www.example.com"))!.redirectTo, null);

  await asUser1(() => updateDomain(d.id, { www: "toThis" }));
  assert.equal((await byName("example.com"))!.redirectTo, null);
  assert.equal((await byName("www.example.com"))!.redirectTo, "example.com");
  assert.equal((await asUser1(() => listDomains("prj_1"))).length, 2);
  // Primary rides along in BOTH directions - the canonical host is whichever
  // half serves, never the one answering 301.
  assert.equal((await byName("example.com"))!.primary, true);
  assert.equal(await productionUrl(), "http://example.com");
});

test("pairing leaves an unrelated primary domain alone", async () => {
  // Two hostnames on one app, the FIRST being its primary. Pairing the second
  // with its www variant says nothing about the first, so the badge stays put.
  await asUser1(() => addDomain("prj_1", "first.example.io", { port: 3000 }));
  const second = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000 }),
  );
  await asUser1(() => updateDomain(second.id, { www: "toCounterpart" }));
  assert.equal((await byName("first.example.io"))!.primary, true);
  assert.equal((await byName("www.example.com"))!.primary, false);
});

/* ------------------------------------------------------------------ */
/* Breaking the pair                                                    */
/* ------------------------------------------------------------------ */

test("www:none removes a companion Deplo generated", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000, www: "toThis" }),
  );
  await asUser1(() => updateDomain(d.id, { www: "none" }));
  assert.equal(await byName("www.example.com"), undefined);
  assert.equal((await asUser1(() => listDomains("prj_1"))).length, 1);
});

test("www:none only UN-redirects a hostname the user added themselves", async () => {
  const apex = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000 }),
  );
  // The user adds the www hostname as an ordinary domain of the app first.
  await asUser1(() => addDomain("prj_1", "www.example.com", { port: 3000 }));
  await asUser1(() => updateDomain(apex.id, { www: "toThis" }));
  assert.equal((await byName("www.example.com"))!.redirectTo, "example.com");

  await asUser1(() => updateDomain(apex.id, { www: "none" }));
  const www = await byName("www.example.com");
  assert.ok(www, "a domain somebody typed is never deleted by a dropdown");
  assert.equal(www.redirectTo, null, "it goes back to serving the app");
});

test("removing the canonical host takes its generated companion with it", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000, www: "toThis" }),
  );
  await asUser1(() => removeDomain(d.id));
  assert.deepEqual(await asUser1(() => listDomains("prj_1")), []);
  assert.equal(await productionUrl(), null);
});

test("removing the canonical host frees a user's own hostname instead of deleting it", async () => {
  const apex = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000 }),
  );
  await asUser1(() => addDomain("prj_1", "www.example.com", { port: 3000 }));
  await asUser1(() => updateDomain(apex.id, { www: "toThis" }));
  await asUser1(() => removeDomain(apex.id));

  const www = await byName("www.example.com");
  assert.ok(www);
  assert.equal(
    www.redirectTo,
    null,
    "it stops pointing at a hostname that is gone",
  );
  assert.equal(www.primary, true, "and inherits the canonical role");
  assert.equal(await productionUrl(), "http://www.example.com");
});

/* ------------------------------------------------------------------ */
/* Guard rails                                                          */
/* ------------------------------------------------------------------ */

test("a redirecting hostname can't be made primary", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000, www: "toThis" }),
  );
  const www = await byName("www.example.com");
  await assert.rejects(
    () => asUser1(() => setPrimaryDomain(www!.id)),
    /redirects to example\.com/,
  );
  assert.equal((await byName("example.com"))!.primary, true);
  assert.ok(d.id);
});

test("a hostname with no www variant refuses the pairing", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "api.internal.example.com", { port: 3000 }),
  );
  await assert.rejects(
    () => asUser1(() => updateDomain(d.id, { www: "toThis" })),
    /no www variant/,
  );
});

test("a path-routed domain refuses the pairing (a 301 answers for a whole host)", async () => {
  await asUser1(() => addDomain("prj_1", "example.com", { port: 3000 }));
  const api = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 8080, pathPrefix: "/api" }),
  );
  await assert.rejects(
    () => asUser1(() => updateDomain(api.id, { www: "toThis" })),
    /path/,
  );
});

test("a hostname another app already routes is refused, not stolen", async () => {
  await seedApp(db, { id: "prj_2", slug: "other", status: "active" });
  await asUser1(() => addDomain("prj_2", "www.example.com", { port: 3000 }));
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000 }),
  );
  await assert.rejects(
    () => asUser1(() => updateDomain(d.id, { www: "toThis" })),
    /already routed by another app/,
  );
});

/* ------------------------------------------------------------------ */
/* What the deploy actually renders                                     */
/* ------------------------------------------------------------------ */

test("the redirect route carries the CANONICAL host's scheme, not its own", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", {
      port: 3000,
      certProvider: "letsencrypt",
      www: "toThis",
    }),
  );
  const routes = await routableRoutes("prj_1");
  const www = routes.find((r) => r.name === "www.example.com");
  assert.ok(www, "the www host is routed (its DNS points here)");
  assert.equal(www.redirectTo, "https://example.com");
  assert.equal(
    routes.find((r) => r.name === "example.com")!.redirectTo,
    "",
    "the canonical host serves the app",
  );
  // Moving the canonical host off TLS moves the redirect target with it: a 301
  // to a scheme nobody serves is worse than none.
  await asUser1(() => updateDomain(d.id, { certProvider: "none" }));
  const after = await routableRoutes("prj_1");
  assert.equal(
    after.find((r) => r.name === "www.example.com")!.redirectTo,
    "http://example.com",
  );
});

test("renaming the canonical host carries the pair with it", async () => {
  const d = await asUser1(() =>
    addDomain("prj_1", "example.com", { port: 3000, www: "toThis" }),
  );
  await asUser1(() => updateDomain(d.id, { name: "example.org" }));
  const all = await asUser1(() => listDomains("prj_1"));
  assert.equal(all.length, 2);
  const www = all.find((x) => x.redirectTo);
  assert.equal(
    www!.name,
    "www.example.org",
    "the generated companion follows the hostname it exists for",
  );
  assert.equal(www!.redirectTo, "example.org");
});
